"""Opt-in real workerd/D1 import proof. Never exports source or accesses hosted D1.

RUN_LOCAL_D1_MIGRATION_TESTS=1 python -m unittest scripts.tests.test_migration_d1
Set LOCAL_D1_ARTIFACT_DIR to a new directory to retain private proof artifacts.
"""
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.tests import test_migration as fixtures

conversion = fixtures.conversion


@unittest.skipUnless(os.environ.get('RUN_LOCAL_D1_MIGRATION_TESTS') == '1', 'Opt-in local workerd/D1 test')
class FullTargetD1Tests(unittest.TestCase):
    def setUp(self):
        retained = os.environ.get('LOCAL_D1_ARTIFACT_DIR')
        if retained:
            self.root = Path(retained).resolve()
            self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
        else:
            directory = tempfile.TemporaryDirectory(prefix='bazaarghost-d1-import-')
            self.addCleanup(directory.cleanup)
            self.root = Path(directory.name)
        self.database = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        self.calls = 0

    def cli(self, *arguments, state='populated', succeeds=True):
        self.calls += 1
        command = [str(conversion.ROOT / 'node_modules/.bin/cf'), 'd1', *arguments,
            '--mode', 'local', '--local', '--persist-to', str(self.root / state)]
        process = subprocess.run(command, cwd=conversion.ROOT, text=True, capture_output=True, timeout=90,
            env={**os.environ, 'CI': 'true', 'CF_SEND_TELEMETRY': 'false'})
        log = self.root / f'command-{self.calls:02}.log'
        log.write_text(process.stdout + '\n' + process.stderr)
        log.chmod(0o600)
        if succeeds:
            self.assertEqual(process.returncode, 0, f'Local D1 command failed; private details: {log}')
        else:
            self.assertNotEqual(process.returncode, 0, 'Unsafe import unexpectedly succeeded')
            self.assertIn('valid_mutation', process.stdout + process.stderr)
        return process.stdout

    def migrate(self, state='populated'):
        return self.cli('migrations', 'apply', self.database, '--dir', str(conversion.ROOT / 'worker/migrations'), state=state)

    def execute_file(self, path, **kwargs):
        body = self.root / 'query.json'
        conversion.private_json(body, {'sql': path.read_text()})
        return self.cli('raw', self.database, '--body', '@' + str(body), **kwargs)

    def query(self, sql, state='populated'):
        result = json.loads(self.cli('raw', self.database, '--sql', sql, state=state))
        self.assertTrue(all(item['success'] for item in result))
        data = result[0]['results']
        return [dict(zip(data['columns'], row)) for row in data['rows']]

    def test_generated_populated_snapshot_into_full_target_with_guards(self):
        source, destination = self.root / 'source', self.root / 'converted'
        source.mkdir(mode=0o700)
        records = fixtures.MultiplatformMigrationTests().records()
        for table in conversion.TABLES:
            with conversion.private_open(source / f'{table}.jsonl') as output:
                output.write(''.join(json.dumps(row)+'\n' for row in records.get(table, [])))
        source_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.iterdir()}
        with redirect_stdout(io.StringIO()):
            conversion.convert(source, destination)
        self.assertEqual({path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.iterdir()}, source_hashes)
        manifest = json.loads((destination / 'manifest.json').read_text())
        self.assertEqual(manifest['target_schema_version'], 26)
        self.assertEqual(manifest['target_migrations'], {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in (conversion.ROOT / 'worker/migrations').glob('*.sql')})
        self.migrate()
        self.assertEqual(self.query('SELECT name FROM d1_migrations ORDER BY name'),
                         [{'name': name} for name in sorted(manifest['target_migrations'])])
        before_triggers = self.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
        seeds = fixtures.target_seed_revisions()
        pristine_revisions = {'cache_revision': seeds['public_cache_state'], 'search_revision': seeds['public_search_state']}
        self.assertEqual(self.query('SELECT (SELECT revision FROM public_cache_state) cache_revision,(SELECT revision FROM public_search_state) search_revision'),
                          [pristine_revisions])
        for part in sorted(destination.glob('import-*.sql')):
            self.execute_file(part)
        self.execute_file(destination / 'post_import.sql')
        counts_sql = 'SELECT ' + ','.join(f'(SELECT count(*) FROM {table}) AS "{table}"' for table in manifest['target_counts'])
        counts = self.query(counts_sql)[0]
        self.assertEqual(counts, manifest['target_counts'])
        self.assertEqual(self.query('PRAGMA foreign_key_check'), [])
        self.assertEqual(self.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"), before_triggers)
        self.assertEqual(counts['sfde_inference'], 0)
        self.assertEqual(self.query('''SELECT id,username,confidence,igd,storage_path,name_state,encounter_confidence,
            ghost_hero,streamer_hero,wins_remaining,lethal,field_evidence,publish_id,publish_claim,publish_body
            FROM detections ORDER BY id'''), [
            {**{key: row[key] for key in ('id','username','confidence','igd','storage_path')},
             'name_state': 'legacy', 'encounter_confidence': None, 'ghost_hero': None, 'streamer_hero': None,
             'wins_remaining': None, 'lethal': None, 'field_evidence': '{}', 'publish_id': None,
             'publish_claim': None, 'publish_body': None} for row in records['detections']])
        self.assertEqual(self.query('SELECT id,source,source_id,source_video_id,source_part_id,source_part_index FROM vods ORDER BY id'), [
            {'id':1,'source':'twitch','source_id':'12345678901','source_video_id':None,'source_part_id':None,'source_part_index':None},
            {'id':2,'source':'youtube','source_id':'12345678901','source_video_id':None,'source_part_id':None,'source_part_index':None},
            {'id':3,'source':'bilibili','source_id':'BV1234567890:111','source_video_id':'BV1234567890','source_part_id':'111','source_part_index':2},
            {'id':4,'source':'bilibili','source_id':'BV1234567890:222','source_video_id':'BV1234567890','source_part_id':'222','source_part_index':1},
        ])
        self.assertEqual(self.query('SELECT recorded_at,published_at FROM vods WHERE id=2'), [{'recorded_at':'2025-08-11T22:00:00.000Z','published_at':'2026-09-01T15:00:00.000Z'}])
        self.assertEqual(self.query('SELECT source_video_id FROM public_sources WHERE vod_id=2'), [{'source_video_id':'12345678901'}])
        self.assertEqual(self.query("SELECT count(*) n FROM sqlite_master WHERE name IN('matchup_groups','matchup_appearances','matchup_review_events','clip_appearances')"), [{'n':0}])
        self.assertEqual(self.query('SELECT count(*) n FROM notification_outbox_v2 WHERE sent_at IS NULL'), [{'n':0}])
        subscription = self.query(f"SELECT length(callback_token) token_length,length(secret) secret_length,callback_token!='{'a'*64}' AS token_rotated,secret!='{'b'*64}' AS secret_rotated FROM youtube_websub_subscriptions")
        self.assertEqual(subscription,[{'token_length':64,'secret_length':64,'token_rotated':1,'secret_rotated':1}])
        self.assertEqual(self.query('SELECT count(*) n FROM youtube_websub_subscriptions WHERE requested_at IS NOT NULL OR confirmed_at IS NOT NULL OR lease_expires_at IS NOT NULL'),[{'n':0}])
        self.assertEqual(self.query('SELECT count(*) n FROM youtube_websub_deliveries'),[{'n':1}])
        self.assertEqual(self.query('SELECT status,next_attempt_at FROM platform_ingestion_jobs'),[{'status':'waiting','next_attempt_at':'2026-09-08T15:00:00.000Z'}])
        self.assertEqual(self.query("SELECT count(*) n FROM vods WHERE status='completed'"),[{'n':4}])
        self.assertEqual(self.query('SELECT id,revision FROM public_cache_state'),[{'id':1,'revision':0}])
        for table in ('vods', 'sessions', 'public_recordings'):
            self.assertEqual(self.query(f'SELECT streamer_mode FROM {table} ORDER BY id'), [{'streamer_mode':0}] * 4)
        for table in ['app_users','user_accounts','user_sessions','auth_verifications','auth_flows','auth_rate_limits','matchup_comments','matchup_likes','matchup_favorites','social_reports','social_moderation_audit','platform_ingestion_dispatch']:
            self.assertEqual(counts[table],0,table)
        self.execute_file(destination/'import.sql',succeeds=False)
        self.assertEqual(self.query(counts_sql)[0],counts)
        self.assertEqual(self.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"),before_triggers)
        # The full-target triggers still operate on the imported anchors, Matchups and public views.
        self.assertEqual(self.query('SELECT count(*) n,sum(matchup_id=id) m FROM matchup_anchors'),[{'n':4,'m':3}])
        self.assertEqual(self.query('SELECT count(*) n,count(DISTINCT matchup_id) c FROM matchup_anchors WHERE matchup_id IN(SELECT matchup_id FROM matchup_anchors GROUP BY matchup_id HAVING count(*)>1)'),[{'n':2,'c':1}])
        self.assertEqual(self.query('SELECT count(*) n FROM matchup_overrides WHERE action=\'link\' AND actor=\'legacy-group\''),[{'n':1}])
        self.assertEqual(self.query('SELECT count(*) n FROM matchups WHERE merged_into IS NOT NULL'),[{'n':1}])
        self.assertEqual(self.query('SELECT count(*) n FROM matchups'),[{'n':4}])
        # Imported Recordings each got a singleton Session and Matchups carry Session time.
        self.assertEqual(self.query("SELECT (SELECT count(*) FROM sessions) s,(SELECT count(*) FROM vods) v,(SELECT count(*) FROM recording_alignments WHERE method='singleton' AND offset_seconds=0 AND revoked_at IS NULL) a"),[{'s':counts['vods'],'v':counts['vods'],'a':counts['vods']}])
        self.assertEqual(self.query('SELECT count(*) n FROM matchups WHERE session_id IS NULL OR session_time IS NULL'),[{'n':0}])
        before_hide = self.query('SELECT revision FROM public_cache_state')[0]['revision']
        self.query("UPDATE matchups SET status='hidden' WHERE id IN(SELECT matchup_id FROM matchup_anchors WHERE vod_id=1)")
        self.assertEqual(self.query('SELECT revision FROM public_cache_state'),[{'revision':before_hide+1}])
        self.assertEqual(self.query("SELECT count(*) n FROM sqlite_master WHERE name='detection_search'"),[{'n':0}])
        self.assertEqual(self.query('SELECT count(*) n FROM public_sources'),[{'n':2}])  # hiding the merged Matchup hides every Source
        # The new mask triggers were never suspended, and remain operational
        # after restoring all target trigger definitions and importing history.
        self.query("UPDATE detections SET username=NULL,username_lower=NULL,confidence=NULL,name_state='masked',encounter_confidence=.95 WHERE id='detection-3'")
        self.assertEqual(self.query('SELECT streamer_mode FROM vods WHERE id=3'), [{'streamer_mode':1}])
        self.assertEqual(self.query('SELECT streamer_mode FROM sessions WHERE id=(SELECT session_id FROM vods WHERE id=3)'), [{'streamer_mode':1}])
        self.query("UPDATE detections SET name_state='unreadable' WHERE id='detection-3'")
        self.assertEqual(self.query('SELECT streamer_mode FROM public_recordings WHERE id=3'), [{'streamer_mode':1}])
        self.query("INSERT INTO detections(id,chunk_id,vod_id,frame_time_seconds,name_state,encounter_confidence) VALUES('new-mask','chunk-4',4,4,'masked',.95)")
        self.assertEqual(self.query('SELECT streamer_mode FROM vods WHERE id=4'), [{'streamer_mode':1}])
        self.assertEqual(self.query('SELECT streamer_mode FROM sessions WHERE id=(SELECT session_id FROM vods WHERE id=4)'), [{'streamer_mode':1}])
        self.assertEqual(self.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"), before_triggers)
        self.assertEqual(self.query('PRAGMA foreign_key_check'), [])
        self.migrate(state='occupied-auth')
        self.query("INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES('existing','Existing','fixture@invalid.test',0,'2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z')",state='occupied-auth')
        self.execute_file(destination/'import.sql',state='occupied-auth',succeeds=False)
        self.assertEqual(self.query('SELECT count(*) n FROM app_users',state='occupied-auth'),[{'n':1}])
        self.assertEqual(self.query('SELECT count(*) n FROM vods',state='occupied-auth'),[{'n':0}])
        self.query('DELETE FROM app_users;DELETE FROM public_cache_state',state='occupied-auth')
        self.execute_file(destination/'import.sql',state='occupied-auth',succeeds=False)
        self.migrate(state='occupied-dispatch')
        self.query('''INSERT INTO platform_ingestion_dispatch
            (id,ticket_id,state,lease_expires_at,next_attempt_at,last_attempt_at,run_id,run_attempt)
            VALUES(1,'old-environment-ticket','running','2099-01-01T00:00:00.000Z',
            '2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z','123456','1')''',state='occupied-dispatch')
        owner = self.query('SELECT * FROM platform_ingestion_dispatch',state='occupied-dispatch')
        self.execute_file(destination/'import.sql',state='occupied-dispatch',succeeds=False)
        self.assertEqual(self.query('SELECT * FROM platform_ingestion_dispatch',state='occupied-dispatch'),owner)
        self.assertEqual(self.query('SELECT count(*) n FROM vods',state='occupied-dispatch'),[{'n':0}])
        self.assertEqual(self.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",state='occupied-dispatch'),before_triggers)
        self.assertEqual(self.query('PRAGMA foreign_key_check',state='occupied-dispatch'),[])
        self.migrate(state='occupied-inference')
        for status in ('pending', 'completed', 'uncertain'):
            with self.subTest(inference_status=status):
                self.query(fixtures.inference_ledger_insert(status),state='occupied-inference')
                ledger = self.query('SELECT * FROM sfde_inference',state='occupied-inference')
                self.execute_file(destination/'import.sql',state='occupied-inference',succeeds=False)
                self.assertEqual(self.query('SELECT * FROM sfde_inference',state='occupied-inference'),ledger)
                self.assertEqual(self.query('SELECT count(*) n FROM vods',state='occupied-inference'),[{'n':0}])
                self.assertEqual(self.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",state='occupied-inference'),before_triggers)
                self.assertEqual(self.query('SELECT (SELECT revision FROM public_cache_state) cache_revision,(SELECT revision FROM public_search_state) search_revision',state='occupied-inference'),
                                  [pristine_revisions])
                self.query('DELETE FROM sfde_inference',state='occupied-inference')
        conversion.private_json(self.root/'proof.json',{'status':'passed','source_schema':conversion.SCHEMA_VERSION,'target_schema':conversion.TARGET_SCHEMA_VERSION,
            'target_migrations':manifest['target_migrations'],
            'counts_after_import':counts,'no_auth_imported':True,'nonempty_application_refused':True,
            'nonempty_auth_refused':True,'missing_cache_singleton_refused':True,'foreign_key_errors':0,
            'dispatcher_empty_after_import':True,'nonempty_dispatcher_refused':True,'existing_dispatch_ownership_preserved':True,
            'triggers_preserved':True,'public_visibility_trigger_verified':True,'hosted_resources_touched':False,
            'legacy_evidence_defaults_verified':True,'inference_ledger_empty_after_import':True,
            'legacy_streamer_mode_false_verified':True,'mask_insert_update_propagation_verified':True,
            'target_seed_revisions':seeds,
            'nonempty_inference_ledger_refused':True,'inference_history_preserved':True,'source_bytes_unchanged':True})
