CREATE TABLE chunk_runs (
 id TEXT PRIMARY KEY,
 chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
 vod_id INTEGER NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN('automatic','operator')),
 requested_by TEXT,
 inputs TEXT NOT NULL CHECK(json_valid(inputs)),
 status TEXT NOT NULL CHECK(status IN('queued','dispatch_failed','processing','completed','failed','expired')),
 queued_at TEXT NOT NULL,
 claim_token TEXT,
 claimed_at TEXT,
 finished_at TEXT,
 github_run_id INTEGER CHECK(github_run_id>0),
 github_run_attempt INTEGER CHECK(github_run_attempt>0),
 error TEXT,
 frames_processed INTEGER,
 detections_count INTEGER
);
CREATE UNIQUE INDEX chunk_runs_chunk ON chunk_runs(chunk_id,queued_at DESC);
CREATE INDEX chunk_runs_vod ON chunk_runs(vod_id,queued_at DESC);
CREATE INDEX chunk_runs_queued ON chunk_runs(queued_at DESC);
CREATE INDEX chunk_runs_claim ON chunk_runs(claim_token);
