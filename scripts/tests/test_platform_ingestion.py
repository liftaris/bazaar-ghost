"""Automation contracts: readiness transitions, creator controls, and poll recovery."""

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_ingestion as ingestion
from platform_discovery import bazaar_title
from catalog_youtube import channel_page
from types import SimpleNamespace


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.account = {'id': 'account-1', 'source': 'youtube', 'source_id': 'UC0000000000000000000000',
                        'processing_enabled': True}
        self.job = {'id': 'job-1', 'source': 'youtube', 'kind': 'video', 'source_id': 'YouTube0001',
                    'account_id': 'account-1', 'lease_token': 'lease', 'state': {}}
        self.metadata = {'id': 'YouTube0001', 'channel_id': self.account['source_id'],
                         'title': 'The Bazaar build', 'duration': 3600, 'live_status': 'was_live'}

    def test_live_to_postlive_to_final_only_catalogs_final(self):
        with patch.object(ingestion, 'api', side_effect=lambda path, *a, **kw: [self.account] if path == 'accounts' else True), \
                patch.object(ingestion, 'save_video', return_value={'id': 12}) as save:
            for status in ('is_upcoming', 'is_live', 'post_live', 'was_live'):
                with patch.object(ingestion, 'youtube_metadata', return_value={**self.metadata, 'live_status': status}):
                    result = ingestion.ingest_video(self.job)
                self.assertEqual(result['status'], 'completed' if status == 'was_live' else 'waiting')
                self.assertEqual(save.call_count, int(status == 'was_live'))

    def test_existing_disabled_creator_is_never_reenabled_by_discovery(self):
        job = {**self.job, 'account_id': None}
        with patch.object(ingestion, 'youtube_metadata', return_value=self.metadata), \
                patch.object(ingestion, 'api', side_effect=lambda path, *a, **kw: [{**self.account, 'processing_enabled': False}] if path == 'accounts' else True), \
                patch.object(ingestion, 'youtube_account') as add, patch.object(ingestion, 'save_video') as save:
            self.assertEqual(ingestion.ingest_video(job)['status'], 'skipped')
            add.assert_not_called()
            save.assert_not_called()

    def test_owner_mismatch_never_catalogs_into_another_creator(self):
        with patch.object(ingestion, 'api', return_value=[{**self.account, 'id': 'different-account'}]):
            with self.assertRaisesRegex(ValueError, 'owner'):
                ingestion.verified_account('youtube', self.metadata, self.job)

    def test_new_matching_creator_is_automatically_enabled(self):
        with patch.object(ingestion, 'api', return_value=[]), \
                patch.object(ingestion, 'youtube_account', return_value=self.account) as add:
            ingestion.verified_account('youtube', self.metadata, {**self.job, 'account_id': None})
            self.assertTrue(add.call_args.args[2])

    def test_unrelated_video_does_not_enroll_creator(self):
        with patch.object(ingestion, 'youtube_metadata', return_value={**self.metadata, 'title': 'Other game'}), \
                patch.object(ingestion, 'verified_account') as add:
            self.assertEqual(ingestion.ingest_video(self.job)['status'], 'skipped')
            add.assert_not_called()

    def test_transport_failure_is_propagated_for_durable_retry(self):
        with patch.object(ingestion, 'youtube_metadata', side_effect=TimeoutError), \
                patch.object(ingestion, 'save_video') as save:
            with self.assertRaises(TimeoutError):
                ingestion.ingest_video(self.job)
            save.assert_not_called()

    def test_poll_paginates_until_previous_head_and_commits_only_persisted_ids(self):
        job = {**self.job, 'kind': 'account', 'state': {'videos': {'head': 'previous', 'start': 1}}}
        ids = [f'candidate-{index}' for index in range(20)]
        with patch.object(ingestion, 'api', return_value=[self.account]), \
                patch.object(ingestion, 'account_page', side_effect=[{'ids': ids, 'inspected': 20}, {'ids': [], 'inspected': 0}]), \
                patch.object(ingestion, 'enqueue') as enqueue, patch.object(ingestion, 'renew_subscription'):
            result = ingestion.poll_account(job)
            self.assertEqual(result['state']['videos'], {'head': 'previous', 'scan_head': ids[0], 'start': 21})
            self.assertEqual(result['delay'], 60)
            self.assertEqual(enqueue.call_count, 20)
        with patch.object(ingestion, 'api', return_value=[self.account]), \
                patch.object(ingestion, 'account_page', side_effect=[{'ids': ['previous'], 'inspected': 1}, {'ids': [], 'inspected': 0}]), \
                patch.object(ingestion, 'enqueue'), patch.object(ingestion, 'renew_subscription'):
            result = ingestion.poll_account({**job, 'state': result['state']})
            self.assertEqual(result['state']['videos'], {'head': ids[0], 'start': 1})

    def test_unavailable_playlist_entries_do_not_end_catchup_early(self):
        job = {**self.job, 'kind': 'account', 'state': {'videos': {'head': 'older-head', 'start': 21}}}
        with patch.object(ingestion, 'api', return_value=[self.account]), \
                patch.object(ingestion, 'account_page', side_effect=[{'ids': ['some-video'], 'inspected': 20}, {'ids': [], 'inspected': 0}]), \
                patch.object(ingestion, 'enqueue'), patch.object(ingestion, 'renew_subscription'):
            result = ingestion.poll_account(job)
            self.assertEqual(result['state']['videos']['start'], 41)
            self.assertEqual(result['delay'], 60)

    def test_failed_poll_or_queue_write_retains_cursor(self):
        state = {'videos': {'head': 'old', 'start': 21, 'scan_head': 'new'}}
        job = {**self.job, 'kind': 'account', 'state': state}
        with patch.object(ingestion, 'api', return_value=[self.account]), \
                patch.object(ingestion, 'account_page', side_effect=[{'ids': ['video'], 'inspected': 1}, {'ids': [], 'inspected': 0}]), \
                patch.object(ingestion, 'enqueue', side_effect=TimeoutError), \
                patch.object(ingestion, 'renew_subscription'):
            result = ingestion.poll_account(job)
            self.assertEqual(result['state']['videos'], state['videos'])
            self.assertIsNotNone(result['error'])

    def test_bilibili_multipart_continuation_is_bounded_and_idempotent(self):
        pages = [{'cid': i + 1, 'page': i + 1, 'part': 'The Bazaar', 'duration': 1800} for i in range(25)]
        metadata = {'bvid': 'BV1FfL5zPEbH', 'title': '大巴扎', 'pubdate': 1750000000, 'pages': pages}
        job = {**self.job, 'source': 'bilibili', 'source_id': metadata['bvid']}
        with patch.object(ingestion, 'video_metadata', return_value=metadata), \
                patch.object(ingestion, 'verified_account', return_value=self.account), \
                patch.object(ingestion, 'api', return_value=True), patch.object(ingestion, 'save_video', return_value={'id': 1}) as save:
            result = ingestion.ingest_video(job)
            self.assertEqual(len(result['state']['seen_cids']), 20)
            self.assertEqual(save.call_count, 20)
            metadata['pages'] = list(reversed(metadata['pages']))
            result = ingestion.ingest_video({**job, 'state': result['state']})
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(save.call_count, 25)

    def test_bilibili_short_parts_are_seen_but_not_cataloged(self):
        pages = [{'cid': 1, 'page': 1, 'part': 'P1', 'duration': 180}, {'cid': 2, 'page': 2, 'part': 'P2', 'duration': 300},
                 {'cid': 3, 'page': 3, 'part': 'P3', 'duration': 299}]
        metadata = {'bvid': 'BV1FfL5zPEbH', 'title': '【大巴扎】路线记录合集', 'pubdate': 1750000000, 'pages': pages}
        job = {**self.job, 'source': 'bilibili', 'source_id': metadata['bvid']}
        with patch.object(ingestion, 'video_metadata', return_value=metadata), \
                patch.object(ingestion, 'verified_account', return_value=self.account), \
                patch.object(ingestion, 'api', return_value=True), patch.object(ingestion, 'save_video', return_value={'id': 7}) as save:
            result = ingestion.ingest_video(job)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual([call.args[0]['source_part_id'] for call in save.call_args_list], ['2'])
            metadata['pages'] = [pages[0], pages[2]]
            result = ingestion.ingest_video(job)
            self.assertEqual(result['status'], 'skipped')
            self.assertEqual(result['state']['short_parts'], 2)
            self.assertEqual(save.call_count, 1)

    def test_bilibili_search_markup_does_not_hide_game_evidence(self):
        self.assertTrue(bazaar_title('【<em class="keyword">大巴扎</em>】直播回放'))
        self.assertFalse(bazaar_title('Another game'))

    def test_absent_youtube_tab_is_distinct_from_an_access_failure(self):
        with patch('catalog_youtube.subprocess.run', return_value=SimpleNamespace(
                returncode=1, stderr='ERROR: This channel does not have a streams tab')):
            self.assertTrue(channel_page(self.account['source_id'], 1, 20, 'streams')['tab_absent'])
        with patch('catalog_youtube.subprocess.run', return_value=SimpleNamespace(
                returncode=1, stderr='ERROR: request blocked')):
            with self.assertRaises(RuntimeError):
                channel_page(self.account['source_id'], 1, 20, 'streams')

    def test_subscription_renewal_keeps_capabilities_inside_worker(self):
        with patch.object(ingestion, 'api', return_value={'requested': True}) as api:
            ingestion.renew_subscription(self.account, job=self.job)
            api.assert_called_once_with('subscriptions/renew', body={
                'account_id': self.account['id'], 'job_id': self.job['id'], 'lease_token': 'lease',
            }, method='POST')

    def test_failed_subscription_does_not_discard_poll_progress(self):
        with patch.object(ingestion, 'api', return_value=[self.account]), \
                patch.object(ingestion, 'account_page', return_value={'ids': [], 'inspected': 0}), \
                patch.object(ingestion, 'renew_subscription', side_effect=TimeoutError):
            result = ingestion.poll_account({**self.job, 'kind': 'account'})
            self.assertEqual(result['status'], 'waiting')
            self.assertIn('websub', result['error'])
            self.assertEqual(result['state']['videos']['start'], 1)

    def test_lost_lease_stops_before_catalog_write(self):
        with patch.object(ingestion, 'youtube_metadata', return_value=self.metadata), \
                patch.object(ingestion, 'api', side_effect=[[self.account], False]), \
                patch.object(ingestion, 'save_video') as save:
            with self.assertRaisesRegex(RuntimeError, 'lease'):
                ingestion.ingest_video(self.job)
            save.assert_not_called()

    def test_chinese_youtube_title_reaches_catalog_with_lease(self):
        with patch.object(ingestion, 'youtube_metadata', return_value={**self.metadata, 'title': '大巴扎 最新对局'}), \
                patch.object(ingestion, 'api', side_effect=[[self.account], True]), \
                patch.object(ingestion, 'save_video', return_value={'id': 12}) as save:
            self.assertEqual(ingestion.ingest_video(self.job)['status'], 'completed')
            self.assertEqual(save.call_args.kwargs['job'], self.job)

    def test_discovery_upsert_atomically_preserves_disabled_accounts(self):
        with patch.object(ingestion, 'api', return_value=[]), \
                patch.object(ingestion, 'youtube_account', return_value=self.account) as add:
            ingestion.verified_account('youtube', self.metadata, {**self.job, 'account_id': None})
            self.assertTrue(add.call_args.kwargs['preserve_disabled'])
            self.assertEqual(add.call_args.kwargs['job']['lease_token'], 'lease')

    def test_empty_catalog_initializes_discovery_without_resetting_its_schedule(self):
        with patch.object(ingestion, 'api', side_effect=lambda path, *args, **kwargs: [] if path == 'jobs/claim' else True) as api:
            result = ingestion.run(limit=1, seconds=30, discovery=True)
            self.assertEqual(result['jobs'], 0)
            seeds = [call.kwargs['body'] for call in api.call_args_list if call.args[0] == 'jobs/enqueue']
            self.assertEqual(seeds, [{'source': source, 'kind': 'discovery', 'source_id': 'bazaar',
                                     'account_id': None, 'wake': False} for source in ('youtube', 'bilibili')])
            self.assertEqual(api.call_args_list[2].args[0], 'jobs/claim')

    def test_no_discovery_run_does_not_seed_discovery_jobs(self):
        with patch.object(ingestion, 'api', side_effect=lambda path, *args, **kwargs: [] if path == 'jobs/claim' else True) as api:
            ingestion.run(limit=1, seconds=30, discovery=False)
            self.assertFalse(any(call.args[0] == 'jobs/enqueue' for call in api.call_args_list))


if __name__ == '__main__':
    unittest.main()
