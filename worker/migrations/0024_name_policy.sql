-- Observed OCR text is retained independently of identity/search eligibility.
-- Quiesce processor writes and apply this entire rebuild atomically. Never rename
-- the old parent: SQLite would retarget incoming anchor FKs to the old table.
CREATE TABLE name_policy_anchor_pointers AS SELECT id,current_detection_id FROM matchup_anchors;
DROP VIEW public_matchups;
DROP VIEW public_sources;
DROP VIEW streamer_detection_stats;
DROP VIEW public_recordings;
DROP TRIGGER matchup_anchor_detection_insert_guard;
DROP TRIGGER matchup_anchor_detection_update_guard;
DROP TRIGGER matchup_notification_founding;
UPDATE matchup_anchors SET current_detection_id=NULL WHERE current_detection_id IS NOT NULL;

CREATE TABLE detections_next (
 id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL REFERENCES chunks(id), vod_id INTEGER NOT NULL REFERENCES vods(id), username TEXT,
 username_lower TEXT REFERENCES search_names(name), confidence REAL CHECK(confidence BETWEEN 0 AND 1),
 rank TEXT CHECK(rank IN('bronze','silver','gold','diamond','legend')), frame_time_seconds INTEGER NOT NULL,
 storage_path TEXT, no_right_edge INTEGER DEFAULT 0 CHECK(no_right_edge IN(0,1)), truncated INTEGER DEFAULT 0 CHECK(truncated IN(0,1)),
 igd INTEGER CHECK(igd BETWEEN 1 AND 20), created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 name_state TEXT NOT NULL DEFAULT 'legacy' CHECK(name_state IN('legacy','complete','partial','obstructed','masked','unreadable')),
 encounter_confidence REAL CHECK(encounter_confidence BETWEEN 0 AND 1),
 ghost_hero TEXT CHECK(ghost_hero IN('vanessa','pygmalien','dooley','mak','jules','stelle','karnok','the_dragons')),
 streamer_hero TEXT CHECK(streamer_hero IN('vanessa','pygmalien','dooley','mak','jules','stelle','karnok','the_dragons')),
 wins_remaining INTEGER CHECK(wins_remaining IS NULL OR (typeof(wins_remaining)='integer' AND wins_remaining BETWEEN 0 AND 10)),
 lethal INTEGER CHECK(lethal IN(0,1)),
 field_evidence TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(field_evidence) AND json_type(field_evidence)='object'),
 publish_id TEXT, publish_claim TEXT, publish_body TEXT,
 CHECK((username IS NULL)=(username_lower IS NULL)),
 CHECK((name_state IN('legacy','complete') AND username IS NOT NULL) OR
       (name_state IN('partial','obstructed') AND (username IS NOT NULL OR confidence IS NULL)) OR
       (name_state IN('masked','unreadable') AND username IS NULL AND confidence IS NULL)),
 CHECK(name_state='legacy' OR encounter_confidence IS NOT NULL),
 CHECK(name_state!='complete' OR length(trim(username))>0),
 UNIQUE(chunk_id,frame_time_seconds)
);
INSERT INTO detections_next(id,chunk_id,vod_id,username,username_lower,confidence,rank,frame_time_seconds,storage_path,no_right_edge,truncated,igd,created_at,
 name_state,encounter_confidence,ghost_hero,streamer_hero,wins_remaining,lethal,field_evidence,publish_id,publish_claim,publish_body)
SELECT id,chunk_id,vod_id,username,username_lower,confidence,rank,frame_time_seconds,storage_path,no_right_edge,truncated,igd,created_at,
 name_state,encounter_confidence,ghost_hero,streamer_hero,wins_remaining,lethal,field_evidence,publish_id,publish_claim,publish_body FROM detections;
INSERT INTO mutation_checks(id,ok) SELECT 'name-policy-copy',
 (SELECT count(*) FROM detections)=(SELECT count(*) FROM detections_next)
 AND NOT EXISTS(SELECT * FROM detections EXCEPT SELECT * FROM detections_next)
 AND NOT EXISTS(SELECT * FROM detections_next EXCEPT SELECT * FROM detections);
DELETE FROM mutation_checks WHERE id='name-policy-copy';
DROP TABLE detections;
ALTER TABLE detections_next RENAME TO detections;
CREATE INDEX detections_name ON detections(username_lower,vod_id);
CREATE INDEX detections_vod ON detections(vod_id,frame_time_seconds);
CREATE INDEX detections_chunk ON detections(chunk_id);
CREATE INDEX detections_storage_path ON detections(storage_path);
CREATE UNIQUE INDEX detections_publish_id ON detections(publish_id) WHERE publish_id IS NOT NULL;
CREATE TRIGGER detection_chunk_matches BEFORE INSERT ON detections WHEN NOT EXISTS(
 SELECT 1 FROM chunks WHERE id=NEW.chunk_id AND vod_id=NEW.vod_id AND NEW.frame_time_seconds>=start_seconds AND NEW.frame_time_seconds<end_seconds
) BEGIN SELECT RAISE(ABORT,'detection outside chunk'); END;
CREATE TRIGGER detection_identity_immutable BEFORE UPDATE OF id,chunk_id,vod_id,frame_time_seconds ON detections
WHEN NEW.id IS NOT OLD.id OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.vod_id IS NOT OLD.vod_id OR NEW.frame_time_seconds IS NOT OLD.frame_time_seconds
BEGIN SELECT RAISE(ABORT,'Detection anchor is immutable'); END;
CREATE TRIGGER detection_anchor_insert AFTER INSERT ON detections
WHEN coalesce(NEW.encounter_confidence,CASE WHEN NEW.name_state='legacy' THEN NEW.confidence END)>0.7 BEGIN
 INSERT INTO matchup_anchors(vod_id,anchor_seconds,current_detection_id) VALUES(NEW.vod_id,NEW.frame_time_seconds,NEW.id)
 ON CONFLICT(vod_id,anchor_seconds) DO UPDATE SET current_detection_id=excluded.current_detection_id;
END;
CREATE TRIGGER detection_anchor_update AFTER UPDATE OF confidence,encounter_confidence,name_state ON detections BEGIN
 UPDATE matchup_anchors SET current_detection_id=NULL WHERE current_detection_id=OLD.id
 AND coalesce(NEW.encounter_confidence,CASE WHEN NEW.name_state='legacy' THEN NEW.confidence END,0)<=0.7;
 INSERT INTO matchup_anchors(vod_id,anchor_seconds,current_detection_id)
 SELECT NEW.vod_id,NEW.frame_time_seconds,NEW.id
 WHERE coalesce(NEW.encounter_confidence,CASE WHEN NEW.name_state='legacy' THEN NEW.confidence END)>0.7
 ON CONFLICT(vod_id,anchor_seconds) DO UPDATE SET current_detection_id=excluded.current_detection_id;
END;
CREATE TRIGGER search_detection_update AFTER UPDATE ON detections BEGIN
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
 UPDATE sessions SET coalesce_dirty=coalesce_dirty+1 WHERE id IN(SELECT session_id FROM recording_alignments WHERE vod_id=NEW.vod_id AND revoked_at IS NULL);
 UPDATE vods SET proposals_checked_at=NULL WHERE id=NEW.vod_id;
END;
CREATE TRIGGER search_detection_delete BEFORE DELETE ON detections BEGIN
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER proposal_detection_correction AFTER UPDATE OF username,username_lower,confidence,name_state ON detections
WHEN NEW.username IS NOT OLD.username OR NEW.username_lower IS NOT OLD.username_lower OR NEW.confidence IS NOT OLD.confidence OR NEW.name_state IS NOT OLD.name_state BEGIN
 UPDATE session_link_proposals SET status='superseded' WHERE status='pending' AND (vod_a=NEW.vod_id OR vod_b=NEW.vod_id);
END;
CREATE TRIGGER matchup_anchor_detection_insert_guard BEFORE INSERT ON matchup_anchors
WHEN NEW.current_detection_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM detections WHERE id=NEW.current_detection_id AND vod_id=NEW.vod_id AND frame_time_seconds=NEW.anchor_seconds)
BEGIN SELECT RAISE(ABORT,'Anchor detection must match exact anchor'); END;
CREATE TRIGGER matchup_anchor_detection_update_guard BEFORE UPDATE OF current_detection_id ON matchup_anchors
WHEN NEW.current_detection_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM detections WHERE id=NEW.current_detection_id AND vod_id=NEW.vod_id AND frame_time_seconds=NEW.anchor_seconds)
BEGIN SELECT RAISE(ABORT,'Anchor detection must match exact anchor'); END;
UPDATE matchup_anchors SET current_detection_id=(SELECT current_detection_id FROM name_policy_anchor_pointers p WHERE p.id=matchup_anchors.id);
INSERT INTO mutation_checks(id,ok) SELECT 'name-policy-pointers',NOT EXISTS(
 SELECT 1 FROM name_policy_anchor_pointers p LEFT JOIN matchup_anchors a ON a.id=p.id WHERE a.id IS NULL OR a.current_detection_id IS NOT p.current_detection_id);
DELETE FROM mutation_checks WHERE id='name-policy-pointers';
DROP TABLE name_policy_anchor_pointers;

ALTER TABLE vods ADD COLUMN streamer_mode INTEGER NOT NULL DEFAULT 0 CHECK(streamer_mode IN(0,1));
ALTER TABLE sessions ADD COLUMN streamer_mode INTEGER NOT NULL DEFAULT 0 CHECK(streamer_mode IN(0,1));
CREATE TRIGGER vod_streamer_mode_monotonic BEFORE UPDATE OF streamer_mode ON vods WHEN OLD.streamer_mode=1 AND NEW.streamer_mode=0
BEGIN SELECT RAISE(ABORT,'Observed streamer mode cannot be cleared'); END;
CREATE TRIGGER session_streamer_mode_monotonic BEFORE UPDATE OF streamer_mode ON sessions WHEN OLD.streamer_mode=1 AND NEW.streamer_mode=0
BEGIN SELECT RAISE(ABORT,'Observed streamer mode cannot be cleared'); END;
CREATE TRIGGER vod_streamer_mode_change AFTER UPDATE OF streamer_mode ON vods WHEN NEW.streamer_mode!=OLD.streamer_mode BEGIN
 UPDATE sessions SET streamer_mode=1 WHERE id=NEW.session_id AND streamer_mode=0;
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
-- Mark the whole successor chain explicitly; do not depend on recursive_triggers.
CREATE TRIGGER session_streamer_mode_change AFTER UPDATE OF streamer_mode ON sessions WHEN NEW.streamer_mode!=OLD.streamer_mode BEGIN
 UPDATE sessions SET streamer_mode=1 WHERE streamer_mode=0 AND id IN(
  WITH RECURSIVE chain(id,depth) AS (SELECT NEW.merged_into,0 UNION ALL
   SELECT s.merged_into,c.depth+1 FROM sessions s JOIN chain c ON c.id=s.id WHERE c.depth<8)
  SELECT id FROM chain WHERE id IS NOT NULL);
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER session_streamer_mode_merge AFTER UPDATE OF merged_into ON sessions WHEN NEW.streamer_mode=1 AND NEW.merged_into IS NOT NULL BEGIN
 UPDATE sessions SET streamer_mode=1 WHERE streamer_mode=0 AND id IN(
  WITH RECURSIVE chain(id,depth) AS (SELECT NEW.merged_into,0 UNION ALL
   SELECT s.merged_into,c.depth+1 FROM sessions s JOIN chain c ON c.id=s.id WHERE c.depth<8)
  SELECT id FROM chain WHERE id IS NOT NULL);
END;
CREATE TRIGGER vod_streamer_mode_session AFTER UPDATE OF session_id ON vods WHEN NEW.streamer_mode=1 BEGIN
 UPDATE sessions SET streamer_mode=1 WHERE id=NEW.session_id AND streamer_mode=0;
END;
CREATE TRIGGER alignment_streamer_mode AFTER INSERT ON recording_alignments WHEN NEW.revoked_at IS NULL BEGIN
 UPDATE sessions SET streamer_mode=1 WHERE id=NEW.session_id AND streamer_mode=0
 AND EXISTS(SELECT 1 FROM vods WHERE id=NEW.vod_id AND streamer_mode=1);
END;
CREATE TRIGGER detection_streamer_mode_insert AFTER INSERT ON detections WHEN NEW.name_state='masked' BEGIN
 UPDATE vods SET streamer_mode=1 WHERE id=NEW.vod_id AND streamer_mode=0;
END;
CREATE TRIGGER detection_streamer_mode_update AFTER UPDATE OF name_state ON detections WHEN NEW.name_state='masked' BEGIN
 UPDATE vods SET streamer_mode=1 WHERE id=NEW.vod_id AND streamer_mode=0;
END;
UPDATE vods SET streamer_mode=1 WHERE streamer_mode=0 AND EXISTS(SELECT 1 FROM detections d WHERE d.vod_id=vods.id AND d.name_state='masked');

CREATE VIEW public_sources AS SELECT
 a.id AS anchor_id,a.matchup_id,a.vod_id,a.anchor_seconds AS at,'recording' AS kind,
 d.id AS detection_id,d.username,d.username_lower,d.confidence,
 d.name_state,d.encounter_confidence,d.ghost_hero,d.streamer_hero,d.wins_remaining,d.lethal,d.field_evidence,
 d.rank,d.igd,d.truncated,d.no_right_edge,d.storage_path,d.created_at AS indexed_at,
 v.source AS platform,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,
 v.title,v.published_at,v.recorded_at,v.duration_seconds,v.availability,v.availability='available' AS available,v.session_id AS recording_session_id,
 v.platform_account_id AS channel_id,
 CASE WHEN s.streamer_id IS NOT NULL AND o.streamer_id IS NOT s.streamer_id THEN 1 ELSE 0 END AS is_reupload,
 strftime('%Y-%m-%dT%H:%M:%fZ',v.recorded_at,'+'||a.anchor_seconds||' seconds') AS recorded_timestamp
FROM matchup_anchors a
JOIN matchups m ON m.id=a.matchup_id AND m.status='visible' AND m.merged_into IS NULL
JOIN detections d ON d.id=a.current_detection_id JOIN vods v ON v.id=a.vod_id
LEFT JOIN sessions s ON s.id=v.session_id
LEFT JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL
WHERE EXISTS(SELECT 1 FROM matchup_anchors b JOIN vods bv ON bv.id=b.vod_id
 WHERE b.matchup_id=a.matchup_id AND b.current_detection_id IS NOT NULL AND bv.availability='available');
-- Keep this name ordering identical to nameOrder() in worker/name-policy.ts.
CREATE VIEW public_matchups AS
WITH ranked AS (SELECT ps.matchup_id,ps.detection_id,ps.username,ps.confidence,ps.name_state,ps.rank,ps.igd,ps.recorded_timestamp,
 row_number() OVER (PARTITION BY ps.matchup_id ORDER BY CASE WHEN ps.username IS NULL THEN 3
  WHEN ps.name_state IN('legacy','complete') AND ps.confidence>0.7 THEN 0
  WHEN ps.name_state IN('legacy','complete') THEN 1 ELSE 2 END,
  ps.confidence DESC,ps.rank IS NULL,ps.igd IS NULL,ps.indexed_at,ps.detection_id) AS display_rank,
 max(ps.indexed_at) OVER (PARTITION BY ps.matchup_id) AS latest_indexed_at FROM public_sources ps)
SELECT r.matchup_id,r.detection_id,r.username,r.confidence,r.name_state,r.rank,r.igd,r.recorded_timestamp,r.latest_indexed_at AS indexed_at,m.session_id,m.session_time
FROM ranked r JOIN matchups m ON m.id=r.matchup_id WHERE r.display_rank=1;
CREATE VIEW public_recordings AS SELECT
 v.id,v.source AS platform,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,
 v.title,v.published_at,v.recorded_at,v.duration_seconds,v.availability,v.status,v.bazaar_chapters,v.session_id,v.streamer_mode,
 a.id AS channel_id,a.source_id AS channel_source_id,a.display_name AS channel_name,a.login AS channel_login,a.avatar_url AS channel_avatar,
 (SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=a.id AND o.ended_at IS NULL) AS channel_streamer_id
FROM vods v JOIN platform_accounts a ON a.id=v.platform_account_id;
CREATE VIEW streamer_detection_stats AS SELECT s.id AS streamer_id,s.login,s.display_name,count(d.id) AS total_detections,avg(d.confidence) AS avg_confidence,
 count(d.id) FILTER(WHERE d.no_right_edge=1) AS no_right_edge_detections,
 count(DISTINCT v.id) FILTER(WHERE v.status='processing') AS vods_processing,count(DISTINCT v.id) FILTER(WHERE v.status='completed') AS vods_completed,
 count(DISTINCT v.id) FILTER(WHERE v.status='failed') AS vods_failed,count(DISTINCT v.id) FILTER(WHERE v.status='partial') AS vods_partial,
 count(DISTINCT v.id) FILTER(WHERE v.status='pending') AS vods_pending,count(DISTINCT v.id) AS total_vods,
 coalesce(round(1.0*count(d.id)/nullif(count(DISTINCT v.id),0),2),0) AS avg_detections_per_vod
FROM streamers s LEFT JOIN vods v ON v.streamer_id=s.id LEFT JOIN detections d ON d.vod_id=v.id GROUP BY s.id;
CREATE TRIGGER matchup_notification_founding AFTER INSERT ON matchups WHEN EXISTS(
 SELECT 1 FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
 JOIN vods v ON v.id=a.vod_id JOIN platform_settings ps ON ps.source=v.source LEFT JOIN sessions s ON s.id=v.session_id
 WHERE a.id=NEW.id AND d.name_state IN('legacy','complete') AND d.username IS NOT NULL AND d.confidence>0.7
 AND v.streamer_mode=0 AND coalesce(s.streamer_mode,0)=0 AND v.notifications_enabled=1 AND ps.notifications_enabled=1
) BEGIN
 INSERT OR IGNORE INTO notification_outbox_v2(matchup_id,eligible_at) VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now',
 '+'||coalesce((SELECT cast(value AS INTEGER) FROM processing_config WHERE key='coalesce_grace_seconds' AND value!='' AND value NOT GLOB '*[^0-9]*'),120)||' seconds'));
END;
UPDATE public_search_state SET revision=revision+1 WHERE id=1;
UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
