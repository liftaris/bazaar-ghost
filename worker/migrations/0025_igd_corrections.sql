ALTER TABLE detections ADD COLUMN game_mode TEXT CHECK(game_mode IN('normal','tournament'));
ALTER TABLE detections ADD COLUMN tournament_wins INTEGER CHECK(tournament_wins IS NULL OR (typeof(tournament_wins)='integer' AND tournament_wins BETWEEN 0 AND 9007199254740991));
ALTER TABLE detections ADD COLUMN tournament_losses INTEGER CHECK(tournament_losses IS NULL OR (typeof(tournament_losses)='integer' AND tournament_losses BETWEEN 0 AND 9007199254740991));

CREATE TABLE igd_corrections (
 detection_id TEXT PRIMARY KEY REFERENCES detections(id) ON DELETE CASCADE,
 id TEXT NOT NULL UNIQUE,
 igd INTEGER CHECK(igd IS NULL OR (typeof(igd)='integer' AND igd BETWEEN 1 AND 20)),
 raw_igd INTEGER,
 raw_field_evidence TEXT NOT NULL,
 raw_publish_body TEXT,
 input_digest TEXT NOT NULL,
 evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 source_refs TEXT NOT NULL CHECK(json_valid(source_refs)),
 actor TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER igd_correction_insert AFTER INSERT ON igd_corrections BEGIN
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER igd_correction_update AFTER UPDATE ON igd_corrections BEGIN
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER igd_correction_delete AFTER DELETE ON igd_corrections BEGIN
 UPDATE public_search_state SET revision=revision+1 WHERE id=1;
 UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;

DROP VIEW public_sources;
CREATE VIEW public_sources AS SELECT
 a.id AS anchor_id,a.matchup_id,a.vod_id,a.anchor_seconds AS at,'recording' AS kind,
 d.id AS detection_id,d.username,d.username_lower,d.confidence,
 d.name_state,d.encounter_confidence,d.ghost_hero,d.streamer_hero,d.wins_remaining,d.lethal,d.field_evidence,
 d.game_mode,d.tournament_wins,d.tournament_losses,
 d.rank,CASE WHEN c.id IS NOT NULL THEN c.igd ELSE d.igd END AS igd,d.igd AS raw_igd,
 c.id AS igd_correction_id,c.evidence AS igd_correction_evidence,c.source_refs AS igd_correction_source_refs,
 c.input_digest AS igd_correction_input_digest,c.reason AS igd_correction_reason,c.created_at AS igd_correction_created_at,
 d.truncated,d.no_right_edge,d.storage_path,d.created_at AS indexed_at,
 v.source AS platform,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,
 v.title,v.published_at,v.recorded_at,v.duration_seconds,v.availability,v.availability='available' AS available,v.session_id AS recording_session_id,
 v.platform_account_id AS channel_id,
 CASE WHEN s.streamer_id IS NOT NULL AND o.streamer_id IS NOT s.streamer_id THEN 1 ELSE 0 END AS is_reupload,
 strftime('%Y-%m-%dT%H:%M:%fZ',v.recorded_at,'+'||a.anchor_seconds||' seconds') AS recorded_timestamp
FROM matchup_anchors a
JOIN matchups m ON m.id=a.matchup_id AND m.status='visible' AND m.merged_into IS NULL
JOIN detections d ON d.id=a.current_detection_id JOIN vods v ON v.id=a.vod_id
LEFT JOIN igd_corrections c ON c.detection_id=d.id AND c.raw_igd IS d.igd
 AND c.raw_field_evidence=d.field_evidence AND c.raw_publish_body IS d.publish_body
LEFT JOIN sessions s ON s.id=v.session_id
LEFT JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL
WHERE EXISTS(SELECT 1 FROM matchup_anchors b JOIN vods bv ON bv.id=b.vod_id
 WHERE b.matchup_id=a.matchup_id AND b.current_detection_id IS NOT NULL AND bv.availability='available');
