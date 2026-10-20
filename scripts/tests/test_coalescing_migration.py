from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / 'worker/migrations').glob('*.sql'))
BEFORE, NEW = MIGRATIONS[:14], MIGRATIONS[14]
assert NEW.name == '0015_matchup_coalescing.sql'


class CoalescingMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.addCleanup(self.db.close)
        self.db.execute('PRAGMA foreign_keys=ON')
        for path in BEFORE:
            self.db.executescript('BEGIN;' + path.read_text() + 'COMMIT;')
        self.db.executescript('''
        INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'d','[0,0,1,1]');
        INSERT INTO streamers(id,login,display_name) VALUES(5,'tw','TW');
        INSERT INTO vods(id,source,source_id,streamer_id,duration_seconds,published_at,recorded_at)
          VALUES(1,'twitch','100',5,500,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
                (2,'twitch','101',5,500,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z'),
                (3,'twitch','102',5,500,'2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z');
        INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('c1',1,0,100,0),('c2',2,0,100,0),('c3',3,0,100,0);
        INSERT INTO search_names(name,gram_count) VALUES('a',1);
        INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence,igd) VALUES
          ('d1','c1',1,'A','a',10,0.9,3),('d2','c1',1,'A','a',20,0.9,3),('d3','c2',2,'A','a',12,0.9,4),
          ('d4','c2',2,'A','a',22,0.9,4),('d5','c3',3,'A','a',10,0.9,4),('d6','c3',3,'A','a',20,0.9,4);
        UPDATE matchups SET status='hidden' WHERE id=4;
        INSERT INTO matchup_groups(id,evidence) VALUES('g1','Manually reviewed the same game'),('g2','Manually reviewed the second game');
        INSERT INTO matchup_appearances(detection_id,matchup_id) VALUES('d1','g1'),('d3','g1'),('d5','g1'),('d2','g2'),('d4','g2');
        INSERT INTO clip_appearances VALUES(1,'g1'),(3,'g1'),(5,'g1'),(2,'g2'),(4,'g2');
        INSERT INTO matchup_review_events(id,matchup_id,action,detection_ids,evidence)
          VALUES('e1','g1','link','["d1","d3","d5"]','Manually reviewed the same game'),('e2','g1','unlink','["d6"]','Removed the third copy again');
        INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES
          ('u1','U','u@x.invalid',0,'2026-01-01','2026-01-01'),('u2','V','v@x.invalid',0,'2026-01-01','2026-01-01');
        INSERT INTO matchup_likes(matchup_id,origin_id,user_id) VALUES(1,1,'u1'),(3,3,'u1'),(3,3,'u2'),(2,2,'u2');
        INSERT INTO matchup_comments(id,matchup_id,origin_id,author_id,body,original_body_hash) VALUES('cm1',3,3,'u1','one','h');
        INSERT INTO social_reports(id,reporter_id,matchup_id,origin_id,reason) VALUES('r1','u1',1,1,'why'),('r2','u1',3,3,'again'),('r3','u2',3,3,'x');
        ''')

    def q(self, sql):
        return self.db.execute(sql).fetchall()

    def migrate(self):
        before = self.q('SELECT * FROM clip_appearances ORDER BY 1')
        self.db.executescript('BEGIN;' + NEW.read_text() + 'COMMIT;')
        return before

    def test_groups_become_links_and_merged_matchups(self):
        before = self.migrate()
        self.assertEqual(self.q("SELECT type FROM sqlite_master WHERE name='clip_appearances'"), [('view',)])
        after = self.q('SELECT clip_id FROM clip_appearances ORDER BY 1')
        self.assertEqual(after, [(r[0],) for r in before])
        partitions = lambda rows: sorted(sorted(c for c, m in rows if m == g) for g in {m for _, m in rows})
        self.assertEqual(partitions(self.q('SELECT clip_id,matchup_id FROM clip_appearances')), partitions(before))
        self.assertEqual(self.q('SELECT action,anchor_a,anchor_b,actor,source_group,evidence FROM matchup_overrides ORDER BY anchor_a,anchor_b,action'), [
            ('link', 1, 3, 'legacy-group', 'g1', 'Manually reviewed the same game'), ('link', 1, 5, 'legacy-group', 'g1', 'Manually reviewed the same game'),
            ('unlink', 1, 6, 'legacy-group', 'g1', 'Removed the third copy again'),
            ('link', 2, 4, 'legacy-group', 'g2', 'Manually reviewed the second game'),
            ('unlink', 3, 6, 'legacy-group', 'g1', 'Removed the third copy again'), ('unlink', 5, 6, 'legacy-group', 'g1', 'Removed the third copy again')])
        self.assertEqual(self.q('SELECT id,merged_into,origin,status FROM matchups ORDER BY id'), [
            (1, None, 'auto', 'visible'), (2, None, 'auto', 'hidden'), (3, 1, 'legacy-group', 'visible'), (4, 2, 'legacy-group', 'hidden'),
            (5, 1, 'legacy-group', 'visible'), (6, None, 'auto', 'visible')])
        self.assertEqual(self.q('SELECT id,matchup_id FROM matchup_anchors ORDER BY id'), [(1, 1), (2, 2), (3, 1), (4, 2), (5, 1), (6, 6)])
        self.assertEqual(self.q('SELECT matchup_id,origin_id,user_id FROM matchup_likes ORDER BY origin_id,user_id'), [(1, 1, 'u1'), (2, 2, 'u2'), (1, 3, 'u1'), (1, 3, 'u2')])
        self.assertEqual(self.q('SELECT matchup_id FROM matchup_comments'), [(1,)])
        self.assertEqual(self.q('SELECT id,matchup_id,origin_id,status FROM social_reports ORDER BY id'),
                         [('r1', 1, 1, 'open'), ('r2', 1, 3, 'dismissed'), ('r3', 1, 3, 'open')])
        self.assertEqual(self.q("SELECT count(*) FROM matchup_events WHERE action='merge'"), [(2,)])
        self.assertEqual(self.q("SELECT name FROM sqlite_master WHERE name LIKE 'm5_%'"), [])
        self.assertEqual(self.q('PRAGMA foreign_key_check'), [])

    def test_unlink_events_replay_only_for_pairs_no_longer_grouped(self):
        self.db.executescript("DELETE FROM clip_appearances WHERE clip_id=5;")
        self.migrate()
        self.assertEqual(self.q("SELECT anchor_a,anchor_b,source_group,evidence FROM matchup_overrides WHERE action='unlink' ORDER BY 1,2"),
                         [(1, 6, 'g1', 'Removed the third copy again'), (3, 6, 'g1', 'Removed the third copy again'), (5, 6, 'g1', 'Removed the third copy again')])

    def test_rerunning_the_import_statements_changes_nothing(self):
        self.migrate()
        self.db.executescript('DELETE FROM matchup_events WHERE 0;')
        before = [self.q(sql) for sql in ('SELECT * FROM matchup_overrides ORDER BY id', 'SELECT id,merged_into,origin,status FROM matchups ORDER BY id',
                                          'SELECT id,matchup_id FROM matchup_anchors ORDER BY id', 'SELECT * FROM matchup_events ORDER BY id',
                                          'SELECT * FROM social_reports ORDER BY id', 'SELECT * FROM matchup_likes ORDER BY origin_id,user_id')]
        self.db.executescript('BEGIN;' + (ROOT / 'scripts/migration/post_import.sql').read_text() + 'COMMIT;')
        after = [self.q(sql) for sql in ('SELECT * FROM matchup_overrides ORDER BY id', 'SELECT id,merged_into,origin,status FROM matchups ORDER BY id',
                                         'SELECT id,matchup_id FROM matchup_anchors ORDER BY id', 'SELECT * FROM matchup_events ORDER BY id',
                                         'SELECT * FROM social_reports ORDER BY id', 'SELECT * FROM matchup_likes ORDER BY origin_id,user_id')]
        self.assertEqual(before, after)

    def test_no_groups_means_no_changes_and_no_revision_bump(self):
        self.db.executescript('DELETE FROM clip_appearances; DELETE FROM matchup_appearances; DELETE FROM matchup_review_events;')
        revisions = self.q('SELECT (SELECT revision FROM public_cache_state),(SELECT revision FROM public_search_state)')
        self.migrate()
        self.assertEqual(self.q('SELECT count(*) FROM matchup_overrides'), [(0,)])
        self.assertEqual(self.q('SELECT count(*) FROM matchups WHERE merged_into IS NOT NULL'), [(0,)])
        self.assertEqual(self.q('SELECT (SELECT revision FROM public_cache_state),(SELECT revision FROM public_search_state)'), revisions)
        self.assertEqual(self.q('SELECT count(*) FROM clip_appearances'), [(0,)])

    def test_triggers_bump_revisions_for_overrides_and_moves_but_not_for_new_anchors(self):
        self.migrate()
        rev = lambda: self.q('SELECT (SELECT revision FROM public_cache_state)+(SELECT revision FROM public_search_state)')[0][0]
        start = rev()
        self.db.execute("INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence) VALUES('d9','c3',3,'A','a',40,0.9)")
        self.assertEqual(rev(), start)
        self.db.execute("INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor) VALUES('o1','unlink',6,7,'0123456789','t')")
        self.assertEqual(rev(), start + 2)
        self.db.execute("UPDATE matchup_overrides SET revoked_at='2026-01-01',revoked_by='t' WHERE id='o1'")
        self.assertEqual(rev(), start + 4)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor) VALUES('o2','link',7,6,'0123456789','t')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor) VALUES('o3','link',6,7,'short','t')")

    def test_generated_files_match_the_single_source(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/migration/gen_backfill.py'), '--check'], capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout), (0, ''))
        source = (ROOT / 'scripts/migration/legacy_groups.sql').read_text()
        self.assertIn(source, NEW.read_text())
        self.assertIn(source, (ROOT / 'scripts/migration/post_import.sql').read_text())


if __name__ == '__main__':
    unittest.main()
