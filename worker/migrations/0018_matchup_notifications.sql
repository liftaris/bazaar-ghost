-- M8: notifications per Matchup. One outbox row per Matchup (so a Matchup gaining Sources never re-notifies);
-- deliveries are keyed (matchup, subscription, destination). The detection-keyed tables and trigger are removed.
-- Additive plus dropping leaf tables only: no parent table is rebuilt.
CREATE TABLE notification_outbox_v2(
  matchup_id INTEGER PRIMARY KEY REFERENCES matchups(id),
  eligible_at TEXT NOT NULL,
  sent_at TEXT,
  suppressed_reason TEXT CHECK(suppressed_reason IS NULL OR suppressed_reason IN('merged','hidden','no_source'))
);
CREATE INDEX notification_outbox_v2_due ON notification_outbox_v2(eligible_at) WHERE sent_at IS NULL AND suppressed_reason IS NULL;
CREATE TABLE notification_deliveries_v2(
  matchup_id INTEGER NOT NULL REFERENCES matchups(id),
  subscription_id INTEGER NOT NULL REFERENCES notification_subscriptions(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pending','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(matchup_id,subscription_id,destination)
);
CREATE INDEX notification_deliveries_v2_problem ON notification_deliveries_v2(status) WHERE status IN('failed','uncertain');

-- History import: existing Matchups never notify.
INSERT INTO notification_outbox_v2(matchup_id,eligible_at,sent_at)
  SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM matchups;

DROP TRIGGER detection_outbox;
DROP TABLE notification_deliveries;
DROP TABLE notification_outbox;

-- A Matchup is founded by its first anchor (matchups.id = that anchor's id). Re-ingestion of an existing
-- anchor never founds a Matchup, so it never reaches this trigger. eligible_at leaves time for coalescing.
CREATE TRIGGER matchup_notification_founding AFTER INSERT ON matchups WHEN EXISTS(
  SELECT 1 FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
  JOIN vods v ON v.id=a.vod_id JOIN platform_settings ps ON ps.source=v.source
  WHERE a.id=NEW.id AND d.confidence>0.7 AND v.notifications_enabled=1 AND ps.notifications_enabled=1
) BEGIN
  INSERT OR IGNORE INTO notification_outbox_v2(matchup_id,eligible_at) VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now',
    '+'||coalesce((SELECT cast(value AS INTEGER) FROM processing_config WHERE key='coalesce_grace_seconds' AND value!='' AND value NOT GLOB '*[^0-9]*'),120)||' seconds'));
END;

-- Merging keeps exactly one chance to notify for the union. The winner inherits the loser's state; if either
-- side already notified (or was suppressed) the other is suppressed rather than announced again.
CREATE TRIGGER matchup_notification_merge AFTER UPDATE OF merged_into ON matchups
WHEN OLD.merged_into IS NULL AND NEW.merged_into IS NOT NULL BEGIN
  INSERT OR IGNORE INTO notification_outbox_v2(matchup_id,eligible_at,sent_at,suppressed_reason)
    SELECT NEW.merged_into,eligible_at,sent_at,suppressed_reason FROM notification_outbox_v2 WHERE matchup_id=NEW.id;
  UPDATE notification_outbox_v2 SET suppressed_reason='merged'
    WHERE matchup_id=NEW.merged_into AND sent_at IS NULL AND suppressed_reason IS NULL
    AND EXISTS(SELECT 1 FROM notification_outbox_v2 l WHERE l.matchup_id=NEW.id AND l.sent_at IS NOT NULL);
  UPDATE notification_outbox_v2 SET suppressed_reason='merged'
    WHERE matchup_id=NEW.id AND sent_at IS NULL AND suppressed_reason IS NULL
    AND EXISTS(SELECT 1 FROM notification_outbox_v2 w WHERE w.matchup_id=NEW.merged_into AND (w.sent_at IS NOT NULL OR w.suppressed_reason IS NOT NULL));
  DELETE FROM notification_outbox_v2 WHERE matchup_id=NEW.id AND sent_at IS NULL AND suppressed_reason IS NULL
    AND EXISTS(SELECT 1 FROM notification_outbox_v2 w WHERE w.matchup_id=NEW.merged_into AND w.sent_at IS NULL AND w.suppressed_reason IS NULL);
END;
