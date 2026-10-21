-- Gross model-cost estimates, not invoices. No image bytes or claim secrets.
-- No FK cascade: deleting a chunk must not erase its daily reservations.
CREATE TABLE sfde_inference (
  request_id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  task TEXT NOT NULL CHECK(task IN ('ghost_hero','streamer_hero','clock_day')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','uncertain')),
  reserved_nano_usd INTEGER NOT NULL CHECK(reserved_nano_usd > 0),
  charged_nano_usd INTEGER NOT NULL CHECK(charged_nano_usd >= 0),
  actual_nano_usd INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR length(response_json) <= 70000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sfde_inference_day ON sfde_inference(utc_day);
CREATE INDEX sfde_inference_chunk ON sfde_inference(chunk_id);
