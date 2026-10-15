import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('workflow', Path(__file__).resolve().parents[1] / 'vod_workflow.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)
from media_source import resolve_media


class WorkflowTests(unittest.TestCase):
    def test_respects_requested_quality(self):
        self.assertEqual(workflow.select_quality({'480p': {}, '720p60': {}}, '720p', False), '720p60')

    def test_old_templates_prefer_480p_but_can_normalize_other_sources(self):
        self.assertEqual(workflow.select_quality({'720p': {}}, '720p', True), '720p')
        self.assertEqual(workflow.select_quality({'720p': {}, '480p60': {}}, '720p', True), '480p60')

    def test_unsupported_quality_is_rejected(self):
        with self.assertRaises(ValueError):
            workflow.select_quality({'best': {}}, 'best', False)

    def test_no_rendition_is_not_assumed_available(self):
        with self.assertRaises(ValueError):
            workflow.select_quality({}, '480p', False)

    def test_prepared_native_name_survives_output_and_exact_runtime_resolution(self):
        vod = {'id': 12, 'source': 'twitch', 'processing_enabled': True,
               'ready_for_processing': True, 'availability': 'available',
               'old_templates': False, 'profile': {'crop_region': [0, 0, 1, 1]}}
        for name, preferred, expected_geometry, expected_fps in [
            ('480p24', '480p', '480p', 24), ('720p48', '720p', '720p', 48),
            ('1080p50', '1080p', '1080p', 50), ('720p29.97', '720p', '720p', 29.97),
            ('900p48', '720p', '720p', 48), ('480p', '480p', '480p', None),
        ]:
            with self.subTest(name=name), TemporaryDirectory() as directory:
                output_file = Path(directory) / 'outputs'
                streams = {name: {'type': 'hls', 'url': 'https://cdn.example/video.m3u8'}}
                response = SimpleNamespace(returncode=0, stdout=json.dumps({'streams': streams}))
                env = {'VOD_ID': '123', 'REQUESTED_QUALITY': preferred, 'GITHUB_OUTPUT': str(output_file)}
                with patch.dict(os.environ, env, clear=True), patch.object(workflow, 'get_vod', return_value=vod), \
                        patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                        patch('media_source.subprocess.run', return_value=response):
                    workflow.prepare()
                    outputs = dict(line.split('=', 1) for line in output_file.read_text().splitlines())
                    self.assertEqual(outputs['quality'], expected_geometry)
                    self.assertEqual(outputs['stream_quality'], name)
                    self.assertEqual(outputs['video_fps'], '' if expected_fps is None else str(float(expected_fps)))
                    media = resolve_media('twitch', '123', outputs['quality'], stream_quality=outputs['stream_quality'])
                    self.assertEqual(media['stream_quality'], name)
                    self.assertEqual(media['fps'], expected_fps)

    def test_prepared_native_name_cannot_silently_fall_back(self):
        response = SimpleNamespace(returncode=0, stdout=json.dumps({'streams': {
            '480p60': {'type': 'hls', 'url': 'https://cdn.example/other.m3u8'},
        }}))
        with patch('media_source.subprocess.run', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'no longer available'):
                resolve_media('twitch', '123', '480p', stream_quality='480p24')

    def test_standalone_twitch_uses_same_native_selector(self):
        response = SimpleNamespace(returncode=0, stdout=json.dumps({'streams': {
            '480p24': {'type': 'hls', 'url': 'https://cdn.example/low.m3u8'},
            '720p48': {'type': 'hls', 'url': 'https://cdn.example/high.m3u8'},
        }}))
        with patch('media_source.subprocess.run', return_value=response):
            self.assertEqual(resolve_media('twitch', '123', '720p')['stream_quality'], '720p48')


if __name__ == '__main__':
    unittest.main()
