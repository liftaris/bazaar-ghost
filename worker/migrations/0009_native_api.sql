-- Verified appearance relationships belong to durable anchors, not replaceable OCR rows.
CREATE TABLE clip_appearances (
  clip_id INTEGER PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
  matchup_id TEXT NOT NULL REFERENCES matchup_groups(id) ON DELETE CASCADE
);
CREATE INDEX clip_appearances_group ON clip_appearances(matchup_id,clip_id);
INSERT INTO clip_appearances SELECT c.id,a.matchup_id FROM matchup_appearances a
JOIN clips c ON c.current_detection_id=a.detection_id;

-- New publications use a high watermark. Corrections invalidate existing cursors.
CREATE TABLE public_search_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
INSERT INTO public_search_state VALUES(1,0);
CREATE TRIGGER search_detection_update AFTER UPDATE ON detections BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_detection_delete BEFORE DELETE ON detections BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_clip_replacement AFTER UPDATE OF current_detection_id,status ON clips
WHEN NEW.current_detection_id IS NOT OLD.current_detection_id OR NEW.status!=OLD.status BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_video_change AFTER UPDATE OF availability,published_at,recorded_at ON vods
WHEN NEW.availability!=OLD.availability OR NEW.published_at IS NOT OLD.published_at OR NEW.recorded_at IS NOT OLD.recorded_at BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_creator_change AFTER UPDATE OF login,display_name ON streamers
WHEN NEW.login!=OLD.login OR NEW.display_name IS NOT OLD.display_name BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_account_change AFTER UPDATE OF display_name ON platform_accounts
WHEN NEW.display_name!=OLD.display_name BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_appearance_insert AFTER INSERT ON clip_appearances BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_appearance_delete AFTER DELETE ON clip_appearances BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;

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
