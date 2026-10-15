"""Offline tests for the production Twitch preflight boundary."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import prepare_twitch_rendition as preflight


class PrepareTwitchRenditionTests(unittest.TestCase):
    def setUp(self):
        self.env = {'VOD_ID': '123456', 'REQUESTED_QUALITY': '480p'}

    def discover(self, payload):
        return patch.object(
            preflight.subprocess, 'run',
            return_value=subprocess.CompletedProcess([], 0, json.dumps(payload), ''),
        )

    def test_preserves_exact_arbitrary_fps_rendition(self):
        with self.discover({'streams': {'480p24': {}, '720p48': {}, '1080p50': {}}}) as run:
            selected = preflight.prepare_rendition(self.env)
        self.assertEqual(selected, {
            'stream_quality': '480p24', 'quality': '480p',
            'video_fps': '24', 'available': 'true',
        })
        self.assertEqual(run.call_args.args[0], [
            'streamlink', '--no-config', '--json', 'https://www.twitch.tv/videos/123456',
        ])
        self.assertEqual(run.call_args.kwargs['timeout'], 90)
        self.assertTrue(run.call_args.kwargs['check'])

    def test_unsuffixed_quality_does_not_infer_source_fps(self):
        with self.discover({'streams': {'480p': {}}}):
            self.assertEqual(preflight.prepare_rendition(self.env)['video_fps'], '')

    def test_fractional_fps_is_preserved(self):
        with self.discover({'streams': {'720p59.94': {}}}):
            selected = preflight.prepare_rendition(self.env)
        self.assertEqual(selected['stream_quality'], '720p59.94')
        self.assertEqual(selected['video_fps'], '59.94')
        self.assertEqual(selected['quality'], '720p')

    def test_local_has_consistent_outputs_without_network(self):
        self.env.update(LOCAL='true', REQUESTED_QUALITY='1080p50')
        with patch.object(preflight.subprocess, 'run') as run:
            selected = preflight.prepare_rendition(self.env)
        run.assert_not_called()
        self.assertEqual(selected['stream_quality'], '1080p50')
        self.assertEqual(selected['quality'], '1080p')
        self.assertEqual(selected['video_fps'], '50')
        self.assertEqual(selected['available'], 'true')

    def test_old_templates_select_480p_processing(self):
        self.env['OLD_TEMPLATES'] = 'true'
        with self.discover({'streams': {'720p48': {}}}):
            selected = preflight.prepare_rendition(self.env)
        self.assertEqual(selected['stream_quality'], '720p48')
        self.assertEqual(selected['quality'], '480p')

    def test_discovery_errors_do_not_expose_diagnostics(self):
        failures = [
            subprocess.CalledProcessError(1, ['streamlink'], stderr='secret-signed-url'),
            subprocess.TimeoutExpired(['streamlink'], 90, stderr='secret-signed-url'),
            FileNotFoundError('secret-signed-url'),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                with patch.object(preflight.subprocess, 'run', side_effect=failure):
                    with self.assertRaises(ValueError) as caught:
                        preflight.prepare_rendition(self.env)
                self.assertNotIn('secret-signed-url', str(caught.exception))

    def test_malformed_discovery_is_rejected(self):
        for payload in [None, [], {'error': 'secret-signed-url'}, {},
                        {'streams': []}, {'streams': {}}, {'streams': {'audio_only': {}}}]:
            with self.subTest(payload=payload):
                with self.discover(payload), self.assertRaises(ValueError):
                    preflight.prepare_rendition(self.env)
        with patch.object(preflight.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 0, 'not-json', '')):
            with self.assertRaises(ValueError):
                preflight.prepare_rendition(self.env)

    def test_vod_id_validation_precedes_subprocess(self):
        self.env['VOD_ID'] = '123&streamer_id=neq.target'
        with patch.object(preflight.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                preflight.prepare_rendition(self.env)
        run.assert_not_called()

    def test_main_writes_outputs_only_on_success(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'outputs'
            output.write_text('existing=value\n')
            self.env.update(GITHUB_OUTPUT=str(output), LOCAL='true')
            with patch.dict(os.environ, self.env, clear=True), redirect_stdout(io.StringIO()):
                self.assertEqual(preflight.main(), 0)
            self.assertEqual(output.read_text(), 'existing=value\nstream_quality=480p\n'
                             'quality=480p\nvideo_fps=\navailable=true\n')
            baseline = output.read_text()
            self.env['REQUESTED_QUALITY'] = 'invalid-secret-signed-url'
            error = io.StringIO()
            with patch.dict(os.environ, self.env, clear=True), redirect_stderr(error):
                self.assertEqual(preflight.main(), 1)
            self.assertEqual(output.read_text(), baseline)
            self.assertNotIn('invalid-secret-signed-url', error.getvalue())
            self.assertNotIn('available=false', output.read_text())


if __name__ == '__main__':
    unittest.main()
