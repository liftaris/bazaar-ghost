-- Every image path a detection references (its storage_path and each field_evidence image_path),
-- so public screenshot delivery checks visibility by index instead of scanning all evidence JSON.
CREATE TABLE detection_images(
 path TEXT NOT NULL,
 detection_id TEXT NOT NULL,
 PRIMARY KEY(path,detection_id)
) WITHOUT ROWID;
CREATE INDEX detection_images_detection ON detection_images(detection_id);

CREATE TRIGGER detection_images_insert AFTER INSERT ON detections BEGIN
 INSERT OR IGNORE INTO detection_images(path,detection_id)
 SELECT NEW.storage_path,NEW.id WHERE NEW.storage_path IS NOT NULL
 UNION SELECT e.value,NEW.id FROM json_tree(CASE WHEN json_valid(NEW.field_evidence) THEN NEW.field_evidence ELSE '{}' END) e
 WHERE e.key='image_path' AND e.type='text';
END;
CREATE TRIGGER detection_images_update AFTER UPDATE OF storage_path,field_evidence ON detections BEGIN
 DELETE FROM detection_images WHERE detection_id=OLD.id;
 INSERT OR IGNORE INTO detection_images(path,detection_id)
 SELECT NEW.storage_path,NEW.id WHERE NEW.storage_path IS NOT NULL
 UNION SELECT e.value,NEW.id FROM json_tree(CASE WHEN json_valid(NEW.field_evidence) THEN NEW.field_evidence ELSE '{}' END) e
 WHERE e.key='image_path' AND e.type='text';
END;
CREATE TRIGGER detection_images_delete AFTER DELETE ON detections BEGIN
 DELETE FROM detection_images WHERE detection_id=OLD.id;
END;

INSERT OR IGNORE INTO detection_images(path,detection_id)
SELECT storage_path,id FROM detections WHERE storage_path IS NOT NULL;
INSERT OR IGNORE INTO detection_images(path,detection_id)
SELECT e.value,d.id FROM detections d,json_tree(d.field_evidence) e
WHERE json_valid(d.field_evidence) AND e.key='image_path' AND e.type='text';
