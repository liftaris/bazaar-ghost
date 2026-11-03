-- Each Matchup's latest indexing time (the newest current detection on any of its anchors), kept by
-- triggers so the unfiltered public browse can walk an index in display order instead of ranking every Matchup.
-- Existing rows are backfilled in batches by scripts/backfill_matchup_indexed_at.py: one UPDATE over every Matchup
-- exceeded D1's storage-operation timeout on validation.
ALTER TABLE matchups ADD COLUMN indexed_at TEXT;

CREATE TRIGGER matchup_indexed_at_insert AFTER INSERT ON matchup_anchors WHEN NEW.matchup_id IS NOT NULL BEGIN
 UPDATE matchups SET indexed_at=(SELECT max(d.created_at) FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
  WHERE a.matchup_id=matchups.id) WHERE id=NEW.matchup_id;
END;
CREATE TRIGGER matchup_indexed_at_update AFTER UPDATE OF current_detection_id,matchup_id ON matchup_anchors BEGIN
 UPDATE matchups SET indexed_at=(SELECT max(d.created_at) FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
  WHERE a.matchup_id=matchups.id) WHERE id IN(NEW.matchup_id,OLD.matchup_id);
END;
CREATE TRIGGER matchup_indexed_at_delete AFTER DELETE ON matchup_anchors BEGIN
 UPDATE matchups SET indexed_at=(SELECT max(d.created_at) FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
  WHERE a.matchup_id=matchups.id) WHERE id=OLD.matchup_id;
END;

CREATE INDEX matchups_browse ON matchups(indexed_at DESC,id DESC) WHERE status='visible' AND merged_into IS NULL;
