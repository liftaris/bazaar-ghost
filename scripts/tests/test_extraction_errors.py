"""Provider diagnostics survive durable retries without exposing upstream secrets."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import traceback
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_ingestion as ingestion
from catalog_youtube import channel_page
from platform_discovery import bilibili_api, extract_page
import bilibili_source
from bilibili_source import public_api
from extraction_errors import ExtractionError, extraction_error, safe_error_category
from media_source import extraction_failure, youtube_metadata


SECRET = 'do-not-publish-credential'
PRIVATE_CONTEXT = f'https://private.example/watch?token={SECRET} Cookie: {SECRET}'
CHANNEL = 'UC0000000000000000000000'


class ExtractionDiagnosticTests(unittest.TestCase):
    def assert_private(self, error):
        rendered = ''.join(traceback.format_exception(error))
        for private in (SECRET, 'private.example', 'https://', 'Cookie:'):
            self.assertNotIn(private, str(error))
            self.assertNotIn(private, rendered)

    def test_constant_categories_cover_real_feed_blocks_without_inventing_http_or_auth_status(self):
        cases = (
            ('Request is blocked by server (412), please wait and try later.', 'http_412'),
            ('Request is rejected by server (352)', 'provider_feed_rejected'),
            ('Request is blocked by server (401)', 'provider_feed_rejected'),
            ('HTTP Error 403: Forbidden', 'http_403'),
            ('HTTP Error 429: Too Many Requests', 'http_429'),
            ('HTTP Error 412: Precondition Failed', 'http_412'),
            ('Sign in to confirm you’re not a bot', 'auth_required'),
            ('Complete CAPTCHA verification', 'provider_challenge'),
            ('No supported JavaScript runtime', 'runtime_unavailable'),
            ('Signature extraction failed', 'player_challenge'),
            ('TypeError: failed to read response', 'extractor_runtime_failure'),
            ('Something not recognized', 'extractor_failure'),
        )
        for stderr, category in cases:
            with self.subTest(category=category, stderr=stderr):
                error = extraction_error(stderr + ' ' + PRIVATE_CONTEXT)
                self.assertEqual(error.category, category)
                self.assertEqual(safe_error_category(error), category)
                self.assertEqual(extraction_failure(stderr + ' ' + PRIVATE_CONTEXT), str(error))
                self.assert_private(error)

    def test_all_extractor_boundaries_keep_categories_and_suppress_raw_timeout_context(self):
        calls = (
            lambda: youtube_metadata('0C6bxQsDj-s'),
            lambda: channel_page(CHANNEL, 1, 20, 'videos'),
            lambda: extract_page('https://space.bilibili.com/2561817/video'),
        )
        for call in calls:
            with self.subTest(boundary=call):
                with patch('subprocess.run', return_value=SimpleNamespace(
                        returncode=1, stderr='HTTP Error 412 ' + PRIVATE_CONTEXT)):
                    with self.assertRaises(ExtractionError) as caught:
                        call()
                    self.assertEqual(caught.exception.category, 'http_412')
                    self.assert_private(caught.exception)
                with patch('subprocess.run', side_effect=subprocess.TimeoutExpired(
                        ['yt-dlp', PRIVATE_CONTEXT], 180, stderr=PRIVATE_CONTEXT)):
                    with self.assertRaises(ExtractionError) as caught:
                        call()
                    self.assertEqual(caught.exception.category, 'transport_timeout')
                    self.assert_private(caught.exception)
                with patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=PRIVATE_CONTEXT)):
                    with self.assertRaises(ExtractionError) as caught:
                        call()
                    self.assertEqual(caught.exception.category, 'invalid_response')
                    self.assert_private(caught.exception)
                with patch('subprocess.run', side_effect=UnicodeDecodeError(
                        'utf-8', PRIVATE_CONTEXT.encode(), 0, 1, PRIVATE_CONTEXT)):
                    with self.assertRaises(ExtractionError) as caught:
                        call()
                    self.assertEqual(caught.exception.category, 'invalid_response')
                    self.assert_private(caught.exception)

    def test_public_api_boundaries_sanitize_http_and_arbitrary_json_error_values(self):
        calls = (
            ('card', lambda: bilibili_api('/x/web-interface/card', {'mid': '2561817'})),
            ('view', lambda: public_api('/x/web-interface/view', {'bvid': 'BV1FfL5zPEbH'})),
        )
        client = bilibili_source.CLIENT
        for target, call in calls:
            with self.subTest(boundary=target), patch.object(client, '_sleep'), \
                    patch.object(client, '_cookie', 'buvid3=fixture'), patch.object(client, '_last', {}):
                opener = SimpleNamespace(open=Mock(side_effect=HTTPError(PRIVATE_CONTEXT, 403, PRIVATE_CONTEXT, {}, None)))
                with patch.object(client, '_opener', opener):
                    with self.assertRaises(ExtractionError) as caught:
                        call()
                    self.assertEqual(caught.exception.category, 'http_403')
                    self.assert_private(caught.exception)
                for code, category in ((-352, 'provider_feed_rejected'), (-401, 'provider_feed_rejected'),
                                       (PRIVATE_CONTEXT, 'provider_api_rejected')):
                    body = json.dumps({'code': code, 'message': PRIVATE_CONTEXT}).encode()
                    opener = SimpleNamespace(open=Mock(side_effect=lambda *args, **kwargs: io.BytesIO(body)))
                    with patch.object(client, '_opener', opener):
                        with self.assertRaises(ExtractionError) as caught:
                            call()
                        self.assertEqual(caught.exception.category, category)
                        self.assert_private(caught.exception)

    def test_untyped_exceptions_never_have_their_messages_classified_or_reflected(self):
        self.assertEqual(safe_error_category(RuntimeError(PRIVATE_CONTEXT)), 'runtime_failure')
        self.assertEqual(safe_error_category(ValueError(PRIVATE_CONTEXT)), 'invalid_data')
        error = HTTPError(PRIVATE_CONTEXT, 429, PRIVATE_CONTEXT, {}, None)
        self.assertEqual(safe_error_category(error), 'http_429')
        self.assertTrue(error.closed)
        with self.assertRaisesRegex(ValueError, '^Unknown extraction error category$'):
            ExtractionError(PRIVATE_CONTEXT)

    def test_failed_account_poll_persists_safe_cause_without_advancing_cursor_then_recovers(self):
        state = {'videos': {'head': 'BV1FfL5zPEbH', 'scan_head': 'BV1cqW2zYEZx', 'start': 21}}
        job = {'id': 'job', 'source': 'bilibili', 'kind': 'account', 'source_id': '2561817',
               'account_id': 'account', 'lease_token': 'lease', 'state': state, 'attempts': 3}
        account = {'id': 'account', 'source': 'bilibili', 'source_id': '2561817'}
        responses = (
            (ExtractionError('http_412'), 'http_412', 3600, state),
            ({'archives': [{'bvid': 'BV1FfL5zPEbH'}]}, None, 900, {'videos': {'head': 'BV1cqW2zYEZx', 'start': 1}}),
        )
        for response, category, delay, expected_state in responses:
            with self.subTest(category=category):
                output = io.StringIO()
                def api(path, *args, **kwargs):
                    return [job] if path == 'jobs/claim' else [account] if path == 'accounts' else True
                listing = {'side_effect': response} if isinstance(response, Exception) else {'return_value': response}
                with patch.object(ingestion, 'api', side_effect=api) as backend, \
                        patch('platform_discovery.public_api', **listing), redirect_stdout(output):
                    summary = ingestion.run(1, 30, discovery=False, dispatch=False)
                finished = next(c.kwargs['body'] for c in backend.call_args_list if c.args[0] == 'jobs/finish')
                self.assertEqual(finished['state'], expected_state)
                self.assertEqual(finished['status'], 'waiting')
                self.assertEqual(finished['delay_seconds'], delay)
                self.assertEqual(summary['errors'], int(category is not None))
                event = json.loads(output.getvalue())
                self.assertEqual(event['error_categories'], [category] if category else [])
                self.assertEqual(event['error'], finished['error'])
                if category:
                    self.assertEqual(finished['error'], 'videos: http_412; public catalog unavailable')
                    self.assertFalse(any(c.args[0] == 'jobs/enqueue' for c in backend.call_args_list))
                else:
                    self.assertIsNone(finished['error'])
                for private in (SECRET, 'private.example', 'https://', 'Cookie:'):
                    self.assertNotIn(private, output.getvalue())
                    self.assertNotIn(private, json.dumps(finished))
        self.assertEqual(job['state'], state)

    def test_video_failure_retains_candidate_state_and_runner_continues_next_job(self):
        failed = {'id': 'failed', 'source': 'bilibili', 'kind': 'video', 'source_id': 'BV1FfL5zPEbH',
                  'lease_token': 'lease', 'state': {'seen_cids': ['123']}, 'attempts': 2}
        healthy = {**failed, 'id': 'healthy', 'state': {}}
        queue = iter(([failed], [healthy]))
        def api(path, *args, **kwargs):
            return next(queue) if path == 'jobs/claim' else True
        output = io.StringIO()
        with patch.object(ingestion, 'api', side_effect=api) as backend, \
                patch.object(ingestion, 'handle_job', side_effect=[
                    extraction_error('Request is rejected by server (352) ' + PRIVATE_CONTEXT),
                    {'status': 'completed', 'vod_ids': [3], 'state': {}}]), redirect_stdout(output):
            summary = ingestion.run(2, 30, discovery=False)
        finished = [c.kwargs['body'] for c in backend.call_args_list if c.args[0] == 'jobs/finish']
        self.assertEqual(finished[0]['state'], {'seen_cids': ['123']})
        self.assertEqual(finished[0]['status'], 'waiting')
        self.assertEqual(finished[0]['delay_seconds'], 1200)
        self.assertEqual(finished[0]['error'], 'provider_feed_rejected: ingestion failed; retry scheduled')
        self.assertEqual(finished[1]['status'], 'completed')
        self.assertEqual(summary, {'jobs': 2, 'errors': 1, 'cataloged': 1, 'dispatched': 0})
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[0]['error_categories'], ['provider_feed_rejected'])
        self.assertEqual(events[1]['error_categories'], [])
        self.assertNotIn(SECRET, output.getvalue())


if __name__ == '__main__':
    unittest.main()
