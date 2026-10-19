-- Independent automatic switches per platform. A platform without a row is fully
-- disabled, so adding a source to the code never enables automatic work on its own.
--   ingestion_enabled:  poll enrolled accounts and catalog their new recordings
--   discovery_enabled:  find recordings/creators that are not enrolled yet
--   processing_enabled: dispatch automatic OCR for this platform's recordings
CREATE TABLE platform_settings (
  source TEXT PRIMARY KEY CHECK(length(source) BETWEEN 1 AND 32),
  ingestion_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ingestion_enabled IN (0,1)),
  discovery_enabled INTEGER NOT NULL DEFAULT 0 CHECK(discovery_enabled IN (0,1)),
  processing_enabled INTEGER NOT NULL DEFAULT 0 CHECK(processing_enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Preserve current behavior: Twitch on; YouTube/Bilibili follow the retired
-- automatic_platform_ingestion key. Their automatic processing was not gated.
INSERT INTO platform_settings(source,ingestion_enabled,discovery_enabled,processing_enabled) VALUES ('twitch',1,1,1);
INSERT INTO platform_settings(source,ingestion_enabled,discovery_enabled,processing_enabled)
  SELECT s.source,p.enabled,p.enabled,1
  FROM (SELECT 'youtube' AS source UNION ALL SELECT 'bilibili') s,
    (SELECT CASE WHEN EXISTS(SELECT 1 FROM processing_config
      WHERE key='automatic_platform_ingestion' AND value='false') THEN 0 ELSE 1 END AS enabled) p;
DELETE FROM processing_config WHERE key='automatic_platform_ingestion';
