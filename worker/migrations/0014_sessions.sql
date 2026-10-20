-- M4: Sessions with explicit Recording time mappings. Additive only: no existing table is rebuilt and
-- nothing cascades from vods, so deleting or expiring a Recording keeps its Session, alignments and Matchups (SES-04).
CREATE TABLE sessions(
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  streamer_id INTEGER REFERENCES streamer_identities(id),
  title TEXT,
  origin TEXT NOT NULL CHECK(origin IN('singleton','proposal','operator')),
  merged_into TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(merged_into IS NULL OR merged_into!=id)
);
CREATE INDEX sessions_streamer ON sessions(streamer_id) WHERE streamer_id IS NOT NULL;
CREATE INDEX sessions_merged ON sessions(merged_into) WHERE merged_into IS NOT NULL;

-- vod_id deliberately has no FOREIGN KEY. session_time = recording_time + offset_seconds.
CREATE TABLE recording_alignments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  vod_id INTEGER NOT NULL,
  rec_start REAL NOT NULL DEFAULT 0,
  rec_end REAL,
  offset_seconds REAL NOT NULL,
  method TEXT NOT NULL CHECK(method IN('singleton','proposal','operator','auto-rule')),
  proposal_id TEXT,
  actor TEXT NOT NULL,
  evidence TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK(rec_end IS NULL OR rec_end>rec_start),
  CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE UNIQUE INDEX alignment_segment ON recording_alignments(vod_id,rec_start) WHERE revoked_at IS NULL;
CREATE INDEX alignment_session ON recording_alignments(session_id) WHERE revoked_at IS NULL;
CREATE INDEX alignment_event ON recording_alignments(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE session_events(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  actor TEXT NOT NULL,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX session_events_session ON session_events(session_id,created_at);

ALTER TABLE vods ADD COLUMN session_id TEXT REFERENCES sessions(id);
ALTER TABLE matchups ADD COLUMN session_id TEXT REFERENCES sessions(id);
ALTER TABLE matchups ADD COLUMN session_time REAL;
CREATE INDEX vods_session ON vods(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX matchups_session ON matchups(session_id,session_time) WHERE session_id IS NOT NULL;

-- Every existing Recording becomes a Session of one with an offset-0 alignment (idempotent).
CREATE TABLE m4_vs AS SELECT v.id AS vod_id,lower(hex(randomblob(16))) AS sid,
  coalesce((SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=v.platform_account_id AND o.ended_at IS NULL),
           (SELECT i.id FROM streamer_identities i WHERE i.id=v.streamer_id)) AS streamer_id
 FROM vods v WHERE v.session_id IS NULL AND NOT EXISTS(SELECT 1 FROM recording_alignments a WHERE a.vod_id=v.id AND a.revoked_at IS NULL);
INSERT INTO sessions(id,streamer_id,origin) SELECT sid,streamer_id,'singleton' FROM m4_vs;
INSERT INTO recording_alignments(session_id,vod_id,rec_start,offset_seconds,method,actor) SELECT sid,vod_id,0,0,'singleton','migration:0014' FROM m4_vs;
UPDATE vods SET session_id=(SELECT sid FROM m4_vs WHERE vod_id=vods.id) WHERE id IN(SELECT vod_id FROM m4_vs);
DROP TABLE m4_vs;
-- A Matchup lives in the Session of its lowest (founding) anchor.
UPDATE matchups SET
  session_id=(SELECT v.session_id FROM matchup_anchors a JOIN vods v ON v.id=a.vod_id WHERE a.id=(SELECT min(id) FROM matchup_anchors WHERE matchup_id=matchups.id)),
  session_time=(SELECT a.anchor_seconds+g.offset_seconds FROM matchup_anchors a JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL
     AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end)
     WHERE a.id=(SELECT min(id) FROM matchup_anchors WHERE matchup_id=matchups.id))
 WHERE session_id IS NULL;

-- A Recording's active segments must not overlap and must all belong to one Session.
CREATE TRIGGER alignment_guard_insert BEFORE INSERT ON recording_alignments WHEN NEW.revoked_at IS NULL BEGIN
  SELECT RAISE(ABORT,'Alignment segments of a recording must not overlap') WHERE EXISTS(
    SELECT 1 FROM recording_alignments a WHERE a.vod_id=NEW.vod_id AND a.revoked_at IS NULL
    AND a.rec_start<coalesce(NEW.rec_end,1e300) AND NEW.rec_start<coalesce(a.rec_end,1e300));
  SELECT RAISE(ABORT,'A recording belongs to one session') WHERE EXISTS(
    SELECT 1 FROM recording_alignments a WHERE a.vod_id=NEW.vod_id AND a.revoked_at IS NULL AND a.session_id!=NEW.session_id);
END;
CREATE TRIGGER alignment_guard_update BEFORE UPDATE OF vod_id,session_id,rec_start,rec_end,revoked_at ON recording_alignments WHEN NEW.revoked_at IS NULL BEGIN
  SELECT RAISE(ABORT,'Alignment segments of a recording must not overlap') WHERE EXISTS(
    SELECT 1 FROM recording_alignments a WHERE a.id!=NEW.id AND a.vod_id=NEW.vod_id AND a.revoked_at IS NULL
    AND a.rec_start<coalesce(NEW.rec_end,1e300) AND NEW.rec_start<coalesce(a.rec_end,1e300));
  SELECT RAISE(ABORT,'A recording belongs to one session') WHERE EXISTS(
    SELECT 1 FROM recording_alignments a WHERE a.id!=NEW.id AND a.vod_id=NEW.vod_id AND a.revoked_at IS NULL AND a.session_id!=NEW.session_id);
END;

-- Cache columns follow the alignments.
CREATE TRIGGER alignment_apply_insert AFTER INSERT ON recording_alignments WHEN NEW.revoked_at IS NULL BEGIN
  UPDATE vods SET session_id=NEW.session_id WHERE id=NEW.vod_id AND session_id IS NOT NEW.session_id;
  UPDATE matchups SET session_id=NEW.session_id,
    session_time=(SELECT a.anchor_seconds+g.offset_seconds FROM matchup_anchors a JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL
      AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end) WHERE a.id=(SELECT min(id) FROM matchup_anchors WHERE matchup_id=matchups.id))
   WHERE id IN(SELECT x.matchup_id FROM matchup_anchors x WHERE x.vod_id=NEW.vod_id AND x.id=(SELECT min(id) FROM matchup_anchors WHERE matchup_id=x.matchup_id));
END;
CREATE TRIGGER alignment_apply_revoke AFTER UPDATE OF revoked_at ON recording_alignments WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL BEGIN
  UPDATE matchups SET
    session_time=(SELECT a.anchor_seconds+g.offset_seconds FROM matchup_anchors a JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL
      AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end) WHERE a.id=(SELECT min(id) FROM matchup_anchors WHERE matchup_id=matchups.id))
   WHERE id IN(SELECT x.matchup_id FROM matchup_anchors x WHERE x.vod_id=NEW.vod_id AND x.id=(SELECT min(id) FROM matchup_anchors WHERE matchup_id=x.matchup_id));
END;

-- Every inserted Recording (Worker, Python, import) starts as a Session of one.
CREATE TRIGGER vod_singleton_session AFTER INSERT ON vods WHEN NEW.session_id IS NULL BEGIN
  UPDATE vods SET session_id=lower(hex(randomblob(16))) WHERE id=NEW.id;
  INSERT INTO sessions(id,streamer_id,origin)
   SELECT v.session_id,
    coalesce((SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=v.platform_account_id AND o.ended_at IS NULL),
             (SELECT i.id FROM streamer_identities i WHERE i.id=v.streamer_id)),
    'singleton' FROM vods v WHERE v.id=NEW.id;
  INSERT INTO recording_alignments(session_id,vod_id,rec_start,offset_seconds,method,actor)
   SELECT session_id,id,0,0,'singleton','trigger:vods' FROM vods WHERE id=NEW.id;
END;

-- A Matchup takes its Session and Session time from the anchor that founds it (or its lowest anchor).
CREATE TRIGGER matchup_anchor_session AFTER UPDATE OF matchup_id ON matchup_anchors BEGIN
  UPDATE matchups SET
    session_id=(SELECT v.session_id FROM vods v WHERE v.id=NEW.vod_id),
    session_time=(SELECT NEW.anchor_seconds+g.offset_seconds FROM recording_alignments g WHERE g.vod_id=NEW.vod_id AND g.revoked_at IS NULL
      AND g.rec_start<=NEW.anchor_seconds AND (g.rec_end IS NULL OR NEW.anchor_seconds<g.rec_end))
   WHERE id=NEW.matchup_id AND session_id IS NULL;
END;
CREATE TRIGGER matchup_anchor_session_insert AFTER INSERT ON matchup_anchors WHEN NEW.matchup_id IS NOT NULL BEGIN
  UPDATE matchups SET
    session_id=(SELECT v.session_id FROM vods v WHERE v.id=NEW.vod_id),
    session_time=(SELECT NEW.anchor_seconds+g.offset_seconds FROM recording_alignments g WHERE g.vod_id=NEW.vod_id AND g.revoked_at IS NULL
      AND g.rec_start<=NEW.anchor_seconds AND (g.rec_end IS NULL OR NEW.anchor_seconds<g.rec_end))
   WHERE id=NEW.matchup_id AND session_id IS NULL;
END;

-- Operator-visible Session changes invalidate public caches (singleton creation does not).
CREATE TRIGGER alignment_change_insert AFTER INSERT ON recording_alignments WHEN NEW.method!='singleton' BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER alignment_change_revoke AFTER UPDATE OF revoked_at ON recording_alignments WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER session_change AFTER UPDATE OF streamer_id,merged_into ON sessions BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
