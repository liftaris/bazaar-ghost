-- M3: Matchup entity, social records move to Matchups, `clips` becomes `matchup_anchors`.
-- Matchup IDs are INTEGER and equal the former clip IDs, so /matchups/:id URLs and social
-- references keep working. The anchor table is renamed in place (never dropped) so ON DELETE
-- CASCADE children such as clip_appearances are not touched; social tables are rebuilt by
-- creating the replacement first and dropping the old table only after its rows were copied.
CREATE TABLE matchups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'visible' CHECK(status IN('visible','hidden')),
  merged_into INTEGER REFERENCES matchups(id),
  origin TEXT NOT NULL DEFAULT 'auto' CHECK(origin IN('auto','manual','legacy-group')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(merged_into IS NULL OR merged_into!=id)
);
CREATE INDEX matchups_visible ON matchups(status,id);
CREATE INDEX matchups_merged ON matchups(merged_into) WHERE merged_into IS NOT NULL;
CREATE TABLE m3_seq AS SELECT name,seq FROM sqlite_sequence WHERE name IN('clips','clip_comments','social_reports','social_moderation_audit');
INSERT INTO matchups(id,status,created_at,updated_at) SELECT id,status,created_at,created_at FROM clips ORDER BY id;
INSERT INTO sqlite_sequence(name,seq) SELECT 'matchups',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='matchups');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM m3_seq WHERE name='clips'),0),coalesce((SELECT max(id) FROM clips),0)) WHERE name='matchups';

DROP VIEW streamers_with_detections;
DROP VIEW detection_search;
DROP VIEW video_detections;
DROP VIEW public_matchups;
DROP TRIGGER detection_clip_insert;
DROP TRIGGER detection_clip_update;
DROP TRIGGER clip_anchor_immutable;
DROP TRIGGER clip_detection_insert_guard;
DROP TRIGGER clip_detection_update_guard;
DROP TRIGGER clip_visibility_revision;
DROP TRIGGER clip_hidden_insert_revision;
DROP TRIGGER clip_hidden_delete_revision;
DROP TRIGGER search_clip_replacement;
DROP INDEX clips_visible;

ALTER TABLE clips RENAME TO matchup_anchors;
ALTER TABLE matchup_anchors ADD COLUMN matchup_id INTEGER REFERENCES matchups(id);
UPDATE matchup_anchors SET matchup_id=id;
ALTER TABLE matchup_anchors DROP COLUMN status;
CREATE INDEX matchup_anchors_matchup ON matchup_anchors(matchup_id,id);

CREATE TRIGGER matchup_anchor_immutable BEFORE UPDATE OF vod_id,anchor_seconds ON matchup_anchors
WHEN NEW.vod_id!=OLD.vod_id OR NEW.anchor_seconds!=OLD.anchor_seconds
BEGIN SELECT RAISE(ABORT,'Anchors are immutable'); END;
CREATE TRIGGER matchup_anchor_detection_insert_guard BEFORE INSERT ON matchup_anchors
WHEN NEW.current_detection_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM detections WHERE id=NEW.current_detection_id AND vod_id=NEW.vod_id AND frame_time_seconds=NEW.anchor_seconds)
BEGIN SELECT RAISE(ABORT,'Anchor detection must match exact anchor'); END;
CREATE TRIGGER matchup_anchor_detection_update_guard BEFORE UPDATE OF current_detection_id ON matchup_anchors
WHEN NEW.current_detection_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM detections WHERE id=NEW.current_detection_id AND vod_id=NEW.vod_id AND frame_time_seconds=NEW.anchor_seconds)
BEGIN SELECT RAISE(ABORT,'Anchor detection must match exact anchor'); END;
-- The only place a Matchup is born: an anchor inserted without one founds a Matchup with its own ID.
CREATE TRIGGER matchup_anchor_founding AFTER INSERT ON matchup_anchors WHEN NEW.matchup_id IS NULL BEGIN
  INSERT INTO matchups(id) VALUES(NEW.id);
  UPDATE matchup_anchors SET matchup_id=NEW.id WHERE id=NEW.id;
END;
CREATE TRIGGER matchup_anchor_matchup_required BEFORE UPDATE OF matchup_id ON matchup_anchors WHEN NEW.matchup_id IS NULL
BEGIN SELECT RAISE(ABORT,'Anchor must belong to a Matchup'); END;
CREATE TRIGGER detection_anchor_insert AFTER INSERT ON detections WHEN NEW.confidence>0.7 BEGIN
  INSERT INTO matchup_anchors(vod_id,anchor_seconds,current_detection_id) VALUES(NEW.vod_id,NEW.frame_time_seconds,NEW.id)
  ON CONFLICT(vod_id,anchor_seconds) DO UPDATE SET current_detection_id=excluded.current_detection_id;
END;
CREATE TRIGGER detection_anchor_update AFTER UPDATE OF vod_id,frame_time_seconds,confidence ON detections BEGIN
  UPDATE matchup_anchors SET current_detection_id=NULL WHERE current_detection_id=OLD.id;
  INSERT INTO matchup_anchors(vod_id,anchor_seconds,current_detection_id)
  SELECT NEW.vod_id,NEW.frame_time_seconds,NEW.id WHERE NEW.confidence>0.7
  ON CONFLICT(vod_id,anchor_seconds) DO UPDATE SET current_detection_id=excluded.current_detection_id;
END;
CREATE TRIGGER matchup_visibility_revision AFTER UPDATE OF status ON matchups WHEN NEW.status!=OLD.status BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER matchup_hidden_insert_revision AFTER INSERT ON matchups WHEN NEW.status='hidden' BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER matchup_hidden_delete_revision AFTER DELETE ON matchups WHEN OLD.status='hidden' BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_anchor_replacement AFTER UPDATE OF current_detection_id ON matchup_anchors
WHEN NEW.current_detection_id IS NOT OLD.current_detection_id BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_matchup_status AFTER UPDATE OF status ON matchups WHEN NEW.status!=OLD.status BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;

-- Social records follow the Matchup; origin_id remembers the Matchup a record was made on (merge/split).
CREATE TABLE matchup_likes(
  matchup_id INTEGER NOT NULL REFERENCES matchups(id),
  origin_id INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(origin_id,user_id)
) WITHOUT ROWID;
CREATE INDEX matchup_likes_matchup ON matchup_likes(matchup_id,user_id);
CREATE INDEX matchup_likes_user ON matchup_likes(user_id,matchup_id);
INSERT INTO matchup_likes(matchup_id,origin_id,user_id,created_at) SELECT clip_id,clip_id,user_id,created_at FROM clip_likes;
-- Favorite and heart are API aliases for this SAME private bookmark.
CREATE TABLE matchup_favorites(
  matchup_id INTEGER NOT NULL REFERENCES matchups(id),
  origin_id INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(origin_id,user_id)
) WITHOUT ROWID;
CREATE INDEX matchup_favorites_matchup ON matchup_favorites(matchup_id,user_id);
CREATE INDEX matchup_favorites_user ON matchup_favorites(user_id,matchup_id);
INSERT INTO matchup_favorites(matchup_id,origin_id,user_id,created_at) SELECT clip_id,clip_id,user_id,created_at FROM clip_favorites;
CREATE TABLE matchup_comments(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  matchup_id INTEGER NOT NULL REFERENCES matchups(id),
  origin_id INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  body TEXT,
  original_body_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  status TEXT NOT NULL DEFAULT 'visible' CHECK(status IN('visible','hidden','deleted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((status='deleted' AND body IS NULL) OR (status!='deleted' AND body IS NOT NULL AND length(body) BETWEEN 1 AND 2000))
);
CREATE INDEX matchup_comments_public ON matchup_comments(matchup_id,status,sequence);
CREATE INDEX matchup_comments_author ON matchup_comments(author_id);
INSERT INTO matchup_comments(sequence,id,matchup_id,origin_id,author_id,body,original_body_hash,version,status,created_at,updated_at)
SELECT sequence,id,clip_id,clip_id,author_id,body,original_body_hash,version,status,created_at,updated_at FROM clip_comments ORDER BY sequence;
-- The unique report key is the origin Matchup, which never changes, so a merge cannot make two reports collide.
CREATE TABLE social_reports_v2(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  reporter_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  matchup_id INTEGER REFERENCES matchups(id),
  origin_id INTEGER,
  comment_id TEXT REFERENCES matchup_comments(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved','dismissed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((matchup_id IS NULL)!=(comment_id IS NULL)),
  CHECK((matchup_id IS NULL)=(origin_id IS NULL))
);
INSERT INTO social_reports_v2(sequence,id,reporter_id,matchup_id,origin_id,comment_id,reason,status,created_at,updated_at)
SELECT sequence,id,reporter_id,clip_id,clip_id,comment_id,reason,status,created_at,updated_at FROM social_reports ORDER BY sequence;
CREATE TABLE social_moderation_audit_v2(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK(target_type IN('matchup','comment','user','report')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'admin-key' CHECK(actor='admin-key'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO social_moderation_audit_v2(sequence,request_id,target_type,target_id,action,reason,actor,created_at)
SELECT sequence,request_id,CASE target_type WHEN 'clip' THEN 'matchup' ELSE target_type END,target_id,action,reason,actor,created_at
FROM social_moderation_audit ORDER BY sequence;

DROP TABLE social_reports;
DROP TABLE clip_comments;
DROP TABLE clip_likes;
DROP TABLE clip_favorites;
DROP TABLE social_moderation_audit;
ALTER TABLE social_reports_v2 RENAME TO social_reports;
ALTER TABLE social_moderation_audit_v2 RENAME TO social_moderation_audit;
CREATE UNIQUE INDEX social_reports_matchup_once ON social_reports(reporter_id,origin_id) WHERE origin_id IS NOT NULL;
CREATE UNIQUE INDEX social_reports_comment_once ON social_reports(reporter_id,comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX social_reports_queue ON social_reports(status,sequence);
CREATE INDEX social_reports_reporter ON social_reports(reporter_id);
CREATE INDEX social_reports_matchup ON social_reports(matchup_id);
CREATE INDEX social_reports_comment ON social_reports(comment_id);

-- Keep AUTOINCREMENT high-water marks even when the highest old rows were deleted.
INSERT INTO sqlite_sequence(name,seq) SELECT 'matchup_comments',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='matchup_comments');
INSERT INTO sqlite_sequence(name,seq) SELECT 'social_reports',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='social_reports');
INSERT INTO sqlite_sequence(name,seq) SELECT 'social_moderation_audit',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='social_moderation_audit');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM m3_seq WHERE name='clip_comments'),0)) WHERE name='matchup_comments';
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM m3_seq WHERE name='social_reports'),0)) WHERE name='social_reports';
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM m3_seq WHERE name='social_moderation_audit'),0)) WHERE name='social_moderation_audit';
DROP TABLE m3_seq;

CREATE VIEW detection_search AS SELECT
 d.id AS detection_id,d.username,d.frame_time_seconds,d.confidence,d.rank,d.storage_path,d.no_right_edge,d.truncated,d.igd,d.created_at AS detection_created_at,
 v.id AS vod_id,v.source_id AS vod_source_id,v.title AS vod_title,v.published_at AS vod_published_at,v.duration_seconds AS vod_duration_seconds,v.availability AS vod_availability,
 strftime('%Y-%m-%dT%H:%M:%fZ',v.published_at,'+'||d.frame_time_seconds||' seconds') AS actual_timestamp,
 s.id AS streamer_id,s.login AS streamer_login,s.display_name AS streamer_display_name,s.profile_image_url AS streamer_avatar,
 'https://www.twitch.tv/videos/'||v.source_id||'?t='||d.frame_time_seconds||'s' AS vod_url,d.username_lower
 FROM detections d JOIN vods v ON v.id=d.vod_id JOIN streamers s ON s.id=v.streamer_id
 WHERE v.source='twitch' AND v.availability='available' AND d.confidence>0.7
 AND NOT EXISTS(SELECT 1 FROM matchup_anchors c JOIN matchups m ON m.id=c.matchup_id WHERE c.vod_id=d.vod_id AND c.anchor_seconds=d.frame_time_seconds AND m.status='hidden');
CREATE VIEW video_detections AS SELECT d.id AS detection_id,d.username,d.confidence,d.rank,d.frame_time_seconds,
 d.storage_path,d.no_right_edge,d.truncated,d.igd,d.created_at AS indexed_at,
 v.id AS vod_id,v.source,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,v.title,v.published_at,v.recorded_at,
 v.platform_account_id,v.streamer_id,coalesce(a.display_name,s.display_name,s.login) AS creator_name,
 strftime('%Y-%m-%dT%H:%M:%fZ',v.recorded_at,'+'||d.frame_time_seconds||' seconds') AS recorded_timestamp
 FROM detections d JOIN vods v ON v.id=d.vod_id LEFT JOIN platform_accounts a ON a.id=v.platform_account_id
 LEFT JOIN streamers s ON s.id=v.streamer_id WHERE v.availability='available' AND d.confidence>0.7
 AND NOT EXISTS(SELECT 1 FROM matchup_anchors c JOIN matchups m ON m.id=c.matchup_id WHERE c.vod_id=d.vod_id AND c.anchor_seconds=d.frame_time_seconds AND m.status='hidden');
CREATE VIEW streamers_with_detections AS SELECT s.id AS streamer_id,s.login AS streamer_login,s.display_name AS streamer_display_name,s.profile_image_url AS streamer_avatar,s.processing_enabled,
 count(d.detection_id) AS detection_count,count(DISTINCT d.vod_id) AS vod_count,max(d.actual_timestamp) AS latest_detection_timestamp
 FROM streamers s JOIN detection_search d ON d.streamer_id=s.id GROUP BY s.id;
CREATE VIEW public_matchups AS SELECT c.id AS matchup_id,d.*,p.creator_id,p.creator_source_id,p.creator_login,p.creator_avatar,
  p.duration_seconds,p.availability,p.status,p.bazaar_chapters,c.matchup_id AS canonical_id
FROM matchup_anchors c JOIN matchups m ON m.id=c.matchup_id JOIN video_detections d ON d.detection_id=c.current_detection_id
JOIN public_videos p ON p.id=c.vod_id
WHERE m.status='visible';
