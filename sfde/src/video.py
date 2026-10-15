"""Decode sampled video frames without separating pixels from their timestamps."""

import logging
import math
import queue
import re
import threading
from typing import BinaryIO, Iterator, Tuple


PTS_PATTERN = re.compile(r'\bpts_time:([-+\d.eE]+)\s')
MEDIA_URL_PATTERN = re.compile(r'https?://[^\s]+', re.IGNORECASE)


def read_jpegs(stream: BinaryIO) -> Iterator[bytes]:
    """Split FFmpeg image2pipe output, including markers split across reads."""
    buffer = bytearray()
    while True:
        chunk = stream.read(65536)
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


def timestamped_frames(stdout: BinaryIO, stderr: BinaryIO, logger: logging.Logger) -> Iterator[Tuple[bytes, float]]:
    """Pair each JPEG with its showinfo PTS before any downstream queuing.

    stderr must be drained concurrently to prevent the decoder blocking on a
    full pipe. Missing timestamps fail the chunk instead of inventing VOD links.
    """
    timestamps = queue.Queue()

    def read_stderr() -> None:
        try:
            for raw_line in stderr:
                line = raw_line.decode('utf-8', errors='replace').rstrip()
                match = PTS_PATTERN.search(line)
                if match:
                    timestamp = float(match.group(1))
                    if not math.isfinite(timestamp):
                        raise ValueError('Non-finite FFmpeg timestamp')
                    timestamps.put(timestamp)
                elif line and 'showinfo' not in line:
                    logger.debug('FFmpeg: %s', MEDIA_URL_PATTERN.sub('[redacted URL]', line))
        except Exception as error:
            timestamps.put(error)
        finally:
            timestamps.put(None)

    reader = threading.Thread(target=read_stderr, name='ffmpeg-stderr', daemon=True)
    reader.start()
    for frame in read_jpegs(stdout):
        try:
            timestamp = timestamps.get(timeout=10)
        except queue.Empty as error:
            raise RuntimeError('Timed out waiting for FFmpeg frame timestamp') from error
        if isinstance(timestamp, Exception):
            raise timestamp
        if timestamp is None:
            raise RuntimeError('FFmpeg emitted a frame without its timestamp')
        yield frame, timestamp
    reader.join(timeout=5)
    if reader.is_alive():
        raise RuntimeError('FFmpeg stderr did not close')
