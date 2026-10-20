-- M6: Session link proposals. Additive tables plus the legacy group tables going away: the reviewed groups were
-- converted to link overrides in 0015, and a fresh import loads them into scratch tables consumed by post_import.sql.
CREATE TABLE session_link_proposals(
  id TEXT PRIMARY KEY,
  session_a TEXT NOT NULL,
  session_b TEXT NOT NULL,
  vod_a INTEGER NOT NULL,
  vod_b INTEGER NOT NULL,
  offset_seconds REAL NOT NULL,
  support INTEGER NOT NULL CHECK(support>=0),
  distinct_names INTEGER NOT NULL CHECK(distinct_names>=0),
  conflicts INTEGER NOT NULL CHECK(conflicts>=0),
  coverage REAL NOT NULL,
  tolerance REAL NOT NULL,
  evidence_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pending','accepted','rejected','superseded')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  decided_by_rule INTEGER NOT NULL DEFAULT 0 CHECK(decided_by_rule IN(0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(session_a<session_b),
  CHECK((status='pending' OR status='superseded') OR decided_at IS NOT NULL),
  UNIQUE(vod_a,vod_b,evidence_hash)
);
CREATE INDEX session_proposals_status ON session_link_proposals(status,created_at);
CREATE INDEX session_proposals_vods ON session_link_proposals(vod_a,vod_b,status);
CREATE INDEX session_proposals_sessions ON session_link_proposals(session_a,session_b) WHERE status='pending';
-- Detection IDs are not foreign keys: detections can be replaced, and rejected evidence must outlive them.
CREATE TABLE proposal_evidence(
  proposal_id TEXT NOT NULL REFERENCES session_link_proposals(id) ON DELETE CASCADE,
  detection_a TEXT NOT NULL,
  detection_b TEXT NOT NULL,
  delta REAL NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('support','conflict')),
  PRIMARY KEY(proposal_id,detection_a,detection_b)
);
CREATE INDEX proposal_evidence_pair ON proposal_evidence(detection_a,detection_b);
ALTER TABLE vods ADD COLUMN proposals_checked_at TEXT;

-- Eligibility (`session_proposal`) and the auto-accept rule (`session_auto_accept`) are read from processing_config with
-- code defaults; no rows are seeded, so the rule is disabled until an operator writes it.

-- Leaf tables first: nothing else references them. The clip_appearances compatibility view goes with them.
DROP VIEW clip_appearances;
DROP TABLE matchup_review_events;
DROP TABLE matchup_appearances;
DROP TABLE matchup_groups;
