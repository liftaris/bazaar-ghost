"""Exercise the actual production pipeline without OCR or network dependencies."""

from contextlib import nullcontext
import importlib.util
import json
import logging
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
from types import ModuleType
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'sfot' / 'src'
sys.path.insert(0, str(SOURCE))


def load_runtime():
    """Stub service/model imports while retaining every SFOT class method."""
    modules = {}
    for name, attributes in {
        'yaml': ['safe_load'], 'numpy': [], 'dotenv': ['load_dotenv'],
        'frame_processor': ['FrameProcessor'], 'supabase_client': ['SupabaseClient'],
        'json_logger': ['JSONFormatter'],
        'telemetry': ['init_telemetry', 'create_span', 'record_counter',
                      'record_histogram', 'record_gauge', 'extract_trace_context',
                      'set_span_attribute', 'add_span_event', 'shutdown_telemetry'],
    }.items():
        module = ModuleType(name)
        for attribute in attributes:
            setattr(module, attribute, Mock())
        modules[name] = module
    modules['telemetry'].create_span = lambda *args, **kwargs: nullcontext()
    spec = importlib.util.spec_from_file_location('tested_sfot', SOURCE / 'sfot.py')
    runtime = importlib.util.module_from_spec(spec)
    # Also prevent import-time .env loading or model-host settings from escaping.
    with patch.dict(sys.modules, modules), patch.dict('os.environ', {}, clear=False):
        spec.loader.exec_module(runtime)
    return runtime


runtime = load_runtime()


def make_processor():
    """Build a processor with real queues/workers and an in-memory database mock."""
    processor = runtime.SFOTProcessor.__new__(runtime.SFOTProcessor)
    processor.chunk_id = 'test-chunk'
    processor.vod_id = '123456'
    processor.streamer = 'whisperzz_live'
    processor.start_time = 5
    processor.end_time = 305
    processor.quality = '480p'
    processor.stream_quality = '480p24'
    processor.formatted_quality = '480p24'
    processor.video_fps = 24
    processor.test_mode = True
    processor.old_templates = False
    processor.initial_status = 'pending'
    processor.profile = {'crop_region': [0.5, 0.5, 0.4, 0.2], 'profile_name': 'test'}
    processor.config = {
        'processing': {'frame_rate': 0.5, 'queue_size': 100, 'timeout': 5},
        'supabase': {'batch_size': 10}, 'test_mode': {'data_directory': 'test_data'},
        'ffmpeg': {'keyframes_only': True, 'loglevel': 'warning'},
    }
    processor.frame_queue = queue.Queue(maxsize=100)
    processor.result_queue = queue.Queue(maxsize=100)
    processor.shutdown = threading.Event()
    processor.frames_done = threading.Event()
    processor.results_done = threading.Event()
    processor.worker_errors = queue.Queue()
    processor.threads = []
    processor.streamlink_proc = None
    processor.ffmpeg_proc = None
    processor.frames_processed = 0
    processor.matchups_found = 0
    processor.result_batch = []
    processor.all_detections = []
    processor.span_attributes = {}
    processor.trace_context = None
    processor.logger = logging.getLogger('test.pipeline')
    processor.logger.addHandler(logging.NullHandler())
    processor.supabase = Mock()
    processor.supabase.delete_chunk_detections.return_value = 0
    processor.supabase.upload_batch.return_value = True
    processor.supabase.update_chunk.return_value = True
    processor.frame_processor = Mock()
    processor.frame_processor.process_frame.side_effect = lambda frame, timestamp, vod, chunk: {
        'timestamp': timestamp, 'username': 'Opponent', 'is_matchup': True,
        'confidence': 0.99, 'detected_rank': 'gold',
    }
    processor.export_detection_summary = Mock()
    return processor


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.processor = make_processor()
        self.addCleanup(self.stop_threads)

    def stop_threads(self):
        self.processor.shutdown.set()
        for thread in self.processor.threads:
            thread.join(timeout=2)

    def decode_frames(self, timestamps):
        def decode():
            for timestamp in timestamps:
                self.processor._put(self.processor.frame_queue, (b'jpeg', timestamp))
        self.processor.ffmpeg_worker = decode

    def assert_failed(self):
        self.assertEqual(self.processor.supabase.update_chunk.call_args.args[1], 'failed')
        self.assertFalse(any(thread.is_alive() for thread in self.processor.threads))

    def test_eof_drains_149_frames_queue_100_and_final_partial_batch(self):
        timestamps = list(range(5, 303, 2))
        original = self.processor.frame_processor.process_frame.side_effect

        def slow_ocr(*args):
            time.sleep(0.001)
            return original(*args)

        self.processor.frame_processor.process_frame.side_effect = slow_ocr
        self.decode_frames(timestamps)
        persisted = []
        def upload(batch):
            persisted.extend(dict(row) for row in batch)
            return True

        self.processor.supabase.upload_batch.side_effect = upload
        result = self.processor.process_vod_chunk()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['frames_processed'], 149)
        self.assertEqual([row['timestamp'] for row in persisted], timestamps)
        self.assertEqual([row['timestamp'] for row in self.processor.all_detections], timestamps)
        self.assertEqual(self.processor.supabase.upload_batch.call_count, 15)
        self.assertFalse(any(thread.is_alive() for thread in self.processor.threads))

    def test_backpressure_waits_for_consumer_without_dropping(self):
        destination = queue.Queue(maxsize=1)
        destination.put('first')
        worker = threading.Thread(target=self.processor._put, args=(destination, 'second'))
        self.processor.threads.append(worker)
        worker.start()
        time.sleep(0.15)
        self.assertTrue(worker.is_alive())
        self.assertEqual(destination.get_nowait(), 'first')
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(destination.get_nowait(), 'second')

    def test_cancelled_queue_write_fails_promptly(self):
        self.processor.shutdown.set()
        with self.assertRaises(RuntimeError):
            self.processor._put(queue.Queue(maxsize=1), 'frame')

    def test_worker_wrapper_reports_error_and_sets_done(self):
        error = ValueError('frame failed')
        done = threading.Event()
        self.processor._run_worker(Mock(side_effect=error), done)
        self.assertIs(self.processor.worker_errors.get_nowait(), error)
        self.assertTrue(done.is_set())
        self.assertTrue(self.processor.shutdown.is_set())

    def test_decoder_failure_after_a_frame_is_not_success(self):
        def decode():
            self.processor._put(self.processor.frame_queue, (b'jpeg', 5))
            raise RuntimeError('decoder failed')
        self.processor.ffmpeg_worker = decode
        with self.assertRaisesRegex(RuntimeError, 'decoder failed'):
            self.processor.process_vod_chunk()
        self.assert_failed()

    def test_frame_processing_failure_reaches_orchestrator(self):
        self.decode_frames([5])
        self.processor.frame_processor.process_frame.side_effect = ValueError('invalid frame')
        with self.assertRaisesRegex((RuntimeError, ValueError), 'invalid frame'):
            self.processor.process_vod_chunk()
        self.assert_failed()

    def test_database_failure_does_not_report_unpersisted_detection(self):
        self.decode_frames([5])
        self.processor.supabase.upload_batch.side_effect = RuntimeError('database unavailable')
        with self.assertRaisesRegex(RuntimeError, 'database unavailable'):
            self.processor.process_vod_chunk()
        self.assertEqual(self.processor.all_detections, [])
        self.assert_failed()

    def test_unsuccessful_upload_return_value_fails(self):
        for returned in (False, None):
            with self.subTest(returned=returned):
                self.processor = make_processor()
                self.decode_frames([5])
                self.processor.supabase.upload_batch.return_value = returned
                with self.assertRaises(RuntimeError):
                    self.processor.process_vod_chunk()
                self.assertEqual(self.processor.all_detections, [])
                self.assert_failed()

    def test_temporary_empty_queue_does_not_end_consumers(self):
        def decode():
            self.processor._put(self.processor.frame_queue, (b'jpeg', 5))
            time.sleep(0.15)
            self.processor._put(self.processor.frame_queue, (b'jpeg', 7))
        self.processor.ffmpeg_worker = decode
        self.processor.process_vod_chunk()
        self.assertEqual([row['timestamp'] for row in self.processor.all_detections], [5, 7])

    def test_final_frame_arriving_between_empty_get_and_eof_check_is_processed(self):
        original_get = self.processor.frame_queue.get
        first = True

        def racing_get(*args, **kwargs):
            nonlocal first
            if first:
                first = False
                self.processor.frame_queue.put((b'jpeg', 7))
                self.processor.frames_done.set()
                raise queue.Empty
            return original_get(*args, **kwargs)

        with patch.object(self.processor.frame_queue, 'get', side_effect=racing_get):
            self.processor.opencv_worker()
        self.assertEqual(self.processor.frames_processed, 1)
        self.assertEqual(self.processor.result_queue.get_nowait()['timestamp'], 7)

    def test_final_result_arriving_between_empty_get_and_eof_check_is_uploaded(self):
        original_get = self.processor.result_queue.get
        first = True

        def racing_get(*args, **kwargs):
            nonlocal first
            if first:
                first = False
                self.processor.result_queue.put({'timestamp': 7, 'username': 'Opponent'})
                self.processor.results_done.set()
                raise queue.Empty
            return original_get(*args, **kwargs)

        with patch.object(self.processor.result_queue, 'get', side_effect=racing_get):
            self.processor.result_worker()
        self.processor.supabase.upload_batch.assert_called_once()
        self.assertEqual([row['timestamp'] for row in self.processor.all_detections], [7])

    def test_failed_processing_status_write_prevents_worker_start(self):
        self.processor.ffmpeg_worker = Mock()
        self.processor.supabase.update_chunk.side_effect = lambda chunk, status, **kwargs: None if status == 'processing' else True
        with self.assertRaisesRegex(RuntimeError, 'processing chunk status'):
            self.processor.process_vod_chunk()
        self.processor.ffmpeg_worker.assert_not_called()
        self.processor.supabase.upload_batch.assert_not_called()
        self.processor.export_detection_summary.assert_not_called()
        self.assert_failed()

    def test_failed_completed_status_write_cannot_report_success(self):
        self.decode_frames([5])
        self.processor.supabase.update_chunk.side_effect = lambda chunk, status, **kwargs: None if status == 'completed' else True
        with self.assertRaisesRegex(RuntimeError, 'completed chunk status'):
            self.processor.process_vod_chunk()
        self.assertEqual([row['timestamp'] for row in self.processor.all_detections], [5])
        self.processor.export_detection_summary.assert_not_called()
        self.assert_failed()

    def test_empty_decode_fails(self):
        self.decode_frames([])
        with self.assertRaises(RuntimeError):
            self.processor.process_vod_chunk()
        self.assert_failed()

    def test_one_deadline_cancels_workers(self):
        self.processor.config['processing']['timeout'] = 0.05
        self.processor.ffmpeg_worker = lambda: self.processor.shutdown.wait(2)
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.processor.process_vod_chunk()
        self.assertLess(time.monotonic() - started, 1.5)
        self.assert_failed()

    def test_fps_metadata_cannot_recalculate_attached_timestamps(self):
        for fps in (24, 48, 50, 29.97, 60, None):
            with self.subTest(fps=fps):
                self.processor = make_processor()
                self.processor.video_fps = fps
                self.decode_frames([5, 7, 13])
                self.processor.process_vod_chunk()
                self.assertEqual([row['timestamp'] for row in self.processor.all_detections], [5, 7, 13])

    def test_exact_rendition_resolution_uses_fresh_url(self):
        payload = {'streams': {
            '480p24': {'type': 'hls', 'url': 'https://example.invalid/fresh.m3u8?token=secret'},
            '720p48': {'type': 'hls', 'url': 'https://example.invalid/other.m3u8'},
        }}
        with patch.object(runtime.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 0, json.dumps(payload), '')):
            self.assertEqual(self.processor._resolve_stream(), payload['streams']['480p24']['url'])

    def test_missing_exact_rendition_cannot_silently_fallback(self):
        payload = {'streams': {'720p48': {'url': 'https://example.invalid/other.m3u8'}}}
        with patch.object(runtime.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 0, json.dumps(payload), '')):
            with self.assertRaises((RuntimeError, ValueError)):
                self.processor._resolve_stream()

    def test_failed_resolution_preserves_existing_chunk_detections(self):
        self.processor.test_mode = False
        self.processor._resolve_stream = Mock(side_effect=ValueError('selected rendition missing'))
        with self.assertRaisesRegex(ValueError, 'selected rendition missing'):
            self.processor.process_vod_chunk()
        self.processor.supabase.delete_chunk_detections.assert_not_called()
        self.assert_failed()


if __name__ == '__main__':
    unittest.main()
