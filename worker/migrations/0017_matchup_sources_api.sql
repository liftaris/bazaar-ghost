-- M7 (KAI-84): public Matchup-with-Sources read model. The per-anchor public views and the PostgREST-compat views
-- that only they served are replaced; nothing here changes stored data.
DROP VIEW public_matchups;
DROP VIEW public_videos;
DROP VIEW streamers_with_detections;
DROP VIEW vod_stats;
DROP VIEW vod_embed_info;

CREATE INDEX vods_account_source ON vods(platform_account_id,source);

-- One row per Recording-sourced anchor (a Source) of a canonical visible Matchup that has at least one available Source.
-- Unavailable Sources stay listed with available=0; a Matchup with none available has no rows at all (PLT-03).
-- is_reupload is derived (STR-03): the Session names a Streamer and the publishing Channel's active owner is someone else.
-- Order columns implement MAT-03: kind, availability, own before reupload, detection confidence, recorded_at, recording.
CREATE VIEW public_sources AS SELECT
  a.id AS anchor_id,a.matchup_id,a.vod_id,a.anchor_seconds AS at,'recording' AS kind,
  d.id AS detection_id,d.username,d.username_lower,d.confidence,d.rank,d.igd,d.truncated,d.no_right_edge,d.storage_path,
  d.created_at AS indexed_at,
  v.source AS platform,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,
  v.title,v.published_at,v.recorded_at,v.duration_seconds,v.availability,v.availability='available' AS available,v.session_id AS recording_session_id,
  v.platform_account_id AS channel_id,
  CASE WHEN s.streamer_id IS NOT NULL AND o.streamer_id IS NOT s.streamer_id THEN 1 ELSE 0 END AS is_reupload,
  strftime('%Y-%m-%dT%H:%M:%fZ',v.recorded_at,'+'||a.anchor_seconds||' seconds') AS recorded_timestamp
FROM matchup_anchors a
JOIN matchups m ON m.id=a.matchup_id AND m.status='visible' AND m.merged_into IS NULL
JOIN detections d ON d.id=a.current_detection_id
JOIN vods v ON v.id=a.vod_id
LEFT JOIN sessions s ON s.id=v.session_id
LEFT JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL
WHERE EXISTS(SELECT 1 FROM matchup_anchors b JOIN vods bv ON bv.id=b.vod_id
  WHERE b.matchup_id=a.matchup_id AND b.current_detection_id IS NOT NULL AND bv.availability='available');

-- Every Streamer a Matchup can be filtered by (STR-04): owners of its Sources' Channels and the Streamer of its Sessions.
CREATE VIEW matchup_streamers(matchup_id,streamer_id) AS
  SELECT a.matchup_id,o.streamer_id FROM matchup_anchors a JOIN vods v ON v.id=a.vod_id
    JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL
  UNION SELECT a.matchup_id,s.streamer_id FROM matchup_anchors a JOIN vods v ON v.id=a.vod_id
    JOIN sessions s ON s.id=v.session_id WHERE s.streamer_id IS NOT NULL
  UNION SELECT m.id,s.streamer_id FROM matchups m JOIN sessions s ON s.id=m.session_id WHERE s.streamer_id IS NOT NULL;

-- One row per public Matchup. Display fields come from the best-supported Detection (MAT-04): highest confidence,
-- then rank present, igd present, earliest indexed, lowest Detection id.
CREATE VIEW public_matchups AS
WITH ranked AS (SELECT ps.*,
    row_number() OVER (PARTITION BY ps.matchup_id ORDER BY ps.confidence DESC,ps.rank IS NULL,ps.igd IS NULL,ps.indexed_at,ps.detection_id) AS display_rank,
    max(ps.indexed_at) OVER (PARTITION BY ps.matchup_id) AS latest_indexed_at
  FROM public_sources ps)
SELECT r.matchup_id,r.detection_id,r.username,r.confidence,r.rank,r.igd,r.recorded_timestamp,r.latest_indexed_at AS indexed_at,
  m.session_id,m.session_time
FROM ranked r JOIN matchups m ON m.id=r.matchup_id WHERE r.display_rank=1;

-- Recordings with the Channel that published them and its active owner.
CREATE VIEW public_recordings AS SELECT
  v.id,v.source AS platform,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,
  v.title,v.published_at,v.recorded_at,v.duration_seconds,v.availability,v.status,v.bazaar_chapters,v.session_id,
  a.id AS channel_id,a.source_id AS channel_source_id,a.display_name AS channel_name,a.login AS channel_login,a.avatar_url AS channel_avatar,
  (SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=a.id AND o.ended_at IS NULL) AS channel_streamer_id
FROM vods v JOIN platform_accounts a ON a.id=v.platform_account_id;

-- Availability, like moderation, invalidates the public edge cache (PLT-03); search_video_change already restarts cursors.
CREATE TRIGGER vod_availability_cache_revision AFTER UPDATE OF availability ON vods WHEN NEW.availability IS NOT OLD.availability BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
