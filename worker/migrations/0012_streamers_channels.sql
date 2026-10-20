-- Streamers (platform-neutral identity) and Channel ownership. Additive only: no parent-table rebuilds.
CREATE TABLE streamer_identities (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
 avatar_url TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE channel_ownership (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 channel_id TEXT NOT NULL REFERENCES platform_accounts(id),
 streamer_id INTEGER NOT NULL REFERENCES streamer_identities(id),
 method TEXT NOT NULL CHECK(method IN('operator','proven-login','legacy-link')),
 actor TEXT NOT NULL, evidence TEXT,
 started_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ended_at TEXT, ended_by TEXT, end_reason TEXT,
 CHECK((ended_at IS NULL)=(ended_by IS NULL))
);
CREATE UNIQUE INDEX channel_owner_active ON channel_ownership(channel_id) WHERE ended_at IS NULL;
CREATE INDEX channel_owner_streamer ON channel_ownership(streamer_id) WHERE ended_at IS NULL;

ALTER TABLE platform_accounts ADD COLUMN login TEXT;
ALTER TABLE platform_accounts ADD COLUMN avatar_url TEXT;
ALTER TABLE platform_accounts ADD COLUMN legacy_creator_id TEXT;

UPDATE platform_accounts SET legacy_creator_id=CASE WHEN source='twitch' THEN 'twitch:'||source_id ELSE source||':'||id END;
CREATE TRIGGER platform_account_legacy_creator AFTER INSERT ON platform_accounts WHEN NEW.legacy_creator_id IS NULL BEGIN
  UPDATE platform_accounts SET legacy_creator_id=CASE WHEN NEW.source='twitch' THEN 'twitch:'||NEW.source_id ELSE NEW.source||':'||NEW.id END WHERE id=NEW.id;
END;

-- Twitch Channels, Streamers with the Twitch ID, and ownership.
INSERT INTO platform_accounts(id,source,source_id,display_name,login,avatar_url,sfde_profile_id,processing_enabled,legacy_creator_id)
 SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(6))),
  'twitch',cast(s.id AS TEXT),coalesce(nullif(s.display_name,''),s.login),s.login,s.profile_image_url,s.sfde_profile_id,s.processing_enabled,'twitch:'||s.id
 FROM streamers s WHERE NOT EXISTS(SELECT 1 FROM platform_accounts a WHERE a.source='twitch' AND a.source_id=cast(s.id AS TEXT));
INSERT INTO streamer_identities(id,display_name,avatar_url)
 SELECT s.id,coalesce(nullif(s.display_name,''),s.login),s.profile_image_url FROM streamers s
 WHERE NOT EXISTS(SELECT 1 FROM streamer_identities i WHERE i.id=s.id);
INSERT INTO channel_ownership(channel_id,streamer_id,method,actor)
 SELECT a.id,s.id,'legacy-link','migration:0012' FROM streamers s JOIN platform_accounts a ON a.source='twitch' AND a.source_id=cast(s.id AS TEXT)
 WHERE NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=a.id AND o.ended_at IS NULL);
-- Operator-created Streamers get IDs far above any Twitch ID, so a later Twitch streamer cannot collide.
UPDATE sqlite_sequence SET seq=max(seq,1000000000000) WHERE name='streamer_identities';
INSERT INTO sqlite_sequence(name,seq) SELECT 'streamer_identities',1000000000000 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='streamer_identities');

-- Previously linked non-Twitch accounts.
INSERT INTO channel_ownership(channel_id,streamer_id,method,actor)
 SELECT a.id,a.streamer_id,'legacy-link','migration:0012' FROM platform_accounts a
 WHERE a.source<>'twitch' AND a.streamer_id IS NOT NULL AND EXISTS(SELECT 1 FROM streamer_identities i WHERE i.id=a.streamer_id)
 AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=a.id AND o.ended_at IS NULL);

UPDATE vods SET platform_account_id=(SELECT a.id FROM platform_accounts a WHERE a.source='twitch' AND a.source_id=cast(vods.streamer_id AS TEXT))
 WHERE streamer_id IS NOT NULL AND platform_account_id IS NULL AND source='twitch';

-- Later Twitch inserts and cutover import.
CREATE TRIGGER streamer_channel_create AFTER INSERT ON streamers BEGIN
  INSERT INTO platform_accounts(id,source,source_id,display_name,login,avatar_url,sfde_profile_id,processing_enabled,legacy_creator_id)
   SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(6))),
   'twitch',cast(NEW.id AS TEXT),coalesce(nullif(NEW.display_name,''),NEW.login),NEW.login,NEW.profile_image_url,NEW.sfde_profile_id,NEW.processing_enabled,'twitch:'||NEW.id
   WHERE NOT EXISTS(SELECT 1 FROM platform_accounts WHERE source='twitch' AND source_id=cast(NEW.id AS TEXT));
  INSERT INTO streamer_identities(id,display_name,avatar_url)
   SELECT NEW.id,coalesce(nullif(NEW.display_name,''),NEW.login),NEW.profile_image_url WHERE NOT EXISTS(SELECT 1 FROM streamer_identities WHERE id=NEW.id);
  INSERT INTO channel_ownership(channel_id,streamer_id,method,actor)
   SELECT a.id,NEW.id,'legacy-link','trigger:streamers' FROM platform_accounts a WHERE a.source='twitch' AND a.source_id=cast(NEW.id AS TEXT)
   AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=a.id AND o.ended_at IS NULL);
END;
CREATE TRIGGER streamer_channel_mirror AFTER UPDATE OF processing_enabled,sfde_profile_id,login,display_name,profile_image_url ON streamers BEGIN
  UPDATE platform_accounts SET processing_enabled=NEW.processing_enabled,sfde_profile_id=NEW.sfde_profile_id,login=NEW.login,
   display_name=coalesce(nullif(NEW.display_name,''),NEW.login),avatar_url=NEW.profile_image_url
   WHERE source='twitch' AND source_id=cast(NEW.id AS TEXT);
END;
CREATE TRIGGER vod_twitch_channel AFTER INSERT ON vods WHEN NEW.platform_account_id IS NULL AND NEW.streamer_id IS NOT NULL AND NEW.source='twitch' BEGIN
  UPDATE vods SET platform_account_id=(SELECT id FROM platform_accounts WHERE source='twitch' AND source_id=cast(NEW.streamer_id AS TEXT)) WHERE id=NEW.id;
END;

CREATE TRIGGER search_ownership_insert AFTER INSERT ON channel_ownership BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_ownership_update AFTER UPDATE ON channel_ownership BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER search_streamer_identity_update AFTER UPDATE OF display_name,avatar_url ON streamer_identities BEGIN
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
END;

UPDATE vods SET recorded_at=published_at WHERE source='twitch' AND recorded_at IS NULL;

-- Twitch settings stay authoritative in `streamers`; the Channel row mirrors them.
DROP VIEW public_matchups;
DROP VIEW public_videos;
DROP VIEW video_detections;
DROP VIEW vod_processing_context;
CREATE VIEW vod_processing_context AS SELECT v.*,
 CASE WHEN a.source='twitch' AND a.source_id=cast(s.id AS TEXT) THEN s.processing_enabled
  WHEN v.platform_account_id IS NOT NULL THEN a.processing_enabled ELSE s.processing_enabled END AS processing_enabled,
 coalesce(v.sfde_profile_id,CASE WHEN a.source='twitch' AND a.source_id=cast(s.id AS TEXT) THEN s.sfde_profile_id ELSE a.sfde_profile_id END,s.sfde_profile_id,1) AS effective_profile_id,
 coalesce(a.display_name,s.display_name,s.login) AS creator_name,
 CASE WHEN v.template_version='old' THEN 1 WHEN v.template_version='current' THEN 0
 ELSE coalesce(v.recorded_at<'2025-08-12T00:00:00.000Z',0) END AS old_templates
 FROM vods v LEFT JOIN platform_accounts a ON a.id=v.platform_account_id LEFT JOIN streamers s ON s.id=v.streamer_id;
-- Recording time is never invented from a publish time (0011 regressed this for non-Twitch videos).
CREATE VIEW video_detections AS SELECT d.id AS detection_id,d.username,d.confidence,d.rank,d.frame_time_seconds,
 d.storage_path,d.no_right_edge,d.truncated,d.igd,d.created_at AS indexed_at,
 v.id AS vod_id,v.source,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index,v.title,v.published_at,v.recorded_at,
 v.platform_account_id,v.streamer_id,coalesce(a.display_name,s.display_name,s.login) AS creator_name,
 strftime('%Y-%m-%dT%H:%M:%fZ',v.recorded_at,'+'||d.frame_time_seconds||' seconds') AS recorded_timestamp
 FROM detections d JOIN vods v ON v.id=d.vod_id LEFT JOIN platform_accounts a ON a.id=v.platform_account_id
 LEFT JOIN streamers s ON s.id=v.streamer_id WHERE v.availability='available' AND d.confidence>0.7
 AND NOT EXISTS(SELECT 1 FROM clips c WHERE c.vod_id=d.vod_id AND c.anchor_seconds=d.frame_time_seconds AND c.status='hidden');
CREATE VIEW public_videos AS SELECT v.*,
  coalesce(a.legacy_creator_id,CASE WHEN v.source='twitch' THEN 'twitch:'||s.id ELSE v.source||':'||a.id END) AS creator_id,
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
