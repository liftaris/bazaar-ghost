import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog_youtube as catalog
import platform_discovery as discovery
import platform_ingestion as ingestion


CHANNEL = 'UCeBMccz-PDZf6OB4aV6a3eA'
PAGE = {'channel_id': CHANNEL, 'channel': 'Kripparrian', 'uploader_id': '@Kripparrian',
        'entries': [{'id': 'HklpcveV_4o'}], 'thumbnails': [
            {'id': 'banner_uncropped', 'url': 'https://yt3.googleusercontent.com/banner'},
            {'id': 'avatar_uncropped', 'url': 'https://yt3.googleusercontent.com/avatar'},
        ]}
PROFILE = {'display_name': 'Kripparrian', 'login': 'Kripparrian',
           'avatar_url': 'https://yt3.googleusercontent.com/avatar'}


class YouTubeProfileTests(unittest.TestCase):
    def test_selects_channel_avatar_not_banner_or_recording_thumbnail(self):
        self.assertEqual(catalog.channel_profile(CHANNEL, PAGE), PROFILE)
        page = {**PAGE, 'thumbnails': [{'id': 'banner_uncropped', 'url': 'https://example.com/banner'}]}
        self.assertNotIn('avatar_url', catalog.channel_profile(CHANNEL, page))

    def test_rejects_wrong_channel_and_unsafe_avatar(self):
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            catalog.channel_profile(CHANNEL, {**PAGE, 'channel_id': 'UC' + 'a' * 22})
        for url in ['http://example.com/avatar', 'javascript:alert(1)', 'https://user:secret@example.com/avatar']:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'avatar URL'):
                catalog.channel_profile(CHANNEL, {**PAGE, 'thumbnails': [{'id': 'avatar_uncropped', 'url': url}]})

    def test_single_video_catalog_fetches_channel_profile_for_upsert(self):
        with patch.object(catalog, 'channel_page', return_value=PAGE) as page, \
                patch.object(catalog, 'api', return_value={'id': 'account'}) as api:
            catalog.ensure_account(CHANNEL, 'Older name', preserve_disabled=True)
        page.assert_called_once_with(CHANNEL, 1, 1, 'videos')
        values = api.call_args.kwargs['body']
        self.assertEqual({key: values[key] for key in PROFILE}, PROFILE)
        self.assertNotIn('processing_enabled', values)
        self.assertNotIn('streamer_id', values)
        self.assertNotIn('sfde_profile_id', values)

    def test_enrollment_reuses_authoritative_channel_page(self):
        with patch.object(ingestion, 'channel_page', return_value=PAGE), \
                patch.object(catalog, 'channel_page', side_effect=AssertionError('duplicate extraction')), \
                patch.object(catalog, 'api', return_value={'id': 'account'}) as api:
            ingestion.enroll('youtube', '@Kripparrian')
        self.assertEqual(api.call_args.kwargs['body']['avatar_url'], PROFILE['avatar_url'])

    def test_poll_refreshes_existing_account_under_lease_without_operator_settings(self):
        job = {'source': 'youtube', 'account_id': 'account', 'id': 'job', 'lease_token': 'lease', 'state': {}}
        account = {'id': 'account', 'source_id': CHANNEL, 'processing_enabled': True}
        with patch.object(discovery, 'channel_page', return_value=copy.deepcopy(PAGE)), \
                patch.object(ingestion, 'api', side_effect=lambda path, *args, **kwargs: [account] if path == 'accounts' else True) as api, \
                patch.object(ingestion, 'enqueue'), patch.object(ingestion, 'renew_subscription'):
            result = ingestion.poll_account(job)
        self.assertIsNone(result['error'])
        updates = [call.kwargs['body'] for call in api.call_args_list if call.args[0] == 'accounts/account']
        self.assertEqual(updates, [{**PROFILE, 'job_id': 'job', 'lease_token': 'lease'}] * 2)

    def test_profile_fetch_failure_does_not_overwrite_existing_avatar(self):
        job = {'source': 'youtube', 'account_id': 'account', 'id': 'job', 'lease_token': 'lease', 'state': {}}
        with patch.object(ingestion, 'api', return_value=[{'id': 'account', 'source_id': CHANNEL}]) as api, \
                patch.object(ingestion, 'account_page', side_effect=TimeoutError), \
                patch.object(ingestion, 'renew_subscription'):
            result = ingestion.poll_account(job)
        self.assertIsNotNone(result['error'])
        self.assertEqual(api.call_count, 1)


if __name__ == '__main__':
    unittest.main()
