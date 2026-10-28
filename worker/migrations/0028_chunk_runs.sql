ALTER TABLE chunks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
CREATE TABLE chunk_runs (
 id TEXT PRIMARY KEY,
 chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
 vod_id INTEGER NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN('automatic','operator','manual')),
 requested_by TEXT CHECK(requested_by IS NULL OR origin='operator'),
 inputs TEXT CHECK(inputs IS NULL OR json_valid(inputs)),
 status TEXT NOT NULL CHECK(status IN('queued','processing','completed','failed','expired')),
 queued_at TEXT NOT NULL,
 -- The chunk's status and max_attempts before this run queued it; a refused GitHub dispatch restores them.
 prior_status TEXT,
 prior_max_attempts INTEGER,
 claim_token TEXT,
 claimed_at TEXT,
 finished_at TEXT,
 github_run_id INTEGER CHECK(github_run_id>0),
 github_run_attempt INTEGER CHECK(github_run_attempt>0),
 error TEXT,
 frames_processed INTEGER,
 detections_count INTEGER
);
CREATE INDEX chunk_runs_chunk ON chunk_runs(chunk_id,queued_at DESC);
-- One run per dispatch of a chunk. An untracked claim's manual run (no inputs) may share its claim time with a dispatch.
CREATE UNIQUE INDEX chunk_runs_dispatch ON chunk_runs(chunk_id,queued_at) WHERE inputs IS NOT NULL;
CREATE INDEX chunk_runs_vod ON chunk_runs(vod_id,queued_at DESC);
CREATE INDEX chunk_runs_claim ON chunk_runs(claim_token);
