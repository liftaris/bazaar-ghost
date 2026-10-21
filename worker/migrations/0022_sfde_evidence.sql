-- Quiesce processor writes. Run this entire migration atomically (D1 migrations batch).
-- Never rename the old parent: SQLite would retarget incoming FKs. Preserve the
-- only incoming FK explicitly, including NULL pointers; anchors/socials stay intact.
CREATE TABLE sfde_anchor_pointers AS SELECT id,current_detection_id FROM matchup_anchors;
DROP VIEW public_matchups;
DROP VIEW public_sources;
DROP VIEW streamer_detection_stats;
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
 -- Exact normalized request body and claim fence retries. publish_id retains the
 -- new publisher's stable ID when replacing a legacy row without changing its ID.
 publish_id TEXT, publish_claim TEXT, publish_body TEXT,
 CHECK((username IS NULL)=(username_lower IS NULL)),
 CHECK((name_state IN('legacy','complete') AND username IS NOT NULL) OR
       (name_state NOT IN('legacy','complete') AND username IS NULL AND confidence IS NULL)),
 CHECK(name_state='legacy' OR encounter_confidence IS NOT NULL),
 CHECK(name_state!='complete' OR length(trim(username))>0),
 UNIQUE(chunk_id,frame_time_seconds)
);
INSERT INTO detections_next(id,chunk_id,vod_id,username,username_lower,confidence,rank,frame_time_seconds,storage_path,no_right_edge,truncated,igd,created_at)
 SELECT id,chunk_id,vod_id,username,username_lower,confidence,rank,frame_time_seconds,storage_path,no_right_edge,truncated,igd,created_at FROM detections;
-- Abort rather than continuing with a partial copy.
INSERT INTO mutation_checks(id,ok) SELECT 'sfde-copy',
 (SELECT count(*) FROM detections)=(SELECT count(*) FROM detections_next)
 AND NOT EXISTS(SELECT id FROM detections EXCEPT SELECT id FROM detections_next);
DELETE FROM mutation_checks WHERE id='sfde-copy';
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
-- Detection IDs now survive corrections. Pending proposals must not keep trusting
-- names from an earlier publication just because their pair IDs are unchanged.
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
UPDATE matchup_anchors SET current_detection_id=(SELECT current_detection_id FROM sfde_anchor_pointers p WHERE p.id=matchup_anchors.id);
INSERT INTO mutation_checks(id,ok) SELECT 'sfde-pointers',NOT EXISTS(
 SELECT 1 FROM sfde_anchor_pointers p LEFT JOIN matchup_anchors a ON a.id=p.id WHERE a.id IS NULL OR a.current_detection_id IS NOT p.current_detection_id);
DELETE FROM mutation_checks WHERE id='sfde-pointers';
DROP TABLE sfde_anchor_pointers;

CREATE VIEW public_sources AS SELECT
 a.id AS anchor_id,a.matchup_id,a.vod_id,a.anchor_seconds AS at,'recording' AS kind,
 d.id AS detection_id,
 CASE WHEN d.name_state IN('legacy','complete') AND d.confidence>0.7 THEN d.username END AS username,
 CASE WHEN d.name_state IN('legacy','complete') AND d.confidence>0.7 THEN d.username_lower END AS username_lower,
 CASE WHEN d.name_state IN('legacy','complete') AND d.confidence>0.7 THEN d.confidence END AS confidence,
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
-- Keep this lean. Full per-field projection is applied only to selected pages in native-model.ts.
CREATE VIEW public_matchups AS
WITH ranked AS (SELECT ps.matchup_id,ps.detection_id,ps.username,ps.confidence,ps.name_state,ps.rank,ps.igd,ps.recorded_timestamp,
 row_number() OVER (PARTITION BY ps.matchup_id ORDER BY ps.confidence DESC,ps.rank IS NULL,ps.igd IS NULL,ps.indexed_at,ps.detection_id) AS display_rank,
 max(ps.indexed_at) OVER (PARTITION BY ps.matchup_id) AS latest_indexed_at FROM public_sources ps)
SELECT r.matchup_id,r.detection_id,r.username,r.confidence,r.name_state,r.rank,r.igd,r.recorded_timestamp,r.latest_indexed_at AS indexed_at,m.session_id,m.session_time
FROM ranked r JOIN matchups m ON m.id=r.matchup_id WHERE r.display_rank=1;
CREATE VIEW streamer_detection_stats AS SELECT s.id AS streamer_id,s.login,s.display_name,count(d.id) AS total_detections,avg(d.confidence) AS avg_confidence,
 count(d.id) FILTER(WHERE d.no_right_edge=1) AS no_right_edge_detections,
 count(DISTINCT v.id) FILTER(WHERE v.status='processing') AS vods_processing,count(DISTINCT v.id) FILTER(WHERE v.status='completed') AS vods_completed,
 count(DISTINCT v.id) FILTER(WHERE v.status='failed') AS vods_failed,count(DISTINCT v.id) FILTER(WHERE v.status='partial') AS vods_partial,
 count(DISTINCT v.id) FILTER(WHERE v.status='pending') AS vods_pending,count(DISTINCT v.id) AS total_vods,
 coalesce(round(1.0*count(d.id)/nullif(count(DISTINCT v.id),0),2),0) AS avg_detections_per_vod
FROM streamers s LEFT JOIN vods v ON v.streamer_id=s.id LEFT JOIN detections d ON d.vod_id=v.id GROUP BY s.id;
CREATE TRIGGER matchup_notification_founding AFTER INSERT ON matchups WHEN EXISTS(
 SELECT 1 FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
 JOIN vods v ON v.id=a.vod_id JOIN platform_settings ps ON ps.source=v.source
 WHERE a.id=NEW.id AND d.name_state IN('legacy','complete') AND d.username IS NOT NULL AND d.confidence>0.7
 AND v.notifications_enabled=1 AND ps.notifications_enabled=1
) BEGIN
 INSERT OR IGNORE INTO notification_outbox_v2(matchup_id,eligible_at) VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now',
 '+'||coalesce((SELECT cast(value AS INTEGER) FROM processing_config WHERE key='coalesce_grace_seconds' AND value!='' AND value NOT GLOB '*[^0-9]*'),120)||' seconds'));
END;
UPDATE public_search_state SET revision=revision+1 WHERE id=1;
UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
