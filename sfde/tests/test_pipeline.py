"""Pipeline contracts: EOF drains work, errors fail chunks, timestamps stay attached."""

import io
import logging
import queue
import subprocess
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sfde import QUALITY_RESOLUTIONS, SFDEProcessor
from video import read_jpegs, timestamped_frames


def test_decoder_logs_redact_signed_playback_urls():
    logger = Mock()
    pixels = io.BytesIO(b'\xff\xd8a\xff\xd9')
    diagnostics = io.BytesIO(b"Input #0 from 'https://cdn.example/video?token=private':\n[showinfo] pts_time:0 pos:0 \n")
    assert len(list(timestamped_frames(pixels, diagnostics, logger))) == 1
    assert 'private' not in str(logger.debug.call_args_list)
    assert '[media URL]' in str(logger.debug.call_args_list)


def test_failure_diagnostics_are_bounded_and_redacted():
    pixels = io.BytesIO(b'\xff\xd8a\xff\xd9')
    stderr = io.BytesIO(b"[https @ 0x55d0c0ffee00] Stream ends prematurely at 10, should be 20 https://cdn.example/v?token=private\n"
                        b"[h264 @ 0x55d0c0ffee01] Invalid NAL unit size (26914 > 19323).\n"
                        b"[mov @ 0x1] corrupt input packet\n[h264 @ 0x2] error while decoding MB 0 19\n"
                        b"[showinfo] pts_time:0 pos:0 \n")
    diagnostics = []
    assert len(list(timestamped_frames(pixels, stderr, logging.getLogger(), diagnostics=diagnostics))) == 1
    assert diagnostics[:2] == ['[https] Stream ends prematurely at 10, should be 20 [media URL]',
                               '[h264] Invalid NAL unit size (26914 > 19323).']
    assert len(diagnostics) == 3 and 'private' not in str(diagnostics)


class FragmentedStream(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 1))


def test_jpeg_markers_split_across_reads():
    assert list(read_jpegs(FragmentedStream(b'\xff\xd8a\xff\xd9\xff\xd8b\xff\xd9'))) == [
        b'\xff\xd8a\xff\xd9', b'\xff\xd8b\xff\xd9',
    ]


def test_truncated_jpeg_fails():
    with pytest.raises(ValueError, match='incomplete'):
        list(read_jpegs(io.BytesIO(b'\xff\xd8partial')))


def test_frame_timestamp_pairing():
    pixels = io.BytesIO(b'\xff\xd8a\xff\xd9\xff\xd8b\xff\xd9')
    pts = io.BytesIO(b'[showinfo] pts_time:0.0 duration:2\n[showinfo] pts_time:2e+0 duration:2\n')
    assert [ts for _, ts in timestamped_frames(pixels, pts, logging.getLogger())] == [0, 2]


def test_missing_pts_does_not_invent_a_timestamp():
    with pytest.raises(RuntimeError, match='without its timestamp'):
        list(timestamped_frames(io.BytesIO(b'\xff\xd8a\xff\xd9'), io.BytesIO(), logging.getLogger()))


@pytest.fixture
def processor(monkeypatch, tmp_path):
    import sfde

    db = Mock()
    db.get_chunk_details.return_value = {
        'vod_id': '123', 'start_seconds': 0, 'end_seconds': 300, 'status': 'pending',
    }
    db.claim_chunk.return_value = True
    monkeypatch.setattr(sfde, 'BackendClient', Mock(return_value=db))
    reader = SimpleNamespace(process_frame=lambda frame, timestamp, vod, chunk: {
        'username': 'Opponent', 'timestamp': timestamp, 'is_matchup': True,
    })
    monkeypatch.setattr(sfde, 'FrameProcessor', Mock(return_value=reader))
    monkeypatch.setenv('SFDE_PROFILE', '{"crop_region":[0.5,0.5,0.4,0.2]}')
    monkeypatch.delenv('OTEL_EXPORTER_OTLP_ENDPOINT', raising=False)
    monkeypatch.setattr(sfde.signal, 'signal', lambda *args: None)
    value = SFDEProcessor({'chunk_id': 'test', 'test_mode': True})
    value.frame_queue.maxsize = 2
    value.result_queue.maxsize = 2
    value.export_detection_summary = lambda: None
    return value


def test_eof_drains_frames_results_and_final_batch(processor):
    def decode():
        for timestamp in range(101):
            processor._put(processor.frame_queue, (b'frame', timestamp))
    processor.ffmpeg_worker = decode
    result = processor.process_vod_chunk()
    assert result['status'] == 'completed'
    assert result['frames_processed'] == 101
    assert len(processor.all_detections) == 101
    assert [item['timestamp'] for item in processor.all_detections] == list(range(101))
    assert processor.backend.upload_batch.call_count == 11
    assert not any(thread.is_alive() for thread in processor.threads)


def test_decoder_error_after_frames_fails_chunk(processor):
    def decode():
        processor._put(processor.frame_queue, (b'frame', 0))
        raise RuntimeError('decoder failure')
    processor.ffmpeg_worker = decode
    with pytest.raises(RuntimeError, match='decoder failure'):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'


def test_upload_error_is_not_reported_as_completion(processor):
    processor.ffmpeg_worker = lambda: processor._put(processor.frame_queue, (b'frame', 0))
    processor.backend.upload_batch.side_effect = RuntimeError('database unavailable')
    with pytest.raises(RuntimeError, match='database unavailable'):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'


def test_empty_decode_fails_chunk(processor):
    processor.ffmpeg_worker = lambda: None
    with pytest.raises(RuntimeError, match='no frames'):
        processor.process_vod_chunk()


# A 6 s MP4 may complete a catalog end of 7 (one rounded-up second, e.g. an
# audio tail the video-only file lacks); 8 is a mismatched catalog.
@pytest.mark.parametrize('start,end', [(0,30), (3,30), (0,8)])
def test_clean_early_eof_cannot_complete_requested_range(processor, monkeypatch, tmp_path, start, end):
    video = tmp_path / 'short.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=6',
        '-c:v', 'libx264', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    processor.start_time, processor.end_time = start, end
    with pytest.raises(RuntimeError, match='coverage'):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'
    assert not any(call.args[1] == 'completed' for call in processor.backend.update_chunk.call_args_list)
    assert processor.ffmpeg_proc.returncode == 0


@pytest.mark.parametrize('duration,start,end,rate', [
    (8,0,8,0.5), (12,5,9,0.5), (7,0,7,0.5),
    (7,6,7,0.5), (11,5,11,0.5), (7,0,7,1), (7,0,7,0.2),
])
def test_real_decode_covers_bounded_and_final_ranges(processor, monkeypatch, tmp_path, duration, start, end, rate):
    video = tmp_path / 'complete.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', f'color=red:s=160x90:r=10:d={duration}',
        '-c:v', 'libx264', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    processor.start_time, processor.end_time = start, end
    processor.config['processing']['frame_rate'] = rate
    result = processor.process_vod_chunk()
    assert result['status'] == 'completed'
    assert result['decode_coverage']['sampled_frames'] == result['frames_processed']
    assert result['decode_coverage']['first_sample_seconds'] == start
    assert end - 1 / rate <= result['decode_coverage']['last_sample_seconds'] < end
    assert processor.ffmpeg_proc.returncode == 0


@pytest.mark.parametrize('start,expected', [(0, 4), (8, 0)])
def test_verified_audio_only_tail_keeps_catalog_range_without_inventing_frames(processor, monkeypatch, tmp_path, start, expected):
    video = tmp_path / 'audio-tail.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=8',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=9',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    processor.start_time, processor.end_time = start, 9
    result = processor.process_vod_chunk()
    coverage = result['decode_coverage']
    assert result['status'] == 'completed'
    assert result['frames_processed'] == expected
    assert coverage['completion_reason'] == 'verified_video_eof'
    assert coverage['requested_expected_frames'] == (5 if start == 0 else 1)
    assert coverage['minimum_expected_frames'] == expected
    assert coverage['effective_video_end_seconds'] == 8
    assert coverage['requested_end_seconds'] == 9
    assert coverage['unobserved_catalog_tail_seconds'] == 1
    assert coverage['video_endpoint']['video_end_seconds'] == 8
    assert coverage['video_endpoint']['closed'] is True
    assert coverage['first_sample_seconds'] == (0 if expected else None)
    assert coverage['last_sample_seconds'] == (6 if expected else None)
    assert coverage['source_frames'] == (80 if expected else 0)
    assert coverage['last_source_frame_seconds'] == (7.9 if expected else None)
    assert [item['timestamp'] for item in processor.all_detections] == list(range(0, 8, 2))[:expected]


def test_clean_decoder_truncation_cannot_borrow_a_real_audio_only_tail(processor, monkeypatch, tmp_path):
    import sfde

    video = tmp_path / 'longer-video.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=10',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=11',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    original = subprocess.Popen

    def drop_final_frames(command, *args, **kwargs):
        command = list(command)
        if command[0] == 'ffmpeg' and '-vf' in command:
            index = command.index('-vf') + 1
            command[index] = r'select=lt(t\,8),' + command[index]
        return original(command, *args, **kwargs)

    monkeypatch.setattr(sfde.subprocess, 'Popen', drop_final_frames)
    processor.end_time = 11
    with pytest.raises(RuntimeError):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'
    assert not any(call.args[1] == 'completed' for call in processor.backend.update_chunk.call_args_list)


@pytest.mark.parametrize('timestamps', [[2,4,6,8], [0,2,6,8], [0,2,4,4,8]])
def test_shifted_missing_or_duplicate_sample_timeline_fails(processor, monkeypatch, tmp_path, timestamps):
    import sfde
    video = tmp_path / 'unused.mp4'
    video.touch()
    monkeypatch.setenv('TEST_VIDEO', str(video))
    monkeypatch.setattr(sfde.subprocess, 'Popen', Mock(return_value=SimpleNamespace(
        stdout=io.BytesIO(), stderr=io.BytesIO(), wait=lambda **kwargs: 0, poll=lambda: 0,
    )))
    monkeypatch.setattr(sfde, 'timestamped_frames', lambda *args, **kwargs: ((b'frame', pts) for pts in timestamps))
    processor.end_time = 10
    with pytest.raises(RuntimeError, match='coverage'):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'


@pytest.mark.parametrize('end,complete', [(9,True), (30,False)])
def test_hls_coverage_preserves_seek_boundaries_and_rejects_short_playlist(processor, monkeypatch, tmp_path, end, complete):
    playlist = tmp_path / 'video.m3u8'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=12',
        '-c:v', 'libx264', '-g', '40', '-sc_threshold', '0',
        '-hls_time', '4', '-hls_playlist_type', 'vod', str(playlist),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(playlist))
    processor.start_time, processor.end_time = 5, end
    if complete:
        result = processor.process_vod_chunk()
        assert result['decode_coverage']['first_sample_seconds'] == 5
        assert result['decode_coverage']['last_sample_seconds'] == 7
        assert result['frames_processed'] == 2
    else:
        with pytest.raises(RuntimeError, match='coverage'):
            processor.process_vod_chunk()
        assert processor.backend.update_chunk.call_args.args[1] == 'failed'
    assert processor.ffmpeg_proc.returncode == 0


@pytest.mark.parametrize('start', [0, 5])
@pytest.mark.parametrize('next_enabled', [False, True], ids=['legacy', 'native_next'])
def test_hls_transport_origin_does_not_shift_vod_frames(processor, monkeypatch, tmp_path, start, next_enabled):
    import cv2
    import numpy as np
    from PIL import Image

    # Nonzero MPEG-TS origin reproduces FFmpeg 5's input -ss 0 bug. Keep
    # recognizable pixels so a fabricated zero-based PTS sequence cannot pass.
    playlist = tmp_path / 'offset.m3u8'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=30:d=6',
        '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=30:d=6',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
        '-c:v', 'libx264', '-g', '120', '-sc_threshold', '0',
        '-output_ts_offset', '2', '-muxdelay', '0',
        '-hls_time', '4', '-hls_playlist_type', 'vod', str(playlist),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(playlist))
    processor.start_time, processor.end_time = start, 9
    processor.next_enabled = next_enabled
    processor._combined_crop, _, _ = processor._compute_combined_crop(*QUALITY_RESOLUTIONS[processor.quality])
    processor.frame_queue = queue.Queue()  # Inspect real decoder output without OCR.
    processor._decode_range(start, 9)
    command = processor.ffmpeg_proc.args
    assert command[command.index('-pix_fmt') + 1] == 'yuvj420p'
    filters = command[command.index('-vf') + 1]
    if next_enabled:
        assert command[-3:] == ['-q:v', '2', 'pipe:1']
        assert 'scale=' not in filters and 'crop=' not in filters
    else:
        assert '-q:v' not in command
        assert command[-9:] == ['-fps_mode', 'passthrough', '-f', 'image2pipe',
                                '-vcodec', 'mjpeg', '-pix_fmt', 'yuvj420p', 'pipe:1']
        assert 'scale=' in filters and 'crop=' in filters
    observed = []
    while not processor.frame_queue.empty():
        item = processor.frame_queue.get_nowait()
        if next_enabled:
            frame, timestamp_ms, owned = item
            assert owned is True
            assert timestamp_ms % 1000 == 0
            timestamp = timestamp_ms // 1000
        else:
            frame, timestamp = item
        pixels = cv2.imdecode(np.frombuffer(frame, np.uint8), cv2.IMREAD_COLOR)
        expected_shape = (90, 160) if next_enabled else (processor._combined_crop[1], processor._combined_crop[0])
        assert pixels.shape[:2] == expected_shape
        with Image.open(io.BytesIO(frame)) as jpeg:
            assert jpeg.layer == [(1, 2, 2, 0), (2, 1, 1, 0), (3, 1, 1, 0)]  # 4:2:0.
        blue, _, red = pixels.mean(axis=(0, 1))
        observed.append((timestamp, 'red' if red > blue else 'blue'))
    ticks = list(range(start, 9, 2))
    assert observed == [(tick, 'red' if tick < 6 else 'blue') for tick in ticks]
    assert processor.ffmpeg_proc.returncode == 0
    assert processor.decode_coverage['sampled_frames'] == len(ticks)
    assert processor.decode_coverage['sample_interval_seconds'] == 2
    assert processor.decode_coverage['first_sample_seconds'] == ticks[0]
    assert processor.decode_coverage['last_sample_seconds'] == ticks[-1]


def test_source_gap_cannot_be_hidden_by_fps_repeated_frames(processor, monkeypatch, tmp_path):
    video = tmp_path / 'gap.mkv'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=8',
        '-vf', "select='not(between(t,4,5.9))'", '-fps_mode', 'vfr',
        '-c:v', 'libx264', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    processor.end_time = 8
    with pytest.raises(RuntimeError, match='source coverage: gap'):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'


def test_missing_initial_video_is_not_rebased_to_zero(processor, monkeypatch, tmp_path):
    video = tmp_path / 'delayed.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=8',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=10',
        '-filter_complex', '[0:v]setpts=PTS+2/TB[v]', '-map', '[v]', '-map', '1:a',
        '-fps_mode', 'vfr', '-c:v', 'libx264', '-c:a', 'aac', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    processor.end_time = 10
    with pytest.raises(RuntimeError, match='source coverage: opening'):
        processor.process_vod_chunk()
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'


def test_rounded_catalog_tail_keeps_source_support_evidence(processor, monkeypatch, tmp_path):
    video = tmp_path / 'fractional.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=8.1',
        '-c:v', 'libx264', str(video),
    ], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(video))
    processor.end_time = 9  # Catalog duration uses ceil, while the last sample is at 8.
    result = processor.process_vod_chunk()
    assert result['frames_processed'] == 5
    coverage = result['decode_coverage']
    assert coverage['source_frames'] == 81
    assert coverage['last_source_frame_seconds'] == coverage['last_sample_seconds'] == 8
    assert coverage['tail_unobserved_seconds'] == 1


def test_unclaimed_chunk_does_not_delete_or_rewrite_other_worker(processor, monkeypatch):
    processor.old_templates = True
    monkeypatch.setenv('OLD_TEMPLATES', 'false')
    monkeypatch.setenv('SFDE_PROFILE', '{"id":999}')
    processor.backend.claim_chunk.return_value = False
    with pytest.raises(ValueError, match='unavailable, already claimed, or has changed profile/templates'):
        processor.process_vod_chunk()
    processor.backend.claim_chunk.assert_called_once_with(
        processor.chunk_id, expected_profile=processor.profile, expected_old_templates=True,
    )
    processor.backend.delete_chunk_detections.assert_not_called()
    processor.backend.update_chunk.assert_not_called()


def test_deadline_cancels_workers(processor):
    processor.config['processing']['timeout'] = 0.01
    processor.ffmpeg_worker = lambda: processor.shutdown.wait(2)
    with pytest.raises(TimeoutError):
        processor.process_vod_chunk()
    assert not any(thread.is_alive() for thread in processor.threads)


@pytest.mark.parametrize('region', [[-0.1, 0, 1, 1], [0, 0, 0, 1], [0.5, 0, 1, 1], [0, 0, 'NaN', 1]])
def test_invalid_profile_crop_rejected(monkeypatch, region):
    import json
    monkeypatch.setenv('SFDE_PROFILE', json.dumps({'crop_region': region}))
    with pytest.raises(ValueError):
        SFDEProcessor.__new__(SFDEProcessor)._parse_sfde_profile()

@pytest.mark.parametrize('days,expected', [
    ([8, 8, 8], 8), ([8], None), ([8, 8], None), ([None], None),
    ([5, None, 11, 11, 11], 11), ([8, 8, None, 8], None),
])
def test_igd_pending_detection_survives_eof(processor, days, expected):
    import numpy as np
    processor._igd_slice = [0, 0, 2, 2]
    processor._nameplate_slice = [0, 0, 2, 2]
    processor._decode_jpeg = lambda _: np.zeros((2, 2, 3), dtype=np.uint8)
    processor._encode_jpeg = lambda _: b'frame'
    processor.frame_queue.maxsize = len(days) + 1
    processor.frame_processor.emblem_visible = False
    processor.frame_processor.process_frame = Mock(side_effect=[
        {'is_matchup': True, 'username': 'first', 'timestamp': 0}, *([None] * len(days)),
    ])
    processor.frame_processor.extract_igd = Mock(side_effect=days)
    for index in range(len(days) + 1):
        processor.frame_queue.put((b'frame', index * 2))
    processor.frames_done.set()
    processor.opencv_worker()
    result = processor.result_queue.get_nowait()
    assert result.get('igd') == expected
    if expected is None:
        assert 'igd_evidence' not in result
    else:
        assert result['igd_evidence']['samples'] == 3
    assert processor.result_queue.empty()


@pytest.mark.parametrize('overlay_frames', [2, 15])
def test_igd_waits_for_overlay_to_clear_and_keeps_its_budget(processor, overlay_frames):
    import numpy as np
    processor._igd_slice = processor._nameplate_slice = [0, 0, 2, 2]
    processor._decode_jpeg = lambda _: np.zeros((2, 2, 3), dtype=np.uint8)
    processor._encode_jpeg = lambda _: b'frame'
    processor.frame_queue.maxsize = 32

    def read(_, timestamp, *args):
        processor.frame_processor.emblem_visible = timestamp <= 2172 + 2 * overlay_frames
        if timestamp == 2172:
            return {'is_matchup': True, 'username': 'mazen', 'timestamp': timestamp}

    processor.frame_processor.process_frame = read
    processor.frame_processor.extract_igd = Mock(return_value=11)
    for index in range(overlay_frames + 4):
        processor.frame_queue.put((b'frame', 2172 + 2 * index))
    processor.frames_done.set()
    processor.opencv_worker()
    result = processor.result_queue.get_nowait()
    if overlay_frames == 2:
        assert result['igd'] == 11
        assert result['igd_evidence'] == {'samples': 3, 'first_sample_seconds': 2178, 'last_sample_seconds': 2182}
        assert processor.frame_processor.extract_igd.call_count == 3
    else:
        assert result.get('igd') is None
        processor.frame_processor.extract_igd.assert_not_called()
    assert processor.result_queue.empty()


def test_new_matchup_day_is_not_assigned_to_previous_matchup(processor):
    import numpy as np
    processor.result_queue.maxsize = 3
    processor._igd_slice = [0, 0, 2, 2]
    processor._nameplate_slice = [0, 0, 2, 2]
    processor._decode_jpeg = lambda _: np.zeros((2, 2, 3), dtype=np.uint8)
    processor._encode_jpeg = lambda _: b'frame'
    processor.frame_processor.process_frame = Mock(side_effect=[
        {'is_matchup': True, 'username': 'first', 'timestamp': 0},
        {'is_matchup': True, 'username': 'second', 'timestamp': 2},
    ])
    processor.frame_processor.extract_igd = Mock(return_value=9)
    processor.frame_queue.put((b'frame', 0))
    processor.frame_queue.put((b'frame', 2))
    processor.frames_done.set()
    processor.opencv_worker()
    results = [processor.result_queue.get_nowait() for _ in range(2)]
    assert [row['username'] for row in results] == ['first', 'second']
    assert all(row.get('igd') is None for row in results)
    processor.frame_processor.extract_igd.assert_not_called()


def test_unreadable_username_is_not_counted_or_published(processor):
    processor.frame_processor.process_frame = lambda *args: {'is_matchup': True, 'username': '', 'timestamp': 0}
    processor.ffmpeg_worker = lambda: processor._put(processor.frame_queue, (b'frame', 0))
    result = processor.process_vod_chunk()
    assert result['status'] == 'completed'
    assert processor.frames_processed == 1
    assert processor.matchups_found == 0
    assert processor.all_detections == []
    processor.backend.upload_batch.assert_not_called()


def _flaky_decoder(processor, failures, error_type):
    attempts = []

    def decode():
        attempts.append(len(attempts) + 1)
        processor._put(processor.frame_queue, (b'frame', 10 * len(attempts)))
        if len(attempts) <= failures:
            raise error_type('FFmpeg exited with code 183: [h264] Invalid NAL unit size')
    processor.ffmpeg_worker = decode
    return attempts


def test_progressive_media_read_failure_retries_once_under_the_same_claim(processor, monkeypatch):
    import sfde
    monkeypatch.setattr(sfde, 'MEDIA_RETRY_DELAY_SECONDS', 0)
    processor.frame_processor.reset_state = Mock()
    attempts = _flaky_decoder(processor, 1, sfde.MediaReadError)
    result = processor.process_vod_chunk()
    assert result['status'] == 'completed' and attempts == [1, 2]
    assert processor.backend.claim_chunk.call_count == 1
    assert processor.backend.delete_chunk_detections.call_count == 2  # Claim, then the failed attempt's uploads.
    processor.frame_processor.reset_state.assert_called_once()
    assert result['frames_processed'] == 1
    assert [item['timestamp'] for item in processor.all_detections] == [20]


def test_second_media_read_failure_fails_the_chunk(processor, monkeypatch):
    import sfde
    monkeypatch.setattr(sfde, 'MEDIA_RETRY_DELAY_SECONDS', 0)
    processor.frame_processor.reset_state = Mock()
    attempts = _flaky_decoder(processor, 2, sfde.MediaReadError)
    with pytest.raises(sfde.MediaReadError):
        processor.process_vod_chunk()
    assert attempts == [1, 2]
    assert processor.backend.update_chunk.call_args.args[1] == 'failed'


def test_no_retry_without_enough_of_the_chunk_deadline_left(processor, monkeypatch):
    import sfde
    processor.config['processing']['timeout'] = sfde.MEDIA_RETRY_MIN_REMAINING_SECONDS
    attempts = _flaky_decoder(processor, 1, sfde.MediaReadError)
    with pytest.raises(sfde.MediaReadError):
        processor.process_vod_chunk()
    assert attempts == [1]


@pytest.fixture
def progressive_file(processor, monkeypatch, tmp_path):
    """Run the real decoder on a local file as if it were a progressive HTTP input."""
    video = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
                    '-i', 'testsrc2=s=320x180:r=10:d=6', '-c:v', 'libx264', '-g', '10', str(video)], check=True, timeout=60)

    def resolve():
        processor._media_input_args, processor._media_progressive_args = [], ['-xerror']
        return str(video)
    processor.test_mode = False
    processor.frame_queue = queue.Queue()  # Called directly, without the OpenCV consumer.
    monkeypatch.setattr(processor, '_resolve_stream', resolve)
    processor._combined_crop = [64, 36, 0, 0]
    return video


@pytest.mark.parametrize('end,expected', [(30, 'MediaReadError'), (12, 'RuntimeError')])
def test_only_reads_that_stop_well_before_the_end_are_media_read_failures(processor, progressive_file, end, expected):
    processor.start_time, processor.end_time = 0, end
    with pytest.raises(RuntimeError, match='coverage') as caught:
        processor.ffmpeg_worker()
    assert type(caught.value).__name__ == expected


def test_corrupt_progressive_data_is_a_media_read_failure(processor, progressive_file):
    import sfde
    data = bytearray(progressive_file.read_bytes())
    middle = len(data) // 2
    data[middle:middle + 4000] = bytes(range(256)) * 15 + bytes(160)
    progressive_file.write_bytes(bytes(data))
    processor.start_time, processor.end_time = 0, 6
    with pytest.raises(sfde.MediaReadError, match='FFmpeg exited with code'):
        processor.ffmpeg_worker()
