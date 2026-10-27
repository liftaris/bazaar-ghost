import json
from pathlib import Path
import re
import sqlite3
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'sfde' / 'src'))
import platform_registry as registry  # noqa: E402  (scripts loader; shares the SFDE implementation)
import platform_registry as _same  # noqa: E402,F401

CASES = json.loads((ROOT / 'contracts/platforms.cases.json').read_text())
REGISTRY = json.loads((ROOT / 'contracts/platforms.json').read_text())
MIGRATIONS = ROOT / 'worker/migrations'


class RegistryLoaderTests(unittest.TestCase):
    def test_both_loaders_read_the_one_registry_file(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('sfde_registry', ROOT / 'sfde/src/platform_registry.py')
        sfde = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sfde)
        self.assertEqual(registry.list_platforms(), REGISTRY['platforms'])
        self.assertEqual(sfde.list_platforms(), REGISTRY['platforms'])
        self.assertEqual(registry.supported_sources(), tuple(p['id'] for p in REGISTRY['platforms']))
        self.assertEqual(registry.ingestion_sources(), ('youtube', 'bilibili'))

    def test_registry_shape(self):
        for entry in registry.list_platforms():
            self.assertRegex(entry['id'], r'^[a-z][a-z0-9_-]{0,31}$')
            self.assertEqual(sorted(entry['capabilities']), sorted(
                ['clipParentRange', 'clips', 'createClip', 'fullscreen', 'mute', 'qualitySelectable', 'seek', 'swap', 'timeEvents']))
            for pattern in (entry['recording']['idPattern'], entry['recording']['submissionPattern'], entry['channel']['idPattern'],
                            *entry['recording']['urlPatterns'], *entry['channel']['urlPatterns']):
                re.compile(pattern.replace('(?<', '(?P<'))
        self.assertEqual(registry.platform('twitch')['embed']['requires'], ['parent'])

    def test_identities_match_shared_cases(self):
        for source, cases in CASES['videoIdentity'].items():
            for value in cases['valid']:
                self.assertEqual(registry.video_identity(source, value), value)
            for value in cases['invalid']:
                with self.assertRaises(ValueError):
                    registry.video_identity(source, value)
        for source, cases in CASES['accountIdentity'].items():
            for value in cases['valid']:
                self.assertEqual(registry.account_identity(source, value), value)
            for value in cases['invalid']:
                with self.assertRaises(ValueError):
                    registry.account_identity(source, value)

    def test_urls_match_shared_cases(self):
        for item in CASES['urls']:
            for kind in ('watchUrl', 'embedUrl', 'resolveUrl'):
                self.assertEqual(registry.recording_url(item['platform'], kind, item['values']), item[kind])
                self.assertEqual(registry.recording_url(item['platform'], kind, item['values'], 12), item[kind + 'At'])
        for item in CASES['parse']:
            self.assertEqual(registry.parse_url(item['url']), item['expect'])

    def test_fake_platform_is_supported_without_other_changes(self):
        fake = json.loads(json.dumps(REGISTRY['platforms'][1]))
        fake['id'] = 'kick'
        registry.register_for_test([fake])
        self.addCleanup(registry.register_for_test, [])
        self.assertIn('kick', registry.supported_sources())
        self.assertIn('kick', registry.ingestion_sources())
        self.assertEqual(registry.video_identity('kick', 'abcdefghijk'), 'abcdefghijk')


class SourceLiteralTests(unittest.TestCase):
    """Platform names live in contracts/platforms.json; code outside adapters and tests stays platform-neutral."""
    # Adapter modules (platform-specific by design) and the frozen v1 contract.
    ADAPTERS = {
        'worker/youtube-websub.ts', 'contracts/public-api.ts', 'sfde/src/media_source.py', 'sfde/src/bilibili_source.py',
        'sfde/src/extraction_errors.py', 'scripts/catalog_youtube.py', 'scripts/catalog_bilibili.py',
        'scripts/check_youtube_access.py', 'scripts/check_youtube_pot.py', 'scripts/platform_discovery.py',
        'scripts/platform_ingestion.py', 'scripts/export_youtube_cookies.py', 'scripts/verify_youtube_rollout.py',
    }
    LITERAL = re.compile(r'''['"`](?:[^'"`\n]*[^a-z0-9_-])?(youtube|bilibili)(?:[^a-z0-9_-][^'"`\n]*)?['"`]''')

    def sources(self):
        for pattern in ('worker/*.ts', 'worker/auth/*.ts', 'contracts/*.ts', 'sfde/src/*.py', 'scripts/*.py'):
            for path in sorted(ROOT.glob(pattern)):
                relative = path.relative_to(ROOT).as_posix()
                if relative not in self.ADAPTERS:
                    yield relative, path

    def test_platform_names_do_not_leak_outside_registry_adapters_migrations_and_tests(self):
        offenders = []
        for relative, path in self.sources():
            for number, line in enumerate(path.read_text().splitlines(), 1):
                code = re.sub(r'(?<![:"\'])//.*$|^\s*#.*$|\s#\s.*$', '', line)
                if self.LITERAL.search(code):
                    offenders.append(f'{relative}:{number}: {line.strip()[:100]}')
        self.assertEqual(offenders, [])


class MigrationDataSurvivalTests(unittest.TestCase):
    OLD = sorted(MIGRATIONS.glob('00[01][0-9]_*.sql'))[:10]
    NEW = MIGRATIONS / '0011_platform_registry.sql'

    def connect(self):
        db = sqlite3.connect(':memory:', isolation_level=None)
        self.addCleanup(db.close)
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def seed(self, db):
        db.executescript('''
        INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'d','[0,0,1,1]');
        INSERT INTO streamers(id,login,display_name) VALUES(5,'tw','TW');
        INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES
          ('11111111-1111-4111-8111-111111111111','youtube','UCabcdefghijklmnopqrstuv','Y'),
          ('22222222-2222-4222-8222-222222222222','bilibili','12345','B');
        INSERT INTO vods(id,source,source_id,streamer_id,duration_seconds,published_at) VALUES(1,'twitch','100',5,500,'2026-01-01T00:00:00.000Z');
        INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,published_at,recorded_at)
          VALUES(2,'youtube','abcdefghijk','11111111-1111-4111-8111-111111111111',500,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z');
        INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,recorded_at,source_video_id,source_part_id,source_part_index)
          VALUES(9,'bilibili','BV1234567890:76','22222222-2222-4222-8222-222222222222',500,'2026-01-03T00:00:00.000Z','BV1234567890','76',1);
        DELETE FROM vods WHERE id=9;
        INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,recorded_at,source_video_id,source_part_id,source_part_index)
          VALUES(3,'bilibili','BV1234567890:77','22222222-2222-4222-8222-222222222222',500,'2026-01-03T00:00:00.000Z','BV1234567890','77',2);
        INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('c1',1,0,100,0),('c2',2,0,100,0),('c3',3,0,100,0);
        INSERT INTO search_names(name,gram_count) VALUES('a',1);
        INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence,igd)
          VALUES('d1','c1',1,'A','a',10,0.9,3),('d2','c2',2,'A','a',12,0.9,4),('d3','c3',3,'A','a',12,0.9,5);
        UPDATE clips SET status='hidden' WHERE vod_id=2;
        INSERT INTO matchup_groups(id,evidence) VALUES('g1','Manually reviewed the same game');
        INSERT INTO matchup_appearances(detection_id,matchup_id) VALUES('d1','g1'),('d3','g1');
        INSERT INTO clip_appearances SELECT c.id,'g1' FROM clips c WHERE vod_id IN(1,3);
        INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES('u1','U','u@x.invalid',0,'2026-01-01','2026-01-01');
        INSERT INTO clip_likes(clip_id,user_id) SELECT id,'u1' FROM clips;
        INSERT INTO clip_favorites(user_id,clip_id) SELECT 'u1',id FROM clips WHERE vod_id=1;
        INSERT INTO clip_comments(id,clip_id,author_id,body,original_body_hash) SELECT 'cm1',id,'u1','hello','h' FROM clips WHERE vod_id=1;
        INSERT INTO social_reports(id,reporter_id,clip_id,reason) SELECT 'r1','u1',id,'why' FROM clips WHERE vod_id=3;
        INSERT INTO social_reports(id,reporter_id,comment_id,reason) VALUES('r2','u1','cm1','why');
        INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,account_id)
          VALUES('j1','youtube','account','UCabcdefghijklmnopqrstuv','11111111-1111-4111-8111-111111111111');
        INSERT INTO youtube_websub_subscriptions(account_id,callback_token,secret)
          VALUES('11111111-1111-4111-8111-111111111111',hex(randomblob(32)),hex(randomblob(32)));
        INSERT INTO youtube_websub_deliveries(account_id,body_sha256) VALUES('11111111-1111-4111-8111-111111111111',hex(randomblob(32)));
        ''')

    def snapshot(self, db):
        tables = ['vods', 'platform_accounts', 'platform_ingestion_jobs', 'clips', 'clip_appearances', 'clip_likes',
                  'clip_favorites', 'clip_comments', 'social_reports', 'youtube_websub_subscriptions',
                  'youtube_websub_deliveries', 'chunks', 'detections']
        data = {t: db.execute(f'SELECT * FROM {t} ORDER BY 1,2').fetchall() for t in tables}
        columns = {t: [c[1] for c in db.execute(f'PRAGMA table_info({t})')] for t in tables}
        sequences = dict(db.execute("SELECT s.name,s.seq FROM sqlite_master m JOIN sqlite_sequence s ON s.name=m.name WHERE m.type='table'"))
        return data, columns, sequences

    def schema_names(self, db):
        return {(kind, name) for kind, name in db.execute("SELECT type,name FROM sqlite_master WHERE type IN('trigger','view')")}

    def test_rows_ids_sequences_views_and_triggers_survive(self):
        db = self.connect()
        for path in self.OLD:
            db.executescript('BEGIN;' + path.read_text() + 'COMMIT;')
        self.seed(db)
        before_data, before_columns, before_sequences = self.snapshot(db)
        before_names = self.schema_names(db)
        names = ('video_detections', 'public_matchups', 'public_videos', 'detection_search', 'vod_embed_info', 'vod_stats')
        views = {name: ([c[1] for c in db.execute(f'PRAGMA table_info({name})')], db.execute(f'SELECT * FROM {name} ORDER BY 1').fetchall())
                 for name in names}
        video_columns, video_rows = views['video_detections']
        old_urls = {row[0]: (row[video_columns.index('video_url')], row[video_columns.index('embed_url')]) for row in video_rows}
        old_checks = db.execute('SELECT count(*) FROM vods').fetchone()[0]

        db.executescript('BEGIN;' + self.NEW.read_text() + 'COMMIT;')

        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        after_data, after_columns, after_sequences = self.snapshot(db)
        self.assertEqual(after_columns, before_columns)
        # The one intended data change: a Twitch recording's start time is its published time.
        recorded, published = (before_columns['vods'].index(c) for c in ('recorded_at', 'published_at'))
        before_data['vods'] = [tuple(row[published] if (i == recorded and row[recorded] is None and row[1] == 5) else v
                                     for i, v in enumerate(row)) for row in before_data['vods']]
        self.assertEqual(after_data, before_data)
        for name, value in before_sequences.items():
            self.assertEqual(after_sequences[name], value, name)
        self.assertEqual(self.schema_names(db), before_names)
        self.assertEqual(db.execute('SELECT count(*) FROM vods').fetchone()[0], old_checks)
        # View output is unchanged except the URL columns, which the registry now builds.
        for name, (old_columns, old_rows) in views.items():
            new_columns = [c[1] for c in db.execute(f'PRAGMA table_info({name})')]
            self.assertEqual(new_columns, [c for c in old_columns if c not in ('video_url', 'embed_url')], name)
            keep = [old_columns.index(c) for c in new_columns]
            if 'recorded_at' in old_columns and 'source' in old_columns:
                position = {c: old_columns.index(c) for c in ('recorded_at', 'published_at', 'source')}
                old_rows = [tuple(row[position['published_at']] if (i == position['recorded_at'] and v is None and row[position['source']] == 'twitch') else v
                                  for i, v in enumerate(row)) for row in old_rows]
            new_rows = db.execute(f'SELECT * FROM {name} ORDER BY 1').fetchall()
            self.assertEqual(new_rows, [tuple(row[i] for i in keep) for row in old_rows], name)
            self.assertTrue(new_rows, name)
        columns = [c[1] for c in db.execute('PRAGMA table_info(video_detections)')]
        for row in db.execute('SELECT * FROM video_detections'):
            record = dict(zip(columns, row))
            values = {'id': record['source_id'], 'videoId': record['source_video_id'],
                      'partId': record['source_part_id'], 'partIndex': record['source_part_index']}
            at = record['frame_time_seconds']
            self.assertEqual((registry.recording_url(record['source'], 'watchUrl', values, at),
                              registry.recording_url(record['source'], 'embedUrl', values, at)),
                             old_urls[record['detection_id']], record['source'])
        # Deleted-ID high watermark: the next vod continues after the deleted id 9.
        self.assertEqual(db.execute(
            "INSERT INTO vods(source,source_id,streamer_id,duration_seconds) VALUES('twitch','101',5,10) RETURNING id").fetchone()[0], 10)


    def test_a_new_platform_needs_no_schema_change_after_the_migration(self):
        db = self.connect()
        for path in [*self.OLD, self.NEW]:
            db.executescript('BEGIN;' + path.read_text() + 'COMMIT;')
        db.executescript('''
        INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'d','[0,0,1,1]');
        INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('a1','tiktok','someone','S');
        INSERT INTO vods(source,source_id,platform_account_id,duration_seconds) VALUES('tiktok','12345','a1',100);
        INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,account_id) VALUES('j','tiktok','account','someone','a1');
        ''')
        for bad in ("INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('a2','Tik Tok','x','S')",
                    "INSERT INTO vods(source,source_id,duration_seconds) VALUES('tiktok','nope',100)"):
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(bad)
        with self.assertRaises(sqlite3.IntegrityError):  # part columns must be coherent
            db.execute("""INSERT INTO vods(source,source_id,platform_account_id,duration_seconds,source_part_id)
                VALUES('tiktok','9','a1',10,'p')""")

    def test_notifications_follow_the_platform_setting(self):
        db = self.connect()
        for path in [*self.OLD, self.NEW]:
            db.executescript('BEGIN;' + path.read_text() + 'COMMIT;')
        db.executescript('''
        INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'d','[0,0,1,1]');
        INSERT INTO streamers(id,login) VALUES(5,'tw');
        INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('a1','youtube','UCabcdefghijklmnopqrstuv','Y');
        INSERT INTO vods(id,source,source_id,streamer_id,duration_seconds) VALUES(1,'twitch','1',5,100);
        INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds) VALUES(2,'youtube','abcdefghijk','a1',100);
        INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('c1',1,0,50,0),('c2',2,0,50,0);
        INSERT INTO search_names(name,gram_count) VALUES('a',1);
        ''')
        self.assertEqual(db.execute("SELECT source,notifications_enabled FROM platform_settings ORDER BY source").fetchall(),
                         [('bilibili', 0), ('twitch', 1), ('youtube', 0)])
        db.execute("INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence) VALUES('t','c1',1,'A','a',1,0.9)")
        db.execute("INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence) VALUES('y','c2',2,'A','a',1,0.9)")
        self.assertEqual(db.execute('SELECT detection_id FROM notification_outbox').fetchall(), [('t',)])
        db.execute("UPDATE platform_settings SET notifications_enabled=1 WHERE source='youtube'")
        db.execute("INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence) VALUES('y2','c2',2,'A','a',2,0.9)")
        self.assertEqual(sorted(db.execute('SELECT detection_id FROM notification_outbox').fetchall()), [('t',), ('y2',)])


if __name__ == '__main__':
    unittest.main()
