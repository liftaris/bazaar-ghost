-- Durable catalog requests bridge D1 and Queues without losing work between them.
-- No FK: an operator/EventSub request can precede the streamer's first catalog.
CREATE TABLE twitch_catalog_work (
  streamer_id INTEGER PRIMARY KEY,
  requested_version INTEGER NOT NULL DEFAULT 1,
  completed_version INTEGER NOT NULL DEFAULT 0,
  cycle_version INTEGER,
  continuation TEXT CHECK(continuation IS NULL OR json_valid(continuation)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('idle','pending','queued','running','failed')),
  due_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX twitch_catalog_due ON twitch_catalog_work(due_at,streamer_id) WHERE state='pending';
CREATE INDEX twitch_catalog_expiry ON twitch_catalog_work(lease_expires_at) WHERE state IN ('queued','running');
