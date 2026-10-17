"""Source timing must survive sampling without accepting invented coverage."""

import io
import logging
import os
import queue
import shutil
import subprocess
import threading
from fractions import Fraction
from unittest.mock import Mock

import pytest

from video import MAX_DIAGNOSTIC_LINE, MAX_PENDING_TIMESTAMPS, SourceTimeline, timestamped_frames


JPEG = b'\xff\xd8frame\xff\xd9'


def config(name, base='1/10', rate='10/1'):
    return f'[showinfo@{name} @ 0x123] config in time_base: {base}, frame_rate: {rate}\n'


def frame(name, number, pts, displayed='99999'):
    return f'[showinfo@{name} @ 0x123] n: {number} pts: {pts} pts_time:{displayed} fmt:yuv420p\n'


def diagnostics(source_pts, sample_pts=(0, 1), *, base='1/10', rate='10/1'):
    lines = [config('bg_source', base, rate), config('bg_sample', '2/1', '1/2')]
    lines += [frame('bg_source', n, pts) for n, pts in enumerate(source_pts)]
    lines += [frame('bg_sample', n, pts) for n, pts in enumerate(sample_pts)]
    return ''.join(lines).encode()


def decode(logs, count, duration=4, interval=2):
    timeline = SourceTimeline(duration, interval)
    frames = list(timestamped_frames(io.BytesIO(JPEG * count), io.BytesIO(logs), logging.getLogger('test'),
                                    source_timeline=timeline))
    return frames, timeline


def test_named_source_records_never_pair_with_jpegs_and_integer_pts_ignore_decimal_rounding():
    frames, timeline = decode(diagnostics(range(40)), 2)
    assert frames == [(JPEG, 0.0), (JPEG, 2.0)]
    summary = timeline.summary(1800)
    assert summary['source_frames'] == 40
    assert summary['first_source_frame_seconds'] == 1800
    assert summary['last_source_frame_seconds'] == 1803.9
    assert summary['max_source_gap_seconds'] == 0.1
    assert summary['tail_unobserved_seconds'] == 0.1


def test_progress_carriage_return_does_not_hide_the_next_named_source_frame():
    logs = diagnostics(range(40)).replace(frame('bg_source', 11, 11).encode(),
                                         ('frame=1 fps=0.0 speed=1x\r' + frame('bg_source', 11, 11)).encode())
    frames, timeline = decode(logs, 2)
    assert [pts for _, pts in frames] == [0, 2]
    assert timeline.summary(0)['source_frames'] == 40


def test_fractional_input_rate_allows_one_frame_seek_rounding():
    frames, timeline = decode(diagnostics(range(500, 120000, 1001), base='1/30000', rate='30000/1001'), 2)
    assert [pts for _, pts in frames] == [0, 2]
    assert timeline.summary(1800)['first_source_frame_seconds'] == pytest.approx(1800 + 1 / 60)


def test_integer_rounded_catalog_end_keeps_supported_final_partial_sample():
    _, timeline = decode(diagnostics(range(81), (0, 1, 2, 3, 4)), 5, duration=9)
    assert timeline.summary(0)['last_source_frame_seconds'] == 8
    assert timeline.summary(0)['tail_unobserved_seconds'] == 1


@pytest.mark.parametrize('source_pts,match', [
    (list(range(40)), 'tail reaches'),  # A whole missing tail interval for a 6s request.
    ([*range(20), *range(40, 60)], 'gap reaches'),
    ([*range(20), 18, *range(20, 60)], 'do not advance'),
    (list(range(2, 60)), 'opening frame'),
])
def test_synthetic_sample_grid_cannot_hide_source_loss(source_pts, match):
    with pytest.raises(RuntimeError, match=match):
        decode(diagnostics(source_pts, (0, 1, 2)), 3, duration=6)


def test_short_end_without_source_support_for_last_tick_fails():
    with pytest.raises(RuntimeError, match='final sampling tick'):
        decode(diagnostics(range(78), (0, 1, 2, 3, 4)), 5, duration=9)


def test_duplicate_source_instant_does_not_discard_valid_coverage_or_inflate_it():
    frames, timeline = decode(diagnostics([*range(20), 19, *range(20, 40)]), 2)
    assert [pts for _, pts in frames] == [0, 2]
    summary = timeline.summary(0)
    assert summary['source_frames'] == 40
    assert summary['duplicate_source_frames'] == 1
    assert summary['max_source_gap_seconds'] == 0.1
    assert summary['last_source_frame_seconds'] == 3.9


def test_repeated_source_instant_cannot_cover_a_missing_tail():
    with pytest.raises(RuntimeError, match='final sampling tick'):
        decode(diagnostics([*range(10), *([9] * 100)], (0, 1)), 2)


@pytest.mark.parametrize('records,match', [
    (config('bg_source') + frame('bg_source', 0, 0) + frame('bg_source', 1, 20), 'gap reaches'),
    (config('bg_source') + frame('bg_source', 0, 0) + frame('bg_source', 2, 1), 'sequence'),
    (config('bg_source', rate='0/0'), 'timing metadata'),
])
def test_reader_errors_after_last_jpeg_still_fail(records, match):
    # Make the final error arrive only after the sole JPEG has been consumed.
    allow_tail = threading.Event()

    class DelayedTail(io.BytesIO):
        def readline(self, size=-1):
            if self.tell() >= len(prefix):
                assert allow_tail.wait(2)
            return super().readline(size)

    prefix = (config('bg_sample', '2/1', '1/2') + frame('bg_sample', 0, 0)).encode()
    logs = DelayedTail(prefix + records.encode())
    reader = timestamped_frames(io.BytesIO(JPEG), logs, logging.getLogger('test'),
                                source_timeline=SourceTimeline(1, 2))
    assert next(reader) == (JPEG, 0)
    allow_tail.set()
    with pytest.raises((ValueError, RuntimeError), match=match):
        next(reader)


def test_extra_sample_after_last_jpeg_is_rejected_even_when_queue_was_full():
    logs = diagnostics(range(10), range(MAX_PENDING_TIMESTAMPS * 3))
    with pytest.raises(RuntimeError, match='timestamp without its JPEG'):
        decode(logs, 1, duration=1)


def test_strict_source_mode_ignores_unrelated_pts_and_unnamed_showinfo():
    logs = diagnostics(range(10), ()) + b'[showinfo] pts_time:0 pos:0\n[other] pts_time:0 pos:0\n'
    with pytest.raises(RuntimeError, match='frame without its timestamp'):
        decode(logs, 1, duration=1)


@pytest.mark.parametrize('extra', [
    config('bg_source', '1/1000', '10/1'),
    frame('bg_source', 1, 2).replace('pts: 2', 'pts: NOPTS'),
])
def test_changed_or_missing_timing_cannot_silently_weaken_source_evidence(extra):
    logs = diagnostics([0], (0,)) + extra.encode()
    with pytest.raises(ValueError):
        decode(logs, 1, duration=1)


def test_oversized_diagnostic_is_bounded_and_not_reflected_in_errors_or_logs():
    logger = Mock()
    logs = diagnostics(range(10), (0,)) + b'private-cookie=' + b'x' * MAX_DIAGNOSTIC_LINE + b'\n'
    with pytest.raises(ValueError, match='bounded parser limit') as failure:
        list(timestamped_frames(io.BytesIO(JPEG), io.BytesIO(logs), logger, source_timeline=SourceTimeline(1, 2)))
    assert 'private-cookie' not in str(failure.value)
    assert not logger.debug.called


def test_bounded_timestamp_queue_does_not_deadlock_small_jpegs_or_leak_reader():
    # read(65536) used to wait for enough tiny JPEGs while stderr queue pressure
    # could stall FFmpeg. Real pipes exercise the same circular wait boundary.
    out_read, out_write = os.pipe()
    err_read, err_write = os.pipe()
    count = MAX_PENDING_TIMESTAMPS * 4
    outcome = queue.Queue()

    def produce():
        with os.fdopen(out_write, 'wb', buffering=0) as out, os.fdopen(err_write, 'wb', buffering=0) as err:
            err.write(config('bg_sample', '2/1', '1/2').encode())
            for n in range(count):
                err.write(frame('bg_sample', n, n).encode())
                out.write(JPEG)

    def consume():
        try:
            with os.fdopen(out_read, 'rb') as out, os.fdopen(err_read, 'rb') as err:
                outcome.put(list(timestamped_frames(out, err, logging.getLogger('test'))))
        except Exception as error:
            outcome.put(error)

    before = {thread.ident for thread in threading.enumerate() if thread.name == 'ffmpeg-stderr'}
    producer = threading.Thread(target=produce, daemon=True)
    consumer = threading.Thread(target=consume, daemon=True)
    producer.start()
    consumer.start()
    consumer.join(5)
    producer.join(1)
    assert not consumer.is_alive() and not producer.is_alive()
    result = outcome.get_nowait()
    assert not isinstance(result, Exception)
    assert [pts for _, pts in result] == list(range(0, count * 2, 2))
    assert {thread.ident for thread in threading.enumerate() if thread.name == 'ffmpeg-stderr'} == before


def test_source_aggregates_remain_constant_space_for_a_long_timeline():
    timeline = SourceTimeline(1800, 2)
    timeline.configure(Fraction(1, 30), Fraction(30))
    for n in range(54000):
        timeline.observe(n)
    summary = timeline.summary(0)
    assert summary['source_frames'] == 54000
    assert summary['last_source_frame_seconds'] == pytest.approx(1800 - 1 / 30)
    assert not any(isinstance(value, (list, dict, set)) for value in vars(timeline).values())


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='FFmpeg is required')
@pytest.mark.parametrize('drop_source_frames', [False, True])
def test_real_ffmpeg_named_diagnostics_reject_a_gap_before_fps_can_fill_it(drop_source_frames):
    filters = 'select=not(between(t\\,4\\,5.9)),' if drop_source_frames else ''
    filters += 'showinfo@bg_source=checksum=0,fps=0.5:eof_action=pass,showinfo@bg_sample=checksum=0'
    proc = subprocess.Popen([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'info',
        '-f', 'lavfi', '-i', 'testsrc2=s=16x16:r=10:d=8', '-an', '-vf', filters,
        '-fps_mode', 'passthrough', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timeline = SourceTimeline(8, 2)
    try:
        frames = timestamped_frames(proc.stdout, proc.stderr, logging.getLogger('test'), source_timeline=timeline)
        if drop_source_frames:
            with pytest.raises(RuntimeError, match='gap reaches'):
                list(frames)
        else:
            assert [pts for _, pts in frames] == [0, 2, 4, 6]
            assert timeline.summary(0)['source_frames'] == 80
            assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        proc.stdout.close()
        proc.stderr.close()
