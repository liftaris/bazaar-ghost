CREATE TABLE operators (
 user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
 granted_by TEXT NOT NULL,
 granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
