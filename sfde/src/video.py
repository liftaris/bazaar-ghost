"""Decode sampled video frames without separating pixels from their timestamps."""

import io
import logging
import math
import queue
import re
import threading
import time
from fractions import Fraction
from typing import BinaryIO, Iterator, Tuple


PTS_PATTERN = re.compile(r'\bpts_time:([-+\d.eE]+)\s')
MEDIA_URL_PATTERN = re.compile(r'https?://[^\s\'"<>]+', re.I)
FAILURE_DIAGNOSTIC = re.compile(r'error|invalid|corrupt|prematurely', re.I)
CONTEXT_ADDRESS = re.compile(r' @ 0x[0-9a-f]+\]')
NAMED_FILTER = re.compile(r'^\[showinfo@(bg_source|bg_sample)\s+@[^\]]+\]\s*(.*)$')
CONFIG_PATTERN = re.compile(r'^config in time_base:\s*(\d+)/(\d+),\s*frame_rate:\s*(\d+)/(\d+)\s*$')
FRAME_PATTERN = re.compile(r'^n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:')
MAX_DIAGNOSTIC_LINE = 16_384
MAX_PENDING_TIMESTAMPS = 32


class SourceTimeline:
    """Bounded evidence about decoded frames before the FPS filter can repeat them.

    PTS and timing metadata are rational numbers, independent of showinfo's
    rounded decimal display or the caller's requested rendition frame rate.
    The end condition supports the final requested sampling tick. It does not
    claim continuous coverage through an integer-rounded catalog duration.
    """

    def __init__(self, duration: float, sample_interval: float):
        for value in (duration, sample_interval):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError('Positive finite source duration and sample interval required')
        self.duration = Fraction(str(duration))
        self.sample_interval = Fraction(str(sample_interval))
        self.time_base = None
        self.frame_interval = None
        self.count = 0
        self.duplicate_frames = 0
        self.first_pts = None
        self.last_pts = None
        self.max_gap = Fraction(0)

    def configure(self, time_base: Fraction, frame_rate: Fraction) -> None:
        if time_base <= 0 or frame_rate <= 0:
            raise ValueError('Positive decoded source timing metadata required')
        frame_interval = 1 / frame_rate
        if self.time_base is not None and (time_base != self.time_base or frame_interval != self.frame_interval):
            raise ValueError('Decoded source timing changed during the chunk')
        self.time_base, self.frame_interval = time_base, frame_interval

    def observe(self, pts: int) -> None:
        if self.time_base is None:
            raise ValueError('Decoded source frame has no timing metadata')
        timestamp = pts * self.time_base
        tolerance = math.ceil(self.frame_interval / self.time_base) * self.time_base
        if self.last_pts is None:
            if timestamp < -self.time_base or timestamp > tolerance:
                raise RuntimeError(f'Incomplete source coverage: opening frame at {float(timestamp):.6f}s '
                                   f'is outside seek tolerance {float(tolerance):.6f}s')
            self.first_pts = pts
        else:
            gap = (pts - self.last_pts) * self.time_base
            if gap < 0:
                raise RuntimeError(f'Incomplete source coverage: timestamps do not advance '
                                   f'({float(self.last_pts * self.time_base):.6f}s to {float(timestamp):.6f}s)')
            if gap == 0:
                # Twitch transport boundaries can repeat a presentation instant.
                # This contributes no new coverage; the FPS filter selects the
                # displayed frame. Never count duplicates toward source support.
                self.duplicate_frames += 1
                return
            self.max_gap = max(self.max_gap, gap)
            if gap >= self.sample_interval:
                raise RuntimeError(f'Incomplete source coverage: gap reaches a sampling interval '
                                   f'({float(gap):.6f}s ending at {float(timestamp):.6f}s)')
        self.last_pts = pts
        self.count += 1

    def validate(self, *, duration=None) -> None:
        duration = self.duration if duration is None else Fraction(str(duration))
        if not 0 <= duration <= self.duration:
            raise ValueError('Effective source duration is outside the requested range')
        if duration == 0:
            if self.count:
                raise RuntimeError('Decoded frames contradict an empty video interval')
            return  # Only the caller's independently verified video EOF permits this.
        if not self.count or self.time_base is None or self.frame_interval is None:
            raise RuntimeError('Incomplete source coverage: decoded source timing is missing')
        last = self.last_pts * self.time_base
        last_tick = (math.ceil(duration / self.sample_interval) - 1) * self.sample_interval
        tolerance = math.ceil(self.frame_interval / self.time_base) * self.time_base
        if last + tolerance < last_tick:
            raise RuntimeError('Incomplete source coverage: final sampling tick has no source support')
        if duration - last >= self.sample_interval:
            raise RuntimeError('Incomplete source coverage: missing tail reaches a sampling interval')

    def summary(self, start_seconds: float, *, duration=None) -> dict:
        self.validate(duration=duration)
        first = self.first_pts * self.time_base if self.count else None
        last = self.last_pts * self.time_base if self.count else None
        return {
            'source_frames': self.count,
            'duplicate_source_frames': self.duplicate_frames,
            'first_source_frame_seconds': start_seconds + float(first) if first is not None else None,
            'last_source_frame_seconds': start_seconds + float(last) if last is not None else None,
            'max_source_gap_seconds': float(self.max_gap),
            'source_frame_interval_seconds': float(self.frame_interval) if self.frame_interval is not None else None,
            'source_timestamp_quantum_seconds': float(self.time_base) if self.time_base is not None else None,
            'tail_unobserved_seconds': float(max(Fraction(0), self.duration - last)) if last is not None else float(self.duration),
        }


def read_jpegs(stream: BinaryIO) -> Iterator[bytes]:
    """Split FFmpeg image2pipe output, including markers split across reads."""
    buffer = bytearray()
    while True:
        # A buffered read(size) can wait to fill the entire buffer while FFmpeg
        # waits for its bounded timestamp queue. read1 returns available bytes.
        chunk = stream.read1(65536) if isinstance(stream, io.BufferedReader) else stream.read(65536)
        if not chunk:
            if buffer:
                raise ValueError('FFmpeg ended with an incomplete JPEG')
            return
        buffer.extend(chunk)
        while True:
            end = buffer.find(b'\xff\xd9')
            if end < 0:
                break
            if not buffer.startswith(b'\xff\xd8'):
                raise ValueError('Invalid JPEG stream from FFmpeg')
            yield bytes(buffer[:end + 2])
            del buffer[:end + 2]
        if len(buffer) > 32 * 1024 * 1024:
            raise ValueError('FFmpeg frame exceeds 32 MiB')


def timestamped_frames(stdout: BinaryIO, stderr: BinaryIO, logger: logging.Logger,
                       *, source_timeline: SourceTimeline = None,
                       validate_end: bool = True, diagnostics: list = None) -> Iterator[Tuple[bytes, float]]:
    """Pair each JPEG with its showinfo PTS before any downstream queuing.

    stderr must be drained concurrently to prevent the decoder blocking on a
    full pipe. Missing timestamps fail the chunk instead of inventing VOD links.
    The first few FFmpeg failure lines, without media URLs, are appended to
    ``diagnostics`` so a failed chunk can report its cause.
    """
    timestamps = queue.Queue(maxsize=MAX_PENDING_TIMESTAMPS)
    finished, cancelled = threading.Event(), threading.Event()
    failure = []  # The stderr reader alone records the first error.

    def fail(error):
        if not failure:
            failure.append(error)

    def put(timestamp):
        while not cancelled.is_set():
            try:
                timestamps.put(timestamp, timeout=0.1)
                return
            except queue.Full:
                continue

    def parse_fraction(numerator, denominator, *, positive=True):
        values = int(numerator), int(denominator)
        if not 0 < values[1] <= 2 ** 31 - 1 or not 0 <= values[0] <= 2 ** 31 - 1 or (positive and not values[0]):
            raise ValueError('Invalid FFmpeg timing metadata')
        return Fraction(*values)

    def read_stderr() -> None:
        timing, sequence = {}, {'bg_source': 0, 'bg_sample': 0}
        try:
            while not cancelled.is_set():
                raw_line = stderr.readline(MAX_DIAGNOSTIC_LINE + 1)
                if not raw_line:
                    break
                if len(raw_line) > MAX_DIAGNOSTIC_LINE:
                    fail(ValueError('FFmpeg diagnostic line exceeds the bounded parser limit'))
                    while raw_line and not raw_line.endswith(b'\n') and not cancelled.is_set():
                        raw_line = stderr.readline(MAX_DIAGNOSTIC_LINE + 1)
                    continue
                if failure:
                    continue  # Keep draining the pipe after a parser failure.
                # FFmpeg's progress display ends with CR rather than LF and
                # can prefix the next filter record in the same readline().
                line = raw_line.decode('utf-8', errors='replace').rsplit('\r', 1)[-1].rstrip()
                try:
                    named = NAMED_FILTER.match(line)
                    if named:
                        name, body = named.groups()
                        config = CONFIG_PATTERN.match(body)
                        if config:
                            num, den, fps_num, fps_den = config.groups()
                            time_base = parse_fraction(num, den)
                            frame_rate = parse_fraction(fps_num, fps_den, positive=name == 'bg_source')
                            if name in timing and timing[name] != time_base:
                                raise ValueError('FFmpeg filter time base changed during the chunk')
                            timing[name] = time_base
                            if name == 'bg_source' and source_timeline is not None:
                                source_timeline.configure(time_base, frame_rate)
                        elif body.startswith('config in'):
                            raise ValueError('Malformed FFmpeg timing metadata')
                        elif body.startswith('n:'):
                            frame = FRAME_PATTERN.match(body)
                            if frame is None or name not in timing:
                                raise ValueError('FFmpeg frame is missing an integer timestamp or time base')
                            number, pts = map(int, frame.groups())
                            if number != sequence[name] or not -(2 ** 63) <= pts < 2 ** 63:
                                raise ValueError('FFmpeg frame sequence or timestamp is invalid')
                            sequence[name] += 1
                            if name == 'bg_source':
                                if source_timeline is not None:
                                    source_timeline.observe(pts)
                            else:
                                put(float(pts * timing[name]))
                    elif source_timeline is None and (match := PTS_PATTERN.search(line)):
                        # Legacy standalone callers have no source-evidence claim.
                        timestamp = float(match.group(1))
                        if not math.isfinite(timestamp):
                            raise ValueError('Non-finite FFmpeg timestamp')
                        put(timestamp)
                    elif line and 'showinfo' not in line:
                        redacted = MEDIA_URL_PATTERN.sub('[media URL]', line)
                        logger.debug('FFmpeg: %s', redacted)
                        if diagnostics is not None and len(diagnostics) < 3 and FAILURE_DIAGNOSTIC.search(redacted):
                            diagnostics.append(CONTEXT_ADDRESS.sub(']', redacted)[:200])
                except Exception as error:
                    fail(error)
        except Exception as error:
            fail(error)
        finally:
            finished.set()

    reader = threading.Thread(target=read_stderr, name='ffmpeg-stderr', daemon=True)
    reader.start()
    try:
        for frame in read_jpegs(stdout):
            deadline = time.monotonic() + 10
            while True:
                if failure:
                    raise failure[0]
                try:
                    timestamp = timestamps.get(timeout=0.1)
                    break
                except queue.Empty:
                    if finished.is_set():
                        raise RuntimeError('FFmpeg emitted a frame without its timestamp')
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Timed out waiting for FFmpeg frame timestamp')
            yield frame, timestamp
        # Drain before joining: an extra sample must neither hide a late error
        # nor leave the bounded stderr producer waiting forever on its queue.
        unmatched = False
        deadline = time.monotonic() + 5
        while not finished.is_set() or not timestamps.empty():
            try:
                timestamps.get(timeout=0.05)
                unmatched = True
            except queue.Empty:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('FFmpeg stderr did not close')
        if failure:
            raise failure[0]
        if unmatched:
            raise RuntimeError('FFmpeg emitted a timestamp without its JPEG')
        if source_timeline is not None and validate_end:
            source_timeline.validate()
    finally:
        cancelled.set()
        reader.join(timeout=1)
