-- Platform identity moves out of the schema: the supported list lives in contracts/platforms.json
-- and tables keep only a format-checked platform string. Parents are rebuilt like 0002 with deferred
-- FK validation. DROP TABLE cascades even while FKs are deferred, so rows that cascade from the
-- rebuilt parents are copied aside and restored.
PRAGMA defer_foreign_keys=ON;
DROP VIEW public_matchups;
DROP VIEW public_videos;
DROP VIEW video_detections;
DROP VIEW vod_processing_context;
DROP VIEW streamer_detection_stats;
DROP VIEW vod_stats;
DROP VIEW streamers_with_detections;
DROP VIEW vod_embed_info;
DROP VIEW detection_search;
DROP TRIGGER chunks_status_changed;
DROP TRIGGER detection_outbox;
DROP TRIGGER search_video_change;
DROP TRIGGER search_account_change;
DROP TRIGGER clip_anchor_immutable;
DROP TRIGGER clip_detection_insert_guard;
DROP TRIGGER clip_detection_update_guard;
DROP TRIGGER clip_visibility_revision;
DROP TRIGGER clip_hidden_insert_revision;
DROP TRIGGER clip_hidden_delete_revision;
DROP TRIGGER search_clip_replacement;
DROP TRIGGER search_appearance_insert;
DROP TRIGGER search_appearance_delete;

CREATE TABLE m1_clips AS SELECT * FROM clips;
CREATE TABLE m1_clip_appearances AS SELECT * FROM clip_appearances;
CREATE TABLE m1_clip_likes AS SELECT * FROM clip_likes;
CREATE TABLE m1_clip_favorites AS SELECT * FROM clip_favorites;
CREATE TABLE m1_clip_comments AS SELECT * FROM clip_comments;
CREATE TABLE m1_social_reports AS SELECT * FROM social_reports;
CREATE TABLE m1_websub_subscriptions AS SELECT * FROM youtube_websub_subscriptions;
CREATE TABLE m1_websub_deliveries AS SELECT * FROM youtube_websub_deliveries;
CREATE TABLE m1_ingestion_jobs AS SELECT * FROM platform_ingestion_jobs;

CREATE TABLE platform_accounts_next (
 id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9_-]*'), source_id TEXT NOT NULL,
 display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200), streamer_id INTEGER REFERENCES streamers(id),
 sfde_profile_id INTEGER NOT NULL DEFAULT 1 REFERENCES sfde_profiles(id), processing_enabled INTEGER NOT NULL DEFAULT 0 CHECK(processing_enabled IN(0,1)),
 catalog_cursor INTEGER NOT NULL DEFAULT 1 CHECK(catalog_cursor>0), archive_cursor INTEGER NOT NULL DEFAULT 1 CHECK(archive_cursor>0),
 last_cataloged_at TEXT, created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(source,source_id), UNIQUE(id,source)
);
INSERT INTO platform_accounts_next(id,source,source_id,display_name,streamer_id,sfde_profile_id,processing_enabled,catalog_cursor,archive_cursor,last_cataloged_at,created_at)
 SELECT id,source,source_id,display_name,streamer_id,sfde_profile_id,processing_enabled,catalog_cursor,archive_cursor,last_cataloged_at,created_at FROM platform_accounts;

DROP TABLE platform_ingestion_jobs;
DROP TABLE platform_accounts;
ALTER TABLE platform_accounts_next RENAME TO platform_accounts;
CREATE TABLE platform_ingestion_jobs (
 id TEXT PRIMARY KEY,source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9_-]*'),kind TEXT NOT NULL CHECK(kind IN('account','video','discovery')),source_id TEXT NOT NULL,
 account_id TEXT,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','waiting','processing','completed','skipped')),
 next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),last_attempt_at TEXT,completed_at TEXT,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),last_error TEXT,
 state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state) AND json_type(state)='object'),lease_token TEXT,lease_expires_at TEXT,
 rerun_requested INTEGER NOT NULL DEFAULT 0 CHECK(rerun_requested IN(0,1)),created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(source,kind,source_id),FOREIGN KEY(account_id,source) REFERENCES platform_accounts(id,source) ON DELETE CASCADE,CHECK(kind<>'account' OR account_id IS NOT NULL)
);
INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,account_id,status,next_attempt_at,last_attempt_at,completed_at,attempts,last_error,state,lease_token,lease_expires_at,rerun_requested,created_at)
 SELECT id,source,kind,source_id,account_id,status,next_attempt_at,last_attempt_at,completed_at,attempts,last_error,state,lease_token,lease_expires_at,rerun_requested,created_at FROM m1_ingestion_jobs;
CREATE INDEX ingestion_due ON platform_ingestion_jobs(next_attempt_at,status);
INSERT INTO youtube_websub_subscriptions SELECT * FROM m1_websub_subscriptions;
INSERT INTO youtube_websub_deliveries SELECT * FROM m1_websub_deliveries;

CREATE TABLE vods_next (
 id INTEGER PRIMARY KEY AUTOINCREMENT, streamer_id INTEGER REFERENCES streamers(id),
 source TEXT NOT NULL DEFAULT 'twitch' CHECK(length(source) BETWEEN 1 AND 32 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9_-]*'),
 source_id TEXT NOT NULL, title TEXT, duration_seconds INTEGER NOT NULL CHECK(duration_seconds>0), published_at TEXT,
 availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN('available','unavailable','unknown','checking','expired')),
 last_availability_check TEXT, unavailable_since TEXT, ready_for_processing INTEGER NOT NULL DEFAULT 0 CHECK(ready_for_processing IN(0,1)),
 bazaar_chapters TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(bazaar_chapters)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','completed','failed','partial')),
 created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), platform_account_id TEXT, sfde_profile_id INTEGER REFERENCES sfde_profiles(id), recorded_at TEXT,
 template_version TEXT NOT NULL DEFAULT 'auto' CHECK(template_version IN('auto','old','current')),
 content_kind TEXT NOT NULL DEFAULT 'archive' CHECK(content_kind IN('archive','upload')),
 notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK(notifications_enabled IN(0,1)),
 source_video_id TEXT, source_part_id TEXT, source_part_index INTEGER CHECK(source_part_index>0),
 FOREIGN KEY(platform_account_id,source) REFERENCES platform_accounts(id,source),
 CHECK(streamer_id IS NOT NULL OR platform_account_id IS NOT NULL),
 CHECK(source_part_id IS NULL OR (source_video_id IS NOT NULL AND source_part_index IS NOT NULL AND source_id=source_video_id||':'||source_part_id)),
 UNIQUE(source,source_id)
);
INSERT INTO vods_next(id,streamer_id,source,source_id,title,duration_seconds,published_at,availability,last_availability_check,unavailable_since,ready_for_processing,bazaar_chapters,status,created_at,updated_at,platform_account_id,sfde_profile_id,recorded_at,template_version,content_kind,notifications_enabled,source_video_id,source_part_id,source_part_index)
 SELECT id,streamer_id,source,source_id,title,duration_seconds,published_at,availability,last_availability_check,unavailable_since,ready_for_processing,bazaar_chapters,status,created_at,updated_at,platform_account_id,sfde_profile_id,recorded_at,template_version,content_kind,notifications_enabled,source_video_id,source_part_id,source_part_index FROM vods;
-- Twitch's published time is the recording start; views no longer special-case it.
UPDATE vods_next SET recorded_at=published_at WHERE recorded_at IS NULL AND streamer_id IS NOT NULL AND platform_account_id IS NULL;
INSERT INTO sqlite_sequence(name,seq) SELECT 'vods_next',seq FROM sqlite_sequence WHERE name='vods' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='vods_next');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='vods'),0)) WHERE name='vods_next';
DROP TABLE vods;
ALTER TABLE vods_next RENAME TO vods;
CREATE INDEX vods_streamer ON vods(streamer_id,published_at DESC);
CREATE INDEX vods_availability ON vods(source,availability,last_availability_check);
CREATE INDEX vods_account ON vods(platform_account_id,published_at DESC);

INSERT INTO clips SELECT * FROM m1_clips;
INSERT INTO clip_appearances SELECT * FROM m1_clip_appearances;
INSERT INTO clip_likes SELECT * FROM m1_clip_likes;
INSERT INTO clip_favorites SELECT * FROM m1_clip_favorites;
INSERT INTO clip_comments SELECT * FROM m1_clip_comments;
INSERT INTO social_reports SELECT * FROM m1_social_reports;
DROP TABLE m1_clips;
DROP TABLE m1_clip_appearances;
DROP TABLE m1_clip_likes;
DROP TABLE m1_clip_favorites;
DROP TABLE m1_clip_comments;
DROP TABLE m1_social_reports;
DROP TABLE m1_websub_subscriptions;
DROP TABLE m1_websub_deliveries;
DROP TABLE m1_ingestion_jobs;

ALTER TABLE platform_settings ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK(notifications_enabled IN(0,1));
-- One-off: preserves the former trigger, which notified only for the first platform.
UPDATE platform_settings SET notifications_enabled=1 WHERE source='twitch';

CREATE TRIGGER chunks_status_changed AFTER UPDATE OF status ON chunks BEGIN
 UPDATE vods SET status=CASE
 WHEN EXISTS(SELECT 1 FROM chunks WHERE vod_id=NEW.vod_id AND status IN('processing','queued')) THEN 'processing'
 WHEN NOT EXISTS(SELECT 1 FROM chunks WHERE vod_id=NEW.vod_id AND status NOT IN('completed','archived')) THEN 'completed'
 WHEN EXISTS(SELECT 1 FROM chunks WHERE vod_id=NEW.vod_id AND status='completed') THEN 'partial'
 WHEN EXISTS(SELECT 1 FROM chunks WHERE vod_id=NEW.vod_id AND status='failed') THEN 'failed'
 ELSE 'pending' END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.vod_id;
END;
CREATE TRIGGER detection_outbox AFTER INSERT ON detections WHEN NEW.confidence>0.7 AND EXISTS(
 SELECT 1 FROM vods v JOIN platform_settings ps ON ps.source=v.source
 WHERE v.id=NEW.vod_id AND v.notifications_enabled=1 AND ps.notifications_enabled=1
) BEGIN INSERT INTO notification_outbox(detection_id) VALUES(NEW.id); END;
CREATE TRIGGER search_video_change AFTER UPDATE OF availability,published_at,recorded_at ON vods
WHEN NEW.availability!=OLD.availability OR NEW.published_at IS NOT OLD.published_at OR NEW.recorded_at IS NOT OLD.recorded_at BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_account_change AFTER UPDATE OF display_name ON platform_accounts
WHEN NEW.display_name!=OLD.display_name BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER clip_anchor_immutable BEFORE UPDATE OF vod_id,anchor_seconds ON clips
WHEN NEW.vod_id!=OLD.vod_id OR NEW.anchor_seconds!=OLD.anchor_seconds
BEGIN SELECT RAISE(ABORT,'Clip anchors are immutable'); END;
CREATE TRIGGER clip_detection_insert_guard BEFORE INSERT ON clips
WHEN NEW.current_detection_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM detections WHERE id=NEW.current_detection_id AND vod_id=NEW.vod_id AND frame_time_seconds=NEW.anchor_seconds)
BEGIN SELECT RAISE(ABORT,'Clip detection must match exact anchor'); END;
CREATE TRIGGER clip_detection_update_guard BEFORE UPDATE OF current_detection_id ON clips
WHEN NEW.current_detection_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM detections WHERE id=NEW.current_detection_id AND vod_id=NEW.vod_id AND frame_time_seconds=NEW.anchor_seconds)
BEGIN SELECT RAISE(ABORT,'Clip detection must match exact anchor'); END;
CREATE TRIGGER clip_visibility_revision AFTER UPDATE OF status ON clips WHEN NEW.status!=OLD.status BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER clip_hidden_insert_revision AFTER INSERT ON clips WHEN NEW.status='hidden' BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER clip_hidden_delete_revision AFTER DELETE ON clips WHEN OLD.status='hidden' BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_clip_replacement AFTER UPDATE OF current_detection_id,status ON clips
WHEN NEW.current_detection_id IS NOT OLD.current_detection_id OR NEW.status!=OLD.status BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_appearance_insert AFTER INSERT ON clip_appearances BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_appearance_delete AFTER DELETE ON clip_appearances BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;

CREATE VIEW detection_search AS SELECT
 d.id AS detection_id,d.username,d.frame_time_seconds,d.confidence,d.rank,d.storage_path,d.no_right_edge,d.truncated,d.igd,d.created_at AS detection_created_at,
 v.id AS vod_id,v.source_id AS vod_source_id,v.title AS vod_title,v.published_at AS vod_published_at,v.duration_seconds AS vod_duration_seconds,v.availability AS vod_availability,
 strftime('%Y-%m-%dT%H:%M:%fZ',v.published_at,'+'||d.frame_time_seconds||' seconds') AS actual_timestamp,
 s.id AS streamer_id,s.login AS streamer_login,s.display_name AS streamer_display_name,s.profile_image_url AS streamer_avatar,
 'https://www.twitch.tv/videos/'||v.source_id||'?t='||d.frame_time_seconds||'s' AS vod_url,d.username_lower
 FROM detections d JOIN vods v ON v.id=d.vod_id JOIN streamers s ON s.id=v.streamer_id
 WHERE v.source='twitch' AND v.availability='available' AND d.confidence>0.7
 AND NOT EXISTS(SELECT 1 FROM clips c WHERE c.vod_id=d.vod_id AND c.anchor_seconds=d.frame_time_seconds AND c.status='hidden');
CREATE VIEW vod_embed_info AS SELECT v.id AS vod_id,v.source_id AS vod_source_id,v.title,v.published_at,v.duration_seconds,v.bazaar_chapters,v.availability,
 s.id AS streamer_id,s.login AS streamer_login,s.display_name AS streamer_display_name,s.profile_image_url AS streamer_avatar FROM vods v JOIN streamers s ON s.id=v.streamer_id WHERE v.source='twitch';
CREATE VIEW streamers_with_detections AS SELECT s.id AS streamer_id,s.login AS streamer_login,s.display_name AS streamer_display_name,s.profile_image_url AS streamer_avatar,s.processing_enabled,
 count(d.detection_id) AS detection_count,count(DISTINCT d.vod_id) AS vod_count,max(d.actual_timestamp) AS latest_detection_timestamp
 FROM streamers s JOIN detection_search d ON d.streamer_id=s.id GROUP BY s.id;
CREATE VIEW vod_stats AS SELECT v.*,s.display_name AS streamer,
 (SELECT count(*) FROM detections d WHERE d.vod_id=v.id) AS total_detections,
 (SELECT avg(confidence) FROM detections d WHERE d.vod_id=v.id) AS avg_confidence,
 (SELECT count(*) FROM chunks c WHERE c.vod_id=v.id) AS chunks,
 (SELECT CASE WHEN count(DISTINCT quality)=1 AND v.status!='pending' THEN max(quality) END FROM chunks c WHERE c.vod_id=v.id) AS quality
 FROM vods v JOIN streamers s ON s.id=v.streamer_id WHERE v.source='twitch';
CREATE VIEW streamer_detection_stats AS SELECT s.id AS streamer_id,s.login,s.display_name,count(d.id) AS total_detections,avg(d.confidence) AS avg_confidence,
 count(d.id) FILTER(WHERE d.no_right_edge=1) AS no_right_edge_detections,
 count(DISTINCT v.id) FILTER(WHERE v.status='processing') AS vods_processing,count(DISTINCT v.id) FILTER(WHERE v.status='completed') AS vods_completed,
 count(DISTINCT v.id) FILTER(WHERE v.status='failed') AS vods_failed,count(DISTINCT v.id) FILTER(WHERE v.status='partial') AS vods_partial,
 count(DISTINCT v.id) FILTER(WHERE v.status='pending') AS vods_pending,count(DISTINCT v.id) AS total_vods,
 coalesce(round(1.0*count(d.id)/nullif(count(DISTINCT v.id),0),2),0) AS avg_detections_per_vod
 FROM streamers s LEFT JOIN vods v ON v.streamer_id=s.id AND v.source='twitch' LEFT JOIN detections d ON d.vod_id=v.id GROUP BY s.id;
CREATE VIEW vod_processing_context AS SELECT v.*,
 CASE WHEN v.platform_account_id IS NOT NULL THEN a.processing_enabled ELSE s.processing_enabled END AS processing_enabled,
 coalesce(v.sfde_profile_id,a.sfde_profile_id,s.sfde_profile_id,1) AS effective_profile_id,
 coalesce(a.display_name,s.display_name,s.login) AS creator_name,
 CASE WHEN v.template_version='old' THEN 1 WHEN v.template_version='current' THEN 0
 ELSE coalesce(coalesce(v.recorded_at,v.published_at)<'2025-08-12T00:00:00.000Z',0) END AS old_templates
 FROM vods v LEFT JOIN platform_accounts a ON a.id=v.platform_account_id LEFT JOIN streamers s ON s.id=v.streamer_id;
CREATE VIEW video_detections AS SELECT d.id AS detection_id,d.username,d.confidence,d.rank,d.frame_time_seconds,
 d.storage_path,d.no_right_edge,d.truncated,d.igd,d.created_at AS indexed_at,
 v.id AS vod_id,v.source,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,v.title,v.published_at,v.recorded_at,
 v.platform_account_id,v.streamer_id,coalesce(a.display_name,s.display_name,s.login) AS creator_name,
 strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(v.recorded_at,v.published_at),'+'||d.frame_time_seconds||' seconds') AS recorded_timestamp
 FROM detections d JOIN vods v ON v.id=d.vod_id LEFT JOIN platform_accounts a ON a.id=v.platform_account_id
 LEFT JOIN streamers s ON s.id=v.streamer_id WHERE v.availability='available' AND d.confidence>0.7
 AND NOT EXISTS(SELECT 1 FROM clips c WHERE c.vod_id=d.vod_id AND c.anchor_seconds=d.frame_time_seconds AND c.status='hidden');
CREATE VIEW public_videos AS SELECT v.*,
  CASE WHEN v.source='twitch' THEN 'twitch:'||s.id ELSE v.source||':'||a.id END AS creator_id,
  CASE WHEN v.source='twitch' THEN cast(s.id AS TEXT) ELSE a.source_id END AS creator_source_id,
  coalesce(a.display_name,s.display_name,s.login) AS creator_name,
  CASE WHEN v.source='twitch' THEN s.login END AS creator_login,
  CASE WHEN v.source='twitch' THEN s.profile_image_url END AS creator_avatar
FROM vods v LEFT JOIN streamers s ON s.id=v.streamer_id LEFT JOIN platform_accounts a ON a.id=v.platform_account_id;
CREATE VIEW public_matchups AS SELECT c.id AS matchup_id,d.*,p.creator_id,p.creator_source_id,p.creator_login,p.creator_avatar,
  p.duration_seconds,p.availability,p.status,p.bazaar_chapters
FROM clips c JOIN video_detections d ON d.detection_id=c.current_detection_id
JOIN public_videos p ON p.id=c.vod_id
WHERE c.status='visible';
PRAGMA defer_foreign_keys=OFF;
