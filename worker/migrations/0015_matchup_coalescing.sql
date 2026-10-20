-- M5: Matchup coalescing. Manual overrides and an audit log are added; the legacy reviewed groups become
-- link overrides and merged Matchups; `clip_appearances` becomes a compatibility VIEW over the anchors.
-- Additive except the leaf table clip_appearances (no children), which is replaced by the view.
CREATE TABLE matchup_overrides(
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN('link','unlink')),
  anchor_a INTEGER NOT NULL,
  anchor_b INTEGER NOT NULL,
  evidence TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 10 AND 4000),
  actor TEXT NOT NULL,
  source_group TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK(anchor_a<anchor_b),
  CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
-- Anchors have no foreign key here: an anchor deleted with its Recording must not block that deletion.
CREATE UNIQUE INDEX matchup_override_active ON matchup_overrides(action,anchor_a,anchor_b) WHERE revoked_at IS NULL;
CREATE INDEX matchup_override_a ON matchup_overrides(anchor_a) WHERE revoked_at IS NULL;
CREATE INDEX matchup_override_b ON matchup_overrides(anchor_b) WHERE revoked_at IS NULL;
CREATE TABLE matchup_events(
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX matchup_events_created ON matchup_events(created_at);
-- Counter, not a flag: a run clears only the value it started from.
ALTER TABLE sessions ADD COLUMN coalesce_dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_coalesce_dirty ON sessions(id) WHERE coalesce_dirty>0;

CREATE TRIGGER matchup_override_insert AFTER INSERT ON matchup_overrides BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER matchup_override_revoke AFTER UPDATE OF revoked_at ON matchup_overrides WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
-- Founding an anchor's Matchup (NULL -> id) is not a change; moving an anchor between Matchups is.
CREATE TRIGGER matchup_anchor_moved AFTER UPDATE OF matchup_id ON matchup_anchors
WHEN OLD.matchup_id IS NOT NULL AND NEW.matchup_id IS NOT NULL AND NEW.matchup_id!=OLD.matchup_id BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER matchup_merge_change AFTER UPDATE OF merged_into ON matchups WHEN NEW.merged_into IS NOT OLD.merged_into BEGIN
  UPDATE public_cache_state SET revision=revision+1 WHERE id=1;
  UPDATE public_search_state SET revision=revision+1 WHERE id=1;
END;

-- BEGIN generated:legacy-groups (scripts/migration/gen_backfill.py; edit scripts/migration/legacy_groups.sql)
CREATE TABLE m5_legacy_membership AS SELECT clip_id AS anchor_id,matchup_id AS group_id FROM clip_appearances;
-- Legacy reviewed groups become `link` overrides and merged Matchups. Idempotent; every statement is safe to rerun.
-- Input: m5_legacy_membership(anchor_id, group_id), prepared by the caller (migration 0015 or post_import.sql).
INSERT OR IGNORE INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor,source_group,created_at)
SELECT 'legacy-link:'||m.group_id||':'||w.winner||':'||m.anchor_id,'link',w.winner,m.anchor_id,
  CASE WHEN length(trim(g.evidence)) BETWEEN 10 AND 4000 THEN trim(g.evidence) ELSE 'Legacy matchup group '||m.group_id||' (original evidence unavailable)' END,
  'legacy-group',m.group_id,coalesce(g.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
FROM m5_legacy_membership m
JOIN (SELECT group_id,min(anchor_id) AS winner FROM m5_legacy_membership GROUP BY group_id) w ON w.group_id=m.group_id
LEFT JOIN matchup_groups g ON g.id=m.group_id
WHERE m.anchor_id>w.winner;
INSERT OR IGNORE INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor,source_group,created_at)
SELECT 'legacy-unlink:'||e.id||':'||min(x.id,y.id)||':'||max(x.id,y.id),'unlink',min(x.id,y.id),max(x.id,y.id),
  CASE WHEN length(trim(e.evidence)) BETWEEN 10 AND 4000 THEN trim(e.evidence) ELSE 'Legacy unlink in group '||e.matchup_id||' (original evidence unavailable)' END,
  'legacy-group',e.matchup_id,e.created_at
FROM matchup_review_events e
JOIN json_each(e.detection_ids) ud ON e.action='unlink'
JOIN detections dx ON dx.id=ud.value
JOIN matchup_anchors x ON x.vod_id=dx.vod_id AND x.anchor_seconds=dx.frame_time_seconds
JOIN matchup_review_events l ON l.matchup_id=e.matchup_id AND l.action='link'
JOIN json_each(l.detection_ids) ld
JOIN detections dy ON dy.id=ld.value
JOIN matchup_anchors y ON y.vod_id=dy.vod_id AND y.anchor_seconds=dy.frame_time_seconds
WHERE x.id<>y.id AND NOT EXISTS(SELECT 1 FROM m5_legacy_membership p JOIN m5_legacy_membership q ON q.group_id=p.group_id WHERE p.anchor_id=x.id AND q.anchor_id=y.id);
CREATE TABLE m5_merge AS SELECT m.anchor_id AS loser,w.winner AS winner
FROM m5_legacy_membership m
JOIN (SELECT group_id,min(anchor_id) AS winner FROM m5_legacy_membership GROUP BY group_id) w ON w.group_id=m.group_id
WHERE m.anchor_id>w.winner;
CREATE UNIQUE INDEX m5_merge_loser ON m5_merge(loser);
UPDATE matchups SET status='hidden',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status='visible' AND EXISTS(SELECT 1 FROM m5_merge x JOIN matchups l ON l.id=x.loser WHERE x.winner=matchups.id AND l.status='hidden');
UPDATE matchup_anchors SET matchup_id=(SELECT winner FROM m5_merge WHERE loser=matchup_anchors.id)
WHERE id IN(SELECT loser FROM m5_merge) AND matchup_id IS NOT (SELECT winner FROM m5_merge WHERE loser=matchup_anchors.id);
UPDATE matchups SET merged_into=(SELECT winner FROM m5_merge WHERE loser=matchups.id),origin='legacy-group',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN(SELECT loser FROM m5_merge) AND merged_into IS NOT (SELECT winner FROM m5_merge WHERE loser=matchups.id);
UPDATE matchups SET merged_into=(SELECT winner FROM m5_merge WHERE loser=matchups.merged_into) WHERE merged_into IN(SELECT loser FROM m5_merge);
UPDATE matchup_likes SET matchup_id=(SELECT winner FROM m5_merge WHERE loser=matchup_likes.matchup_id) WHERE matchup_id IN(SELECT loser FROM m5_merge);
UPDATE matchup_favorites SET matchup_id=(SELECT winner FROM m5_merge WHERE loser=matchup_favorites.matchup_id) WHERE matchup_id IN(SELECT loser FROM m5_merge);
UPDATE matchup_comments SET matchup_id=(SELECT winner FROM m5_merge WHERE loser=matchup_comments.matchup_id) WHERE matchup_id IN(SELECT loser FROM m5_merge);
UPDATE social_reports SET matchup_id=(SELECT winner FROM m5_merge WHERE loser=social_reports.matchup_id) WHERE matchup_id IN(SELECT loser FROM m5_merge);
UPDATE social_reports SET status='dismissed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE comment_id IS NULL AND status='open' AND matchup_id IN(SELECT winner FROM m5_merge)
AND sequence>(SELECT min(r.sequence) FROM social_reports r WHERE r.reporter_id=social_reports.reporter_id AND r.comment_id IS NULL AND r.matchup_id=social_reports.matchup_id);
INSERT OR IGNORE INTO matchup_events(id,action,payload,actor)
SELECT 'legacy-group:'||g.group_id,'merge',json_object('source_group',g.group_id,'winner',g.winner,'merged',(SELECT json_group_array(x.loser) FROM m5_merge x WHERE x.winner=g.winner)),'legacy-group'
FROM (SELECT group_id,min(anchor_id) AS winner FROM m5_legacy_membership GROUP BY group_id HAVING count(*)>1) g;
DROP TABLE m5_merge;
DROP TABLE m5_legacy_membership;
-- END generated:legacy-groups

DROP TABLE clip_appearances;
-- Anchors of Matchups with more than one anchor; matchup_id is the stringified canonical Matchup ID.
CREATE VIEW clip_appearances(clip_id,matchup_id) AS SELECT a.id,CAST(a.matchup_id AS TEXT) FROM matchup_anchors a
WHERE EXISTS(SELECT 1 FROM matchup_anchors b WHERE b.matchup_id=a.matchup_id AND b.id!=a.id);
