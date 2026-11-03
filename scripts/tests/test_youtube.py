"""YouTube metadata, source identity, and Streamlink-first media contracts."""

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog_youtube import normalize_video, save_video
from media_source import ffmpeg_input_args, resolve_media, watch_url, youtube_id, youtube_metadata


class YouTubeTests(unittest.TestCase):
    def test_extractor_error_explains_access_failure_without_leaking_upstream_secrets(self):
        stderr = "ERROR: Sign in to confirm you’re not a bot. https://media.example/?token=secret Cookie: private"
        with patch('media_source.subprocess.run', return_value=SimpleNamespace(returncode=1, stderr=stderr)):
            with self.assertRaisesRegex(RuntimeError, 'requires human sign-in') as error:
                youtube_metadata('0C6bxQsDj-s')
        self.assertNotIn('secret', str(error.exception))
        self.assertNotIn('private', str(error.exception))
        self.assertNotIn('https://', str(error.exception))

    def metadata(self, **values):
        return {'id': '0C6bxQsDj-s', 'title': 'A build - The Bazaar', 'duration': 2718,
                'upload_date': '20260906', 'live_status': 'not_live', **values}

    def test_youtube_links_preserve_case_and_scope(self):
        for url in ['0C6bxQsDj-s', 'https://youtu.be/0C6bxQsDj-s?t=14',
                    'https://www.youtube.com/watch?v=0C6bxQsDj-s', 'https://youtube.com/live/0C6bxQsDj-s']:
            self.assertEqual(youtube_id(url), '0C6bxQsDj-s')
        self.assertEqual(watch_url('youtube', '0C6bxQsDj-s', 14), 'https://www.youtube.com/watch?v=0C6bxQsDj-s&t=14s')
        for bad in ['https://youtube.com.evil.test/watch?v=0C6bxQsDj-s', 'https://localhost/watch?v=0C6bxQsDj-s',
                    'https://youtube.com/watch?v=bad', 'file:///tmp/video', 'https://user:pw@youtube.com/watch?v=0C6bxQsDj-s']:
            with self.assertRaises(ValueError):
                youtube_id(bad)

    def test_backlog_does_not_invent_recorded_time_or_notifications(self):
        row = normalize_video(self.metadata(upload_date='20250210'))
        self.assertEqual(row['content_kind'], 'upload')
        self.assertEqual(row['bazaar_chapters'], [0, 2718])
        self.assertIsNone(row['recorded_at'])
        self.assertEqual(row['template_version'], 'auto')
        self.assertFalse(row['notifications_enabled'])

    def test_archive_and_explicit_historical_template(self):
        row = normalize_video(self.metadata(live_status='was_live'), template_version='old',
                              recorded_at='2025-02-09T00:00:00Z', chapters=[600, 900])
        self.assertEqual(row['content_kind'], 'archive')
        self.assertEqual(row['template_version'], 'old')
        self.assertEqual(row['bazaar_chapters'], [600, 900])

    def test_live_and_unready_recordings_never_create_work(self):
        for status in ('is_live', 'is_upcoming', 'post_live'):
            with self.assertRaises(ValueError):
                normalize_video(self.metadata(live_status=status))
        for duration in (None, 0, -1, float('inf'), float('nan'), True):
            with self.assertRaises(ValueError):
                normalize_video(self.metadata(duration=duration))

    def test_ranges_and_game_evidence_are_required(self):
        with self.assertRaises(ValueError):
            normalize_video(self.metadata(title='My Guildrun build', description='Watch my Bazaar guide'))
        self.assertTrue(normalize_video(self.metadata(title='Build'), assume_bazaar=True)['ready_for_processing'])
        for ranges in ([0, 5000], [0], [], [10, 5], [-1, 100], [False, 10]):
            with self.assertRaises(ValueError):
                normalize_video(self.metadata(), chapters=ranges)

    def test_streamlink_remains_first_at_requested_resolution(self):
        data = {'streams': {'480p': {'type': 'http', 'url': 'https://cdn.example/video.mp4',
                                    'headers': {'User-Agent': 'test', 'Authorization': 'not-forwarded'}},
                            'best': {'type': 'http', 'url': 'https://cdn.example/video.mp4'}}}
        with patch('media_source.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(data))) as run:
            with patch('media_source.youtube_metadata') as fallback:
                media = resolve_media('youtube', '0C6bxQsDj-s', '480p')
                self.assertEqual(media['resolver'], 'streamlink')
                self.assertEqual(media['height'], 480)
                self.assertEqual(ffmpeg_input_args(media), ['-headers', 'User-Agent: test\r\n'])
                fallback.assert_not_called()
                self.assertEqual(run.call_args.args[0][0], 'streamlink')

    def test_low_resolution_streamlink_falls_back_to_native_resolution(self):
        data = {'streams': {'360p': {'type': 'http', 'url': 'https://cdn.example/low'}}}
        formats = [{'url': 'https://cdn.example/native', 'vcodec': 'avc', 'height': 480, 'protocol': 'https'}]
        with patch('media_source.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(data))), \
                patch('media_source.youtube_metadata', return_value=self.metadata(formats=formats)):
            media = resolve_media('youtube', '0C6bxQsDj-s')
        self.assertEqual(media['height'], 480)
        self.assertEqual(media['resolver'], 'yt-dlp')
        self.assertTrue(media['progressive'])

    def test_metadata_uses_configured_cookie_jar_without_downloading(self):
        with patch.dict('os.environ', {'YOUTUBE_COOKIES_FILE': '/private/cookies.txt'}), \
                patch('media_source.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(self.metadata()))) as run:
            youtube_metadata('0C6bxQsDj-s')
        command = run.call_args.args[0]
        self.assertIn('--skip-download', command)
        self.assertEqual(command[command.index('--cookies') + 1], '/private/cookies.txt')

    def test_fallback_is_youtube_only_and_ignores_audio_and_drm(self):
        with patch('media_source.subprocess.run', return_value=SimpleNamespace(returncode=1, stdout='')):
            with patch('media_source.youtube_metadata', return_value=self.metadata(formats=[
                {'url': 'https://cdn.example/audio', 'vcodec': 'none', 'height': 480, 'protocol': 'https'},
                {'url': 'https://cdn.example/drm', 'vcodec': 'avc', 'height': 480, 'protocol': 'https', 'has_drm': True},
                {'url': 'https://cdn.example/video', 'vcodec': 'avc', 'height': 720, 'fps': 60, 'protocol': 'https'},
            ])):
                media = resolve_media('youtube', '0C6bxQsDj-s')
                self.assertEqual(media['resolver'], 'yt-dlp')
                self.assertEqual(media['url'], 'https://cdn.example/video')
                with self.assertRaises(RuntimeError):
                    resolve_media('twitch', '123')

    def test_twitch_explicit_high_fps_preference_is_preserved(self):
        streams = {name: {'type': 'hls', 'url': f'https://cdn.example/{name}.m3u8'}
                   for name in ('480p', '480p60')}
        with patch('media_source.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'streams': streams}))):
            self.assertEqual(resolve_media('twitch', '123', '480p60')['fps'], 60)
            self.assertIsNone(resolve_media('twitch', '123', '480p')['fps'])

    def test_revision_rejection_is_not_hidden_or_retried_as_unconditional_patch(self):
        with patch('video_catalog.api', side_effect=RuntimeError('Catalog POST videos failed: HTTP 409')) as api:
            with self.assertRaisesRegex(RuntimeError, '409'):
                save_video(normalize_video(self.metadata()), {'id': 'account'})
            self.assertEqual(api.call_count, 1)

    def test_explicit_ranges_and_attempt_identity_reach_atomic_catalog_operation(self):
        job = {'id': 'job', 'lease_token': 'token'}
        video = normalize_video(self.metadata(), chapters=[600, 900], template_version='old')
        with patch('video_catalog.api', return_value={'id': 12}) as api:
            self.assertEqual(save_video(video, {'id': 'account'}, explicit_ranges=True, job=job), {'id': 12})
            self.assertEqual(api.call_args.args, ('videos',))
            self.assertEqual(api.call_args.kwargs['body'], {'video': video, 'account_id': 'account',
                            'explicit_ranges': True, 'job_id': 'job', 'lease_token': 'token'})

    def test_chinese_and_html_evidence_matches_discovery(self):
        for title in ('大巴扎 最新对局', '【<em>大巴扎</em>】直播回放'):
            self.assertTrue(normalize_video(self.metadata(title=title))['ready_for_processing'])


if __name__ == '__main__':
    unittest.main()
