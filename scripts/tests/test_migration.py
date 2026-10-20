import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scripts.migration.convert', Path(__file__).resolve().parents[1] / 'migration' / 'convert.py')
conversion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conversion)


class MigrationTests(unittest.TestCase):
    def test_snapshot_roundtrip_preserves_ids_and_does_not_replay_notifications(self):
        with tempfile.TemporaryDirectory() as root:
            source, dest = Path(root) / 'source', Path(root) / 'output'
            source.mkdir()
            records = {
                'sfde_profiles': [{'id': 1, 'profile_name': 'default', 'crop_region': [0, 0, 1, 1]}],
                'streamers': [{'id': 1, 'login': 'example', 'processing_enabled': True}],
                'vods': [{'id': 1, 'streamer_id': 1, 'source_id': '123', 'duration_seconds': 12, 'bazaar_chapters': [0, 12], 'status': 'completed'}],
                'chunks': [{'id': 'chunk', 'vod_id': 1, 'start_seconds': 0, 'end_seconds': 12, 'chunk_index': 0, 'status': 'completed'}],
                'detections': [{'id': 'detection', 'chunk_id': 'chunk', 'vod_id': 1, 'username': "O'Connor", 'frame_time_seconds': 0, 'confidence': .95, 'igd': 9, 'storage_path': '/detections/123/0.jpg'}],
            }
            for table in conversion.TABLES:
                (source / (table + '.jsonl')).write_text(''.join(json.dumps(r) + '\n' for r in records.get(table, [])))
            conversion.convert(source, dest)
            restored = sqlite3.connect(':memory:')
            self.addCleanup(restored.close)
            restored.execute('PRAGMA foreign_keys=ON')
            conversion.apply_schema(restored, conversion.TARGET_SCHEMA_VERSION)
            restored.executescript((dest / 'import.sql').read_text())
            self.assertEqual(restored.execute('SELECT username,igd FROM detections').fetchone(), ("O'Connor", 9))
            self.assertTrue(restored.execute('SELECT sent_at FROM notification_outbox').fetchone()[0])
            self.assertEqual(restored.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(restored.execute('SELECT status FROM vods').fetchone()[0], 'completed')

    def test_trigrams_match_worker_word_padding(self):
        self.assertEqual(conversion.trigrams('CAT-cat'), ['  c', ' ca', 'at ', 'cat'])
        self.assertEqual(conversion.trigrams('é'), ['  é', ' é '])


class MultiplatformMigrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source, self.destination = Path(self.directory.name) / 'source', Path(self.directory.name) / 'converted'
        self.source.mkdir()

    def snapshot(self, records, absent=(), manifest=True):
        tables = {}
        for table in conversion.TABLES:
            if table in absent:
                tables[table] = {'status': 'absent', 'count': 0, 'reason': 'source schema predates table'}
                continue
            values = records.get(table, [])
            (self.source / f'{table}.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in values))
            tables[table] = {'status': 'present', 'count': len(values)}
        if manifest:
            (self.source / 'manifest.json').write_text(json.dumps({'format_version': 2, 'complete': True, 'tables': tables}))

    def restore(self):
        conversion.convert(self.source, self.destination)
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        conversion.apply_schema(db, conversion.TARGET_SCHEMA_VERSION)
        for part in sorted(self.destination.glob('import-*.sql')):
            db.executescript(part.read_text())
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        return db

    def records(self):
        return {
            'sfde_profiles': [{'id': 1, 'profile_name': 'default', 'crop_region': [0, 0, 1, 1], 'igd_crop_region': [0, 0, .1, .1]}],
            'streamers': [{'id': 1, 'login': 'original', 'sfot_profile_id': 1}],
            'platform_accounts': [
                {'id': 'account-youtube', 'source': 'youtube', 'source_id': 'UCAAAAAAAAAAAAAAAAAAAAAA', 'display_name': 'YouTube creator', 'processing_enabled': True, 'catalog_cursor': 7},
                {'id': 'account-bilibili', 'source': 'bilibili', 'source_id': '123', 'display_name': 'Bilibili creator', 'processing_enabled': False, 'archive_cursor': 4},
            ],
            'vods': [
                {'id': 1, 'streamer_id': 1, 'source': 'twitch', 'source_id': '12345678901', 'duration_seconds': 12, 'bazaar_chapters': [0, 12], 'status': 'completed'},
                {'id': 2, 'source': 'youtube', 'source_id': '12345678901', 'platform_account_id': 'account-youtube', 'duration_seconds': 12, 'bazaar_chapters': [0, 12], 'status': 'completed', 'recorded_at': '2025-08-12T03:00:00+05:00', 'published_at': '2026-09-01T08:00:00-07:00'},
                {'id': 3, 'source': 'bilibili', 'source_id': 'BV1234567890:111', 'source_video_id': 'BV1234567890', 'source_part_id': '111', 'source_part_index': 2, 'platform_account_id': 'account-bilibili', 'duration_seconds': 12, 'bazaar_chapters': [0, 12], 'status': 'completed'},
                {'id': 4, 'source': 'bilibili', 'source_id': 'BV1234567890:222', 'source_video_id': 'BV1234567890', 'source_part_id': '222', 'source_part_index': 1, 'platform_account_id': 'account-bilibili', 'duration_seconds': 12, 'bazaar_chapters': [0, 12], 'status': 'completed'},
            ],
            'chunks': [{'id': f'chunk-{i}', 'vod_id': i, 'start_seconds': 0, 'end_seconds': 12, 'chunk_index': 0, 'status': 'completed'} for i in range(1, 5)],
            'detections': [{'id': f'detection-{i}', 'chunk_id': f'chunk-{i}', 'vod_id': i, 'username': "Player's name", 'frame_time_seconds': 2, 'confidence': .97, 'igd': 9, 'storage_path': f'source/{i}/frame.jpg'} for i in range(1, 5)],
            'matchup_groups': [{'id': 'group', 'evidence': 'Same recording verified from the original timestamps.'}],
            'matchup_appearances': [{'matchup_id': 'group', 'detection_id': f'detection-{i}'} for i in (1, 2)],
            'matchup_review_events': [{'id': 'review', 'matchup_id': 'group', 'action': 'link', 'detection_ids': ['detection-1', 'detection-2'], 'evidence': 'Reviewed recording timestamps.'}],
            'platform_ingestion_jobs': [{'id': 'job', 'source': 'youtube', 'kind': 'account', 'source_id': 'UCAAAAAAAAAAAAAAAAAAAAAA', 'account_id': 'account-youtube', 'status': 'waiting', 'next_attempt_at': '2026-09-08T08:00:00-07:00', 'state': {'archive_cursor': 7}, 'attempts': 2}],
            'youtube_websub_subscriptions': [{'account_id': 'account-youtube', 'callback_token': 'a' * 64, 'secret': 'b' * 64, 'requested_at': '2026-09-07T01:00:00Z', 'confirmed_at': '2026-09-07T01:00:00Z', 'lease_expires_at': '2026-09-17T01:00:00Z'}],
            'youtube_websub_deliveries': [{'account_id': 'account-youtube', 'body_sha256': 'c' * 64}],
            'notification_outbox': [{'detection_id': 'detection-1', 'sent_at': None}],
            'notification_deliveries': [{'detection_id': 'detection-1', 'destination': 'user:123', 'sent_at': '2026-09-07T01:00:00Z'}],
            'chat_mentions': [{'id': 'chat', 'vod_id': 1, 'message': 'bazaarghost', 'offset_seconds': 1}],
        }

    def test_populated_platform_roundtrip_preserves_history_rotates_capabilities_and_normalizes_times(self):
        self.snapshot(self.records())
        restored = self.restore()
        self.assertEqual(restored.execute('SELECT id,source,source_id FROM vods ORDER BY id').fetchall(), [
            (1, 'twitch', '12345678901'), (2, 'youtube', '12345678901'), (3, 'bilibili', 'BV1234567890:111'), (4, 'bilibili', 'BV1234567890:222')])
        self.assertEqual(restored.execute('SELECT recorded_at,published_at FROM vods WHERE id=2').fetchone(), ('2025-08-11T22:00:00.000Z', '2026-09-01T15:00:00.000Z'))
        self.assertEqual(restored.execute('SELECT old_templates FROM vod_processing_context WHERE id=2').fetchone()[0], 1)
        self.assertEqual(restored.execute('SELECT source_part_id,source_part_index FROM vods WHERE source=\'bilibili\' ORDER BY id').fetchall(), [('111', 2), ('222', 1)])
        self.assertEqual(restored.execute('SELECT count(*),count(DISTINCT matchup_id) FROM matchup_appearances').fetchone(), (2, 1))
        self.assertEqual(json.loads(restored.execute('SELECT state FROM platform_ingestion_jobs').fetchone()[0]), {'archive_cursor': 7})
        self.assertEqual(restored.execute('SELECT status,attempts,next_attempt_at FROM platform_ingestion_jobs').fetchone(), ('waiting', 2, '2026-09-08T15:00:00.000Z'))
        sub = restored.execute('SELECT callback_token,secret,requested_at,confirmed_at,lease_expires_at FROM youtube_websub_subscriptions').fetchone()
        self.assertEqual([len(sub[0]), len(sub[1])], [64, 64])
        self.assertNotIn('a' * 64, sub)
        self.assertNotIn('b' * 64, sub)
        self.assertEqual(sub[2:], (None, None, None))
        self.assertEqual(restored.execute('SELECT body_sha256 FROM youtube_websub_deliveries').fetchone()[0], 'c' * 64)
        self.assertEqual(restored.execute('SELECT count(*) FROM notification_outbox WHERE sent_at IS NULL').fetchone()[0], 0)
        self.assertEqual(restored.execute('SELECT count(*) FROM notification_deliveries').fetchone()[0], 1)
        self.assertEqual(restored.execute('SELECT count(*) FROM chat_mentions').fetchone()[0], 1)
        self.assertEqual(restored.execute('SELECT count(*) FROM detections WHERE igd=9').fetchone()[0], 4)
        for path in self.destination.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path.name)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('b' * 64, (self.destination / 'import.sql').read_text())
        manifest = json.loads((self.destination / 'manifest.json').read_text())
        self.assertEqual(manifest['schema_version'], 3)
        self.assertEqual(manifest['source_schema_version'], 3)
        self.assertEqual(manifest['target_schema_version'], 11)
        self.assertEqual(len(manifest['migrations']), 3)
        self.assertEqual(len(manifest['target_migrations']), 11)
        self.assertEqual(manifest['target_counts']['platform_ingestion_dispatch'], 0)
        self.assertNotIn('platform_ingestion_dispatch', manifest['input_counts'])
        self.assertNotIn('platform_ingestion_dispatch', manifest['output_counts'])
        self.assertEqual(restored.execute('SELECT count(*) FROM platform_ingestion_dispatch').fetchone()[0], 0)
        self.assertEqual(manifest['target_counts']['clips'], 4)
        self.assertEqual(manifest['target_counts']['app_users'], 0)
        self.assertEqual(restored.execute('SELECT count(*) FROM clips').fetchone()[0], 4)
        self.assertEqual(restored.execute('SELECT revision FROM public_cache_state WHERE id=1').fetchone()[0], 0)
        self.assertEqual(manifest['input_counts']['matchup_appearances'], 2)
        self.assertEqual(manifest['output_counts']['notification_outbox'], 1)

    def test_refuses_active_ingestion_status_and_any_retained_lease(self):
        for active in [{'status': 'processing'}, {'lease_token': 'held'}, {'lease_expires_at': '2000-01-01T00:00:00Z'}]:
            with self.subTest(active=active):
                with tempfile.TemporaryDirectory() as directory:
                    self.source = Path(directory) / 'source'
                    self.source.mkdir()
                    records = self.records()
                    records['platform_ingestion_jobs'][0].update(active)
                    self.snapshot(records)
                    target = Path(directory) / 'output'
                    with self.assertRaisesRegex(ValueError, 'active ingestion lease'):
                        conversion.convert(self.source, target)
                    self.assertFalse((target / 'import.sql').exists())

    def test_absent_platform_tables_require_manifest_evidence(self):
        self.snapshot({}, absent=conversion.OPTIONAL_TABLES, manifest=False)
        with self.assertRaisesRegex(ValueError, 'record optional table absence'):
            conversion.convert(self.source, self.destination)
        self.snapshot({}, absent=conversion.OPTIONAL_TABLES)
        restored = self.restore()
        self.assertEqual(restored.execute('SELECT count(*) FROM platform_accounts').fetchone()[0], 0)
        self.assertEqual(set(json.loads((self.destination / 'manifest.json').read_text())['absent_source_tables']), set(conversion.OPTIONAL_TABLES))

    def test_legacy_count_manifest_declares_old_snapshot_scope(self):
        self.snapshot({}, absent=conversion.OPTIONAL_TABLES, manifest=False)
        (self.source / 'manifest.json').write_text(json.dumps({table: 0 for table in conversion.REQUIRED_TABLES}))
        self.restore()
        self.assertIn('legacy snapshot', json.loads((self.destination / 'manifest.json').read_text())['absent_source_tables']['platform_accounts'])

    def test_refuses_incomplete_or_count_mismatched_manifest(self):
        self.snapshot({})
        manifest = json.loads((self.source / 'manifest.json').read_text())
        manifest['complete'] = False
        (self.source / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            conversion.convert(self.source, self.destination)
        manifest['complete'] = True
        manifest['tables']['sfde_profiles']['count'] = 10
        (self.source / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'count differs'):
            conversion.convert(self.source, self.destination)

    def test_refuses_unknown_columns_and_cross_source_foreign_keys(self):
        records = self.records()
        records['platform_accounts'][0]['unmapped_capability'] = 'must not disappear'
        self.snapshot(records)
        with self.assertRaisesRegex(ValueError, 'Unmapped source columns'):
            conversion.convert(self.source, self.destination)
        self.assertEqual(json.loads((self.destination / 'unmapped-columns.json').read_text()), {'platform_accounts': ['unmapped_capability']})
        self.assertFalse((self.destination / 'import.sql').exists())
        records['platform_accounts'][0].pop('unmapped_capability')
        records['vods'][1]['platform_account_id'] = 'account-bilibili'
        self.snapshot(records)
        with self.assertRaisesRegex(ValueError, 'FOREIGN KEY'):
            conversion.convert(self.source, self.destination.with_name('other'))

    def test_import_refuses_nonempty_target_before_dropping_triggers(self):
        self.snapshot(self.records())
        restored = self.restore()
        triggers = restored.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall()
        with self.assertRaises(sqlite3.IntegrityError):
            restored.executescript((self.destination / 'import.sql').read_text())
        self.assertEqual(restored.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall(), triggers)
        self.assertEqual(restored.execute('SELECT count(*) FROM vods').fetchone()[0], 4)

    def test_full_target_refuses_existing_auth_or_moderation_and_uninitialized_cache(self):
        self.snapshot(self.records())
        conversion.convert(self.source, self.destination)
        for occupied in [
            "INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES('existing','Existing','existing@test.invalid',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
            "INSERT INTO auth_verifications(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES('existing','private','private','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
            "INSERT INTO social_moderation_audit(request_id,target_type,target_id,action,reason) VALUES('existing','user','old-user','suspended','History must survive')",
            "DELETE FROM public_cache_state",
            "UPDATE public_cache_state SET revision=1",
        ]:
            with self.subTest(occupied=occupied):
                target = sqlite3.connect(':memory:')
                self.addCleanup(target.close)
                conversion.apply_schema(target, conversion.TARGET_SCHEMA_VERSION)
                target.execute(occupied)
                before = target.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall()
                with self.assertRaises(sqlite3.IntegrityError):
                    target.executescript((self.destination / 'import.sql').read_text())
                self.assertEqual(target.execute('SELECT count(*) FROM vods').fetchone()[0], 0)
                self.assertEqual(target.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall(), before)

    def test_old_target_schema_is_refused_and_source_auth_is_not_accepted(self):
        self.snapshot(self.records())
        conversion.convert(self.source, self.destination)
        target = sqlite3.connect(':memory:')
        self.addCleanup(target.close)
        conversion.apply_schema(target)
        before = target.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall()
        with self.assertRaises(sqlite3.OperationalError):
            target.executescript((self.destination / 'import.sql').read_text())
        self.assertEqual(target.execute('SELECT count(*) FROM vods').fetchone()[0], 0)
        self.assertEqual(target.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall(), before)
        (self.source / 'app_users.jsonl').write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'Unsupported snapshot tables'):
            conversion.convert(self.source, self.destination.with_name('source-auth-refused'))

    def test_source_dispatch_tickets_are_not_accepted(self):
        self.snapshot(self.records())
        (self.source / 'platform_ingestion_dispatch.jsonl').write_text(
            json.dumps({'id': 1, 'state': 'queued', 'ticket_id': 'old-environment-ticket'}) + '\n')
        with self.assertRaisesRegex(ValueError, 'Unsupported snapshot tables'):
            conversion.convert(self.source, self.destination)
        self.assertFalse(self.destination.exists())

    def test_import_refuses_dispatch_state_without_changing_ownership_or_triggers(self):
        self.snapshot(self.records())
        conversion.convert(self.source, self.destination)
        for state in ('idle', 'queued', 'running'):
            with self.subTest(state=state):
                target = sqlite3.connect(':memory:')
                self.addCleanup(target.close)
                conversion.apply_schema(target, conversion.TARGET_SCHEMA_VERSION)
                self.assertEqual(target.execute('SELECT count(*) FROM platform_ingestion_dispatch').fetchone()[0], 0)
                target.execute('''INSERT INTO platform_ingestion_dispatch
                    (id,ticket_id,state,lease_expires_at,next_attempt_at,last_attempt_at,run_id,run_attempt)
                    VALUES(1,?,?,?,?,?,?,?)''', (
                        'old-environment-ticket', state, None if state == 'idle' else '2099-01-01T00:00:00.000Z',
                        '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z',
                        '123456' if state == 'running' else None, '1' if state == 'running' else None))
                owner = target.execute('SELECT * FROM platform_ingestion_dispatch').fetchall()
                triggers = target.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall()
                with self.assertRaises(sqlite3.IntegrityError):
                    target.executescript((self.destination / 'import.sql').read_text())
                self.assertEqual(target.execute('SELECT * FROM platform_ingestion_dispatch').fetchall(), owner)
                self.assertEqual(target.execute('SELECT count(*) FROM vods').fetchone()[0], 0)
                self.assertEqual(target.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall(), triggers)
                self.assertEqual(target.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_schema_six_target_is_refused_before_any_import_changes(self):
        self.snapshot(self.records())
        conversion.convert(self.source, self.destination)
        target = sqlite3.connect(':memory:')
        self.addCleanup(target.close)
        conversion.apply_schema(target, 6)
        before = target.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall()
        with self.assertRaisesRegex(sqlite3.OperationalError, 'no such table'):
            target.executescript((self.destination / 'import.sql').read_text())
        self.assertEqual(target.execute('SELECT count(*) FROM vods').fetchone()[0], 0)
        self.assertEqual(target.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall(), before)

    def test_additive_migration_preserves_deleted_id_high_watermark(self):
        for preserve_live in [False, True]:
            with self.subTest(preserve_live=preserve_live):
                db = sqlite3.connect(':memory:')
                self.addCleanup(db.close)
                db.execute('PRAGMA foreign_keys=ON')
                paths = conversion.migrations()
                db.executescript(paths[0].read_text())
                db.executescript("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'legacy','[0,0,1,1]'); INSERT INTO streamers(id,login) VALUES(1,'legacy'); INSERT INTO vods(id,streamer_id,source_id,duration_seconds) VALUES(900,1,'900',100); DELETE FROM vods;")
                if preserve_live:
                    db.execute("INSERT INTO vods(id,streamer_id,source_id,duration_seconds) VALUES(1,1,'1',100)")
                    db.commit()
                db.executescript('BEGIN;'+paths[1].read_text()+'COMMIT;')
                self.assertEqual(db.execute("INSERT INTO vods(streamer_id,source_id,duration_seconds) VALUES(1,'new',100) RETURNING id").fetchone()[0], 901)


class ExportTests(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.destination = Path(self.directory.name) / 'snapshot'
        export_spec = importlib.util.spec_from_file_location('scripts.migration.export_supabase', conversion.ROOT / 'scripts/migration/export_supabase.py')
        self.exporter = importlib.util.module_from_spec(export_spec)
        export_spec.loader.exec_module(self.exporter)
        self.patch = patch
        environment = patch.dict('os.environ', {'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_SECRET_KEY': 'fake-export-test-key'})
        environment.start()
        self.addCleanup(environment.stop)

    def missing(self, status=404, code='PGRST205'):
        import io
        from urllib.error import HTTPError
        return HTTPError('https://example.supabase.co/rest/v1/test', status, 'Table unavailable', {}, io.BytesIO(json.dumps({'code': code}).encode()))

    def test_missing_optional_tables_are_explicit_and_legacy_profile_alias_is_recorded(self):
        def page(root, secret, table, key, cursor, count):
            if table in self.exporter.OPTIONAL_TABLES or table == 'sfde_profiles':
                raise self.missing()
            return []
        with self.patch.object(self.exporter, 'page', side_effect=page):
            self.exporter.export(self.destination)
        manifest = json.loads((self.destination / 'manifest.json').read_text())
        self.assertTrue(manifest['complete'])
        self.assertEqual(manifest['tables']['sfde_profiles']['source_table'], 'sfot_profiles')
        self.assertEqual(manifest['tables']['platform_accounts']['status'], 'absent')
        self.assertFalse((self.destination / 'platform_accounts.jsonl').exists())
        self.assertEqual(set(manifest['tables']), set(conversion.TABLES))
        conversion.convert(self.destination, self.destination.with_name('converted'))

    def test_short_pages_continue_and_composite_keys_advance_by_offset(self):
        requests = []
        def page(root, secret, table, key, cursor, count):
            requests.append((table, cursor, count))
            if table == 'sfde_profiles' and count < 2:
                return [{'id': count + 1, 'profile_name': f'profile-{count}', 'crop_region': [0, 0, 1, 1]}]
            if table == 'youtube_websub_deliveries' and count < 2:
                return [{'account_id': 'same-account', 'body_sha256': str(count) * 64}]
            return []
        with self.patch.object(self.exporter, 'page', side_effect=page):
            counts = self.exporter.export(self.destination)
        self.assertEqual(counts['sfde_profiles'], 2)
        self.assertEqual(counts['youtube_websub_deliveries'], 2)
        self.assertIn(('sfde_profiles', 2, 2), requests)
        self.assertIn(('youtube_websub_deliveries', ('same-account', '1' * 64), 2), requests)

    def test_raw_capability_exports_and_manifest_are_private(self):
        def page(root, secret, table, key, cursor, count):
            if table == 'youtube_websub_subscriptions' and count == 0:
                return [{'account_id': 'account', 'callback_token': 'a' * 64, 'secret': 'b' * 64}]
            return []
        with self.patch.object(self.exporter, 'page', side_effect=page):
            self.exporter.export(self.destination)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o700)
        for path in self.destination.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path.name)

    def test_permission_failure_is_not_treated_as_missing_optional_data(self):
        for code, status in [('42501', 403), ('UNKNOWN', 404)]:
            def page(root, secret, table, key, cursor, count):
                if table == 'platform_accounts':
                    raise self.missing(status, code)
                return []
            target = self.destination.with_name(f'snapshot-{code}')
            with self.subTest(code=code), self.patch.object(self.exporter, 'page', side_effect=page):
                with self.assertRaisesRegex(ValueError, 'Cannot export platform_accounts'):
                    self.exporter.export(target)
            self.assertFalse(json.loads((target / 'manifest.json').read_text())['complete'])
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                conversion.convert(target, target.with_name('not-imported'))

    def test_cross_origin_redirect_cannot_forward_export_credentials(self):
        from urllib.error import HTTPError
        with self.patch.object(self.exporter.HTTP, 'open', side_effect=HTTPError('https://example.supabase.co/rest/v1/sfde_profiles', 302, 'Redirect', {'Location': 'https://untrusted.example'}, None)) as opened:
            with self.assertRaisesRegex(ValueError, 'HTTP 302'):
                self.exporter.export(self.destination)
            self.assertEqual(opened.call_count, 1)
        self.assertIsNone(self.exporter.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://untrusted.example'))
