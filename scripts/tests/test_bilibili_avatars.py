"""Provider avatars reach catalog writes without changing operator settings."""

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog_bilibili import avatar_url, ensure_account
from platform_ingestion import enroll, verified_account
from backfill_bilibili_avatars import refresh, existing_uids

FACE = 'https://i2.hdslb.com/bfs/face/avatar.jpg'
OWNER = {'mid': 123, 'name': 'Creator', 'face': FACE}


class AvatarTests(unittest.TestCase):
    def test_bulk_inventory_is_validation_only_and_uses_all_accounts(self):
        with patch('backfill_bilibili_avatars.command', return_value=['cf', 'd1']) as command, \
                patch('backfill_bilibili_avatars.subprocess.check_output', return_value='[{"results":{"columns":["source_id"],"rows":[["123"],["456"]]}}]'):
            self.assertEqual(existing_uids('validation'), ['123', '456'])
            command.assert_called_once()
            for environment in ('production', 'dev', 'local'):
                with self.assertRaises(ValueError):
                    existing_uids(environment)

    def test_provider_url_variants_and_missing_face(self):
        for value in (FACE, FACE.replace('https:', 'http:'), FACE.removeprefix('https:')):
            self.assertEqual(avatar_url(value), FACE)
        for value in (None, '', ' ', False):
            self.assertIsNone(avatar_url(value))
        for value in ('javascript:alert(1)', 'https://i2.hdslb.com.evil/bfs/face/a',
                      'https://user@i2.hdslb.com/bfs/face/a'):
            with self.assertRaises(ValueError):
                avatar_url(value)

    def test_enrollment_and_discovery_preserve_face_and_operator_independence(self):
        with patch('platform_ingestion.bilibili_api', return_value={'card': OWNER}), \
                patch('catalog_bilibili.api', return_value={'id': 'account'}) as api:
            enroll('bilibili', '123')
            self.assertEqual(api.call_args.kwargs['body']['avatar_url'], FACE)
            api.reset_mock()
            with patch('platform_ingestion.api', return_value=[{'id': 'account'}]):
                verified_account('bilibili', {'owner': OWNER},
                                 {'id': 'job', 'lease_token': 'token', 'account_id': 'account'})
            body = api.call_args.kwargs['body']
            self.assertEqual(body['avatar_url'], FACE)
            self.assertEqual(body['job_id'], 'job')
            for key in ('processing_enabled', 'sfde_profile_id', 'streamer_id'):
                self.assertNotIn(key, body)

    def test_missing_provider_face_is_omitted(self):
        with patch('catalog_bilibili.api') as api:
            ensure_account({'mid': 123, 'name': 'Creator'}, False, None, None)
            self.assertNotIn('avatar_url', api.call_args.kwargs['body'])

    def test_backfill_is_avatar_only_and_repeatable(self):
        account = {'id': 'account', 'avatar_url': None}
        def catalog(path, *args, **kwargs):
            if path == 'accounts':
                return [account]
            self.assertEqual(kwargs, {'body': {'avatar_url': FACE}, 'method': 'PATCH'})
            account.update(kwargs['body'])
            return account
        with patch('backfill_bilibili_avatars.api', side_effect=catalog) as api, \
                patch('backfill_bilibili_avatars.bilibili_api', return_value={'card': OWNER}):
            self.assertEqual(refresh('123')['status'], 'pending')
            self.assertIsNone(account['avatar_url'])
            self.assertEqual(refresh('123', True)['status'], 'updated')
            self.assertEqual(refresh('123', True)['status'], 'unchanged')
            self.assertEqual(sum(c.kwargs.get('method') == 'PATCH' for c in api.call_args_list), 1)
            with patch('backfill_bilibili_avatars.bilibili_api', return_value={'card': {'mid': 123}}):
                self.assertEqual(refresh('123', True)['status'], 'missing')
                self.assertEqual(account['avatar_url'], FACE)
