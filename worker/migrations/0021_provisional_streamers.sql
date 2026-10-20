-- Provisional Streamers: every Channel with public content and no owner gets its own Streamer until an operator merges it
-- into the real one or marks the Channel a reupload. Additive only. Ids come from the AUTOINCREMENT sequence, which 0012
-- holds above 1e12, so they never collide with Twitch user ids.
ALTER TABLE streamer_identities ADD COLUMN provisional_channel_id TEXT REFERENCES platform_accounts(id);
CREATE UNIQUE INDEX streamer_provisional_channel ON streamer_identities(provisional_channel_id) WHERE provisional_channel_id IS NOT NULL;
ALTER TABLE platform_accounts ADD COLUMN reupload_of INTEGER REFERENCES streamer_identities(id);
CREATE INDEX channel_owner_channel ON channel_ownership(channel_id);

-- Backfill (idempotent): a Channel that ever had an owner, or is a reupload, is never provisioned.
INSERT INTO streamer_identities(display_name,avatar_url,provisional_channel_id)
 SELECT substr(coalesce(nullif(trim(a.display_name),''),nullif(a.login,''),a.source_id),1,200),a.avatar_url,a.id FROM platform_accounts a
 WHERE a.reupload_of IS NULL AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM streamer_identities i WHERE i.provisional_channel_id=a.id)
 AND EXISTS(SELECT 1 FROM vods v WHERE v.platform_account_id=a.id AND v.availability='available') ORDER BY a.id;
INSERT INTO channel_ownership(channel_id,streamer_id,method,actor)
 SELECT i.provisional_channel_id,i.id,'operator','system:provisional' FROM streamer_identities i
 WHERE i.provisional_channel_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=i.provisional_channel_id);
UPDATE sessions SET streamer_id=(SELECT min(o.streamer_id) FROM recording_alignments g JOIN vods v ON v.id=g.vod_id
   JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL WHERE g.session_id=sessions.id AND g.revoked_at IS NULL)
 WHERE streamer_id IS NULL AND (SELECT count(DISTINCT o.streamer_id) FROM recording_alignments g JOIN vods v ON v.id=g.vod_id
   JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL WHERE g.session_id=sessions.id AND g.revoked_at IS NULL)=1;

-- Later Recordings: the first available one provisions its Channel and attributes its Session (Twitch Channels are always owned).
CREATE TRIGGER vod_provisional_streamer AFTER INSERT ON vods WHEN NEW.platform_account_id IS NOT NULL AND NEW.availability='available' BEGIN
  INSERT INTO streamer_identities(display_name,avatar_url,provisional_channel_id)
   SELECT substr(coalesce(nullif(trim(a.display_name),''),nullif(a.login,''),a.source_id),1,200),a.avatar_url,a.id FROM platform_accounts a
   WHERE a.id=NEW.platform_account_id AND a.reupload_of IS NULL AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM streamer_identities i WHERE i.provisional_channel_id=a.id);
  INSERT INTO channel_ownership(channel_id,streamer_id,method,actor)
   SELECT i.provisional_channel_id,i.id,'operator','system:provisional' FROM streamer_identities i
   WHERE i.provisional_channel_id=NEW.platform_account_id AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=i.provisional_channel_id);
  UPDATE sessions SET streamer_id=(SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=NEW.platform_account_id AND o.ended_at IS NULL)
   WHERE streamer_id IS NULL AND id=(SELECT session_id FROM vods WHERE id=NEW.id)
   AND EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=NEW.platform_account_id AND o.ended_at IS NULL);
END;
CREATE TRIGGER vod_provisional_streamer_available AFTER UPDATE OF availability,platform_account_id ON vods
WHEN NEW.platform_account_id IS NOT NULL AND NEW.availability='available' AND (OLD.availability IS NOT 'available' OR OLD.platform_account_id IS NOT NEW.platform_account_id) BEGIN
  INSERT INTO streamer_identities(display_name,avatar_url,provisional_channel_id)
   SELECT substr(coalesce(nullif(trim(a.display_name),''),nullif(a.login,''),a.source_id),1,200),a.avatar_url,a.id FROM platform_accounts a
   WHERE a.id=NEW.platform_account_id AND a.reupload_of IS NULL AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM streamer_identities i WHERE i.provisional_channel_id=a.id);
  INSERT INTO channel_ownership(channel_id,streamer_id,method,actor)
   SELECT i.provisional_channel_id,i.id,'operator','system:provisional' FROM streamer_identities i
   WHERE i.provisional_channel_id=NEW.platform_account_id AND NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=i.provisional_channel_id);
  UPDATE sessions SET streamer_id=(SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=NEW.platform_account_id AND o.ended_at IS NULL)
   WHERE streamer_id IS NULL AND id=NEW.session_id
   AND EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=NEW.platform_account_id AND o.ended_at IS NULL);
END;

-- A provisional Streamer follows its Channel's name and avatar.
CREATE TRIGGER provisional_streamer_sync AFTER UPDATE OF display_name,login,avatar_url ON platform_accounts BEGIN
  UPDATE streamer_identities SET display_name=substr(coalesce(nullif(trim(NEW.display_name),''),nullif(NEW.login,''),NEW.source_id),1,200),
   avatar_url=NEW.avatar_url,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE provisional_channel_id=NEW.id
   AND (display_name IS NOT substr(coalesce(nullif(trim(NEW.display_name),''),nullif(NEW.login,''),NEW.source_id),1,200) OR avatar_url IS NOT NEW.avatar_url);
END;
