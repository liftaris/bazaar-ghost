"""Pipeline contracts: EOF drains work, errors fail chunks, timestamps stay attached."""

import io
import logging
import queue
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sfde import SFDEProcessor
from video import read_jpegs, timestamped_frames


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


def test_ffmpeg_diagnostics_redact_signed_urls():
    logger = Mock()
    diagnostics = io.BytesIO(b"[hls] Opening 'https://cdn.example/video?token=secret' for reading\n")
    assert list(timestamped_frames(io.BytesIO(), diagnostics, logger)) == []
    assert 'secret' not in str(logger.debug.call_args_list)
    assert '[redacted URL]' in str(logger.debug.call_args_list)


@pytest.fixture
def processor(monkeypatch, tmp_path):
    import sfde

    db = Mock()
    db.get_chunk_details.return_value = {
        'vod_id': '123', 'start_seconds': 0, 'end_seconds': 300, 'status': 'pending',
    }
    db.claim_chunk.return_value = True
    monkeypatch.setattr(sfde, 'SupabaseClient', Mock(return_value=db))
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
    assert processor.supabase.upload_batch.call_count == 11
    assert not any(thread.is_alive() for thread in processor.threads)


def test_frame_arriving_between_empty_timeout_and_eof_check_is_consumed(processor, monkeypatch):
    original_get = processor.frame_queue.get
    first = True

    def get_frame(*args, **kwargs):
        nonlocal first
        if first:
            first = False
            processor.frame_queue.put((b'frame', 7))
            processor.frames_done.set()
            raise queue.Empty
        return original_get(*args, **kwargs)

    monkeypatch.setattr(processor.frame_queue, 'get', get_frame)
    processor.opencv_worker()
    assert processor.frames_processed == 1
    assert processor.result_queue.get_nowait()['timestamp'] == 7


def test_result_arriving_between_empty_timeout_and_eof_check_is_persisted(processor, monkeypatch):
    original_get = processor.result_queue.get
    first = True

    def get_result(*args, **kwargs):
        nonlocal first
        if first:
            first = False
            processor.result_queue.put({'username': 'Opponent', 'timestamp': 7})
            processor.results_done.set()
            raise queue.Empty
        return original_get(*args, **kwargs)

    monkeypatch.setattr(processor.result_queue, 'get', get_result)
    processor.result_worker()
    assert [row['timestamp'] for row in processor.all_detections] == [7]
    processor.supabase.upload_batch.assert_called_once()


def test_decoder_error_after_frames_fails_chunk(processor):
    def decode():
        processor._put(processor.frame_queue, (b'frame', 0))
        raise RuntimeError('decoder failure')
    processor.ffmpeg_worker = decode
    with pytest.raises(RuntimeError, match='decoder failure'):
        processor.process_vod_chunk()
    assert processor.supabase.update_chunk.call_args.args[1] == 'failed'


def test_upload_error_is_not_reported_as_completion(processor):
    processor.ffmpeg_worker = lambda: processor._put(processor.frame_queue, (b'frame', 0))
    processor.supabase.upload_batch.side_effect = RuntimeError('database unavailable')
    with pytest.raises(RuntimeError, match='database unavailable'):
        processor.process_vod_chunk()
    assert processor.supabase.update_chunk.call_args.args[1] == 'failed'


def test_empty_decode_fails_chunk(processor):
    processor.ffmpeg_worker = lambda: None
    with pytest.raises(RuntimeError, match='no frames'):
        processor.process_vod_chunk()


@pytest.mark.parametrize('native,fps', [('480p24', 24), ('720p48', 48),
                                      ('1080p50', 50), ('720p29.97', 29.97)])
def test_native_source_metadata_does_not_change_geometry_or_sampling(processor, native, fps, monkeypatch):
    import sfde
    processor.stream_quality = native
    processor.requested_quality = '480p'
    monkeypatch.setattr(sfde, 'resolve_media', Mock(return_value={
        'stream_quality': native, 'height': int(native.split('p')[0]), 'fps': fps,
        'url': 'https://cdn.example/video.m3u8', 'headers': {}, 'resolver': 'streamlink',
    }))
    assert processor._resolve_stream() == 'https://cdn.example/video.m3u8'
    assert processor.quality == '480p'
    assert processor.config['processing']['frame_rate'] == 0.5
    assert processor.video_fps == fps
    assert processor.formatted_quality == native
    sfde.resolve_media.assert_called_once_with('twitch', '123', '480p', stream_quality=native)


@pytest.mark.parametrize('config,geometry,fps', [
    ({'quality': '720p48'}, '720p', 48),
    ({'quality': '1080p50'}, '1080p', 50),
    ({'quality': '720p29.97'}, '720p', 29.97),
    ({'quality': '480p', 'stream_quality': '720p48'}, '480p', 48),
    ({'quality': '480p', 'video_fps': '29.97'}, '480p', 29.97),
    ({'quality': '480p', 'video_fps': ''}, '480p', None),
    ({'quality': '720p48', 'old_templates': True}, '480p', 48),
])
def test_source_fps_is_optional_metadata_during_initialization(processor, config, geometry, fps):
    value = SFDEProcessor({'chunk_id': 'test', 'test_mode': True, **config})
    assert value.quality == geometry
    assert value.frame_processor is not None
    assert value.video_fps == fps
    assert value.config['processing']['frame_rate'] == 0.5


def test_unclaimed_chunk_does_not_delete_or_rewrite_other_worker(processor):
    processor.supabase.claim_chunk.return_value = False
    with pytest.raises(ValueError, match='not pending or queued'):
        processor.process_vod_chunk()
    processor.supabase.delete_chunk_detections.assert_not_called()
    processor.supabase.update_chunk.assert_not_called()


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

@pytest.mark.parametrize('days,expected', [([8], 8), ([None], None)])
def test_igd_pending_detection_survives_eof(processor, days, expected):
    import numpy as np
    processor._igd_slice = [0, 0, 2, 2]
    processor._nameplate_slice = [0, 0, 2, 2]
    processor._decode_jpeg = lambda _: np.zeros((2, 2, 3), dtype=np.uint8)
    processor._encode_jpeg = lambda _: b'frame'
    processor.frame_processor.process_frame = Mock(side_effect=[
        {'is_matchup': True, 'username': 'first', 'timestamp': 0}, None,
    ])
    processor.frame_processor.extract_igd = Mock(side_effect=days)
    processor.frame_queue.put((b'frame', 0))
    processor.frame_queue.put((b'frame', 2))
    processor.frames_done.set()
    processor.opencv_worker()
    assert processor.result_queue.get_nowait().get('igd') == expected
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
