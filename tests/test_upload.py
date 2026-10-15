"""Exercise actual batch upload retries without Supabase, requests, or telemetry."""

from contextlib import nullcontext
import importlib.util
import logging
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load_client_module():
    modules = {}
    for name, attributes in {
        'supabase': ['create_client', 'Client'], 'supabase.client': ['ClientOptions'],
        'requests': [], 'telemetry': ['create_span', 'record_histogram', 'record_counter'],
    }.items():
        module = ModuleType(name)
        for attribute in attributes:
            setattr(module, attribute, Mock())
        modules[name] = module
    modules['telemetry'].create_span = lambda *args, **kwargs: nullcontext()
    source = Path(__file__).resolve().parents[1] / 'sfot' / 'src' / 'supabase_client.py'
    spec = importlib.util.spec_from_file_location('tested_supabase_client', source)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


client_module = load_client_module()


class UploadBatchTests(unittest.TestCase):
    def setUp(self):
        self.uploader = client_module.SupabaseClient.__new__(client_module.SupabaseClient)
        self.uploader.streamer = 'whisperzz_live'
        self.uploader.quality = '480p'
        self.uploader.test_mode = False
        self.uploader.schema = 'public'
        self.uploader.retry_attempts = 3
        self.uploader.logger = logging.getLogger('test.upload')
        self.uploader.logger.addHandler(logging.NullHandler())
        self.uploader.client = Mock()
        self.vods = Mock()
        self.detections = Mock()
        self.uploader.client.table.side_effect = {'vods': self.vods, 'detections': self.detections}.__getitem__
        self.lookup = self.vods.select.return_value.eq.return_value.single.return_value.execute
        self.uploader._upload_image = Mock()
        self.uploader._upload_text_log = Mock()
        self.batch = [
            {'vod_id': '123', 'timestamp': 5, 'username': 'First', 'chunk_id': 'chunk', 'frame_base64': 'image1'},
            {'vod_id': '123', 'timestamp': 17, 'username': 'Second', 'chunk_id': 'chunk', 'frame_base64': 'image2'},
        ]
        sleep_patch = patch.object(client_module.time, 'sleep')
        self.sleep = sleep_patch.start()
        self.addCleanup(sleep_patch.stop)

    def test_transient_lookup_failure_retries_entire_batch_without_dropping_first_row(self):
        self.lookup.side_effect = [RuntimeError('temporary lookup failure'), SimpleNamespace(data={'id': 456})]
        self.assertTrue(self.uploader.upload_batch(self.batch))
        self.assertEqual(self.lookup.call_count, 2)
        self.sleep.assert_called_once_with(1)
        self.detections.insert.assert_called_once()
        inserted = self.detections.insert.call_args.args[0]
        self.assertEqual([row['username'] for row in inserted], ['First', 'Second'])
        self.assertEqual([row['frame_time_seconds'] for row in inserted], [5, 17])
        self.assertEqual([row['vod_id'] for row in inserted], [456, 456])
        self.assertEqual(self.uploader._upload_image.call_count, 2)

    def test_partial_preparation_is_discarded_before_retry(self):
        self.batch[1]['vod_id'] = '789'
        self.lookup.side_effect = [SimpleNamespace(data={'id': 456}), RuntimeError('second VOD lookup failed'),
                                   SimpleNamespace(data={'id': 456}), SimpleNamespace(data={'id': 987})]
        self.assertTrue(self.uploader.upload_batch(self.batch))
        self.assertEqual(self.lookup.call_count, 4)
        self.detections.insert.assert_called_once()
        inserted = self.detections.insert.call_args.args[0]
        self.assertEqual([row['username'] for row in inserted], ['First', 'Second'])
        self.assertEqual([row['vod_id'] for row in inserted], [456, 987])

    def test_persistent_lookup_failure_never_reports_success_or_inserts(self):
        self.lookup.side_effect = RuntimeError('persistent lookup failure')
        with self.assertRaisesRegex(RuntimeError, 'persistent lookup failure'):
            self.uploader.upload_batch(self.batch)
        self.assertEqual(self.lookup.call_count, 3)
        self.assertEqual(self.sleep.call_count, 2)
        self.detections.insert.assert_not_called()
        self.uploader._upload_image.assert_not_called()
        self.uploader._upload_text_log.assert_not_called()


if __name__ == '__main__':
    unittest.main()
