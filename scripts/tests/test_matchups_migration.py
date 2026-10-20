from pathlib import Path
import sqlite3
import unittest

MIGRATIONS = Path(__file__).resolve().parents[2] / 'worker/migrations'
BEFORE = sorted(MIGRATIONS.glob('00[01][0-9]_*.sql'))[:12]
NEW = MIGRATIONS / '0013_matchups.sql'


class MatchupMigrationTests(unittest.TestCase):
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
                (2,'twitch','101',5,500,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z');
        INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('c1',1,0,100,0),('c2',2,0,100,0);
        INSERT INTO search_names(name,gram_count) VALUES('a',1);
        INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence,igd)
          VALUES('d1','c1',1,'A','a',10,0.9,3),('d2','c1',1,'A','a',20,0.9,3),('d3','c2',2,'A','a',12,0.9,4);
        UPDATE clips SET status='hidden' WHERE id=2;
        INSERT INTO matchup_groups(id,evidence) VALUES('g1','Manually reviewed the same game');
        INSERT INTO clip_appearances VALUES(1,'g1'),(3,'g1');
        INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES
          ('u1','U','u@x.invalid',0,'2026-01-01','2026-01-01'),('u2','V','v@x.invalid',0,'2026-01-01','2026-01-01');
        INSERT INTO clip_likes(clip_id,user_id,created_at) VALUES(1,'u1','2026-02-01T00:00:00.000Z'),(1,'u2','2026-02-02T00:00:00.000Z'),(3,'u1','2026-02-03T00:00:00.000Z');
        INSERT INTO clip_favorites(user_id,clip_id,created_at) VALUES('u1',1,'2026-02-04T00:00:00.000Z'),('u2',3,'2026-02-05T00:00:00.000Z');
        INSERT INTO clip_comments(id,clip_id,author_id,body,original_body_hash) VALUES('cm1',1,'u1','one','h'),('cm2',1,'u2','two','h'),('cm3',3,'u1','three','h');
        DELETE FROM clip_comments WHERE id='cm3';
        INSERT INTO social_reports(id,reporter_id,clip_id,reason) VALUES('r1','u1',3,'why'),('r2','u2',1,'why');
        INSERT INTO social_reports(id,reporter_id,comment_id,reason) VALUES('r3','u1','cm1','why');
        DELETE FROM social_reports WHERE id='r2';
        INSERT INTO social_moderation_audit(request_id,target_type,target_id,action,reason) VALUES('a1','clip','2','hidden','r'),('a2','comment','cm1','hidden','r');
        ''')

    def q(self, sql):
        return self.db.execute(sql).fetchall()

    def migrate(self):
        before = {
            'anchors': self.q('SELECT id,vod_id,anchor_seconds,current_detection_id,created_at FROM clips ORDER BY id'),
            'likes': self.q('SELECT clip_id,user_id,created_at FROM clip_likes ORDER BY 1,2'),
            'favorites': self.q('SELECT clip_id,user_id,created_at FROM clip_favorites ORDER BY 1,2'),
            'comments': self.q('SELECT sequence,id,clip_id,author_id,body,created_at FROM clip_comments ORDER BY sequence'),
            'reports': self.q('SELECT sequence,id,reporter_id,clip_id,comment_id,status FROM social_reports ORDER BY sequence'),
            'appearances': self.q('SELECT * FROM clip_appearances ORDER BY 1'),
            'sequences': dict(self.q('SELECT name,seq FROM sqlite_sequence')),
            'statuses': self.q('SELECT id,status FROM clips ORDER BY id'),
        }
        self.db.executescript('BEGIN;' + NEW.read_text() + 'COMMIT;')
        return before

    def test_ids_social_rows_sequences_and_cascade_children_survive(self):
        before = self.migrate()
        self.assertEqual(self.q("SELECT name FROM sqlite_master WHERE name IN('clips','clip_likes','clip_favorites','clip_comments')"), [])
        self.assertEqual(self.q('PRAGMA foreign_key_check'), [])
        self.assertEqual(self.q('SELECT id,vod_id,anchor_seconds,current_detection_id,created_at FROM matchup_anchors ORDER BY id'), before['anchors'])
        self.assertEqual(self.q('SELECT id,status FROM matchups ORDER BY id'), before['statuses'])
        self.assertEqual(self.q('SELECT count(*) FROM matchup_anchors WHERE matchup_id=id')[0][0], 3)
        self.assertEqual(self.q('SELECT merged_into,origin FROM matchups WHERE merged_into IS NOT NULL OR origin!=\'auto\''), [])
        self.assertEqual(self.q('SELECT * FROM clip_appearances ORDER BY 1'), before['appearances'])
        self.assertEqual(self.q('SELECT clip_id FROM clip_appearances WHERE clip_id NOT IN(SELECT id FROM matchup_anchors)'), [])
        self.assertEqual(self.q('SELECT matchup_id,user_id,created_at FROM matchup_likes ORDER BY 1,2'), before['likes'])
        self.assertEqual(self.q('SELECT origin_id,user_id FROM matchup_likes ORDER BY 1,2'), [(c, u) for c, u, _ in before['likes']])
        self.assertEqual(self.q('SELECT matchup_id,user_id,created_at FROM matchup_favorites ORDER BY 1,2'), before['favorites'])
        self.assertEqual(self.q('SELECT sequence,id,matchup_id,author_id,body,created_at FROM matchup_comments ORDER BY sequence'), before['comments'])
        self.assertEqual(self.q('SELECT count(*) FROM matchup_comments WHERE origin_id!=matchup_id')[0][0], 0)
        self.assertEqual(self.q('SELECT sequence,id,reporter_id,matchup_id,comment_id,status FROM social_reports ORDER BY sequence'), before['reports'])
        self.assertEqual(self.q('SELECT count(*) FROM social_reports WHERE origin_id IS NOT matchup_id')[0][0], 0)
        self.assertEqual(self.q('SELECT target_type,target_id FROM social_moderation_audit ORDER BY sequence'), [('matchup', '2'), ('comment', 'cm1')])
        sequences = dict(self.q('SELECT name,seq FROM sqlite_sequence'))
        for old, new in [('clips', 'matchup_anchors'), ('clip_comments', 'matchup_comments'), ('social_reports', 'social_reports')]:
            self.assertEqual(sequences[new], before['sequences'][old], new)
        self.assertGreaterEqual(sequences['matchups'], before['sequences']['clips'])
        self.assertGreater(sequences['matchup_comments'], self.q('SELECT max(sequence) FROM matchup_comments')[0][0])
        self.db.execute("INSERT INTO matchup_comments(id,matchup_id,origin_id,author_id,body,original_body_hash) VALUES('cm4',1,1,'u1','x','h')")
        self.assertEqual(self.q("SELECT sequence FROM matchup_comments WHERE id='cm4'")[0][0], before['sequences']['clip_comments'] + 1)

    def test_hidden_matchup_hides_search_views_and_bumps_revisions(self):
        self.migrate()
        self.assertEqual(self.q('SELECT detection_id FROM video_detections ORDER BY 1'), [('d1',), ('d3',)])
        self.assertEqual(self.q('SELECT matchup_id,canonical_id FROM public_matchups ORDER BY 1'), [(1, 1), (3, 3)])
        revisions = self.q('SELECT (SELECT revision FROM public_cache_state),(SELECT revision FROM public_search_state)')
        self.db.execute("UPDATE matchups SET status='hidden' WHERE id=1")
        self.assertEqual(self.q('SELECT detection_id FROM video_detections'), [('d3',)])
        self.assertEqual(self.q('SELECT matchup_id FROM public_matchups'), [(3,)])
        self.assertEqual(self.q('SELECT (SELECT revision FROM public_cache_state),(SELECT revision FROM public_search_state)'),
                         [(revisions[0][0] + 1, revisions[0][1] + 1)])
        self.db.execute("UPDATE matchups SET status='visible' WHERE id=2")
        self.assertEqual(self.q('SELECT count(*) FROM streamers_with_detections')[0][0], 1)

    def test_new_detections_found_matchups_with_the_anchor_id(self):
        self.migrate()
        self.db.execute("INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence,igd) VALUES('d4','c2',2,'A','a',99,0.9,1)")
        anchor = self.q("SELECT id,matchup_id FROM matchup_anchors WHERE current_detection_id='d4'")[0]
        self.assertEqual(anchor[0], anchor[1])
        self.assertEqual(self.q(f'SELECT status,origin,merged_into FROM matchups WHERE id={anchor[0]}'), [('visible', 'auto', None)])
        self.assertEqual(self.q('SELECT count(*) FROM matchups')[0][0], 4)
        self.db.execute("UPDATE detections SET frame_time_seconds=60 WHERE id='d4'")
        moved = self.q("SELECT id,matchup_id FROM matchup_anchors WHERE current_detection_id='d4'")[0]
        self.assertEqual(moved[0], moved[1])
        self.assertNotEqual(moved[0], anchor[0])
        self.assertEqual(self.q('SELECT count(*) FROM matchups')[0][0], 5)
        with self.assertRaises(sqlite3.DatabaseError):
            self.db.execute('UPDATE matchup_anchors SET matchup_id=NULL WHERE id=1')
        with self.assertRaises(sqlite3.DatabaseError):
            self.db.execute('UPDATE matchup_anchors SET anchor_seconds=1 WHERE id=1')

    def test_trigger_and_view_names(self):
        self.migrate()
        triggers = {name for (name,) in self.q("SELECT name FROM sqlite_master WHERE type='trigger'")}
        for name in ['matchup_anchor_immutable', 'matchup_anchor_detection_insert_guard', 'matchup_anchor_detection_update_guard',
                     'matchup_anchor_founding', 'matchup_anchor_matchup_required', 'detection_anchor_insert', 'detection_anchor_update',
                     'matchup_visibility_revision', 'matchup_hidden_insert_revision', 'matchup_hidden_delete_revision',
                     'search_anchor_replacement', 'search_matchup_status', 'search_appearance_insert', 'search_appearance_delete']:
            self.assertIn(name, triggers)
        self.assertFalse({name for name in triggers if name.startswith('clip_') or name.startswith('detection_clip') or name == 'search_clip_replacement'})
        self.assertEqual(self.q("SELECT name FROM sqlite_master WHERE type IN('view','trigger','table') AND sql LIKE '%clips%'"), [])


if __name__ == '__main__':
    unittest.main()
