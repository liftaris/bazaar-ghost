import { one } from "./http";

/** Public delivery requires a CURRENT published detection reference. Historical, orphan
 * and debug objects remain in private R2 for operator access, never public URL guessing.
 * If one object is referenced at multiple anchors, any hidden reference wins.
 */
export async function publicImageVisible(env: Env, key: string): Promise<boolean> {
  if (!key || key.length > 2048 || key.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(key) ||
      key.split("/").some(part => part === "." || part === "..")) return false;
  const paths = JSON.stringify([key, `/detections/${key}`, `/storage/v1/object/public/detections/${key}`]);
  const result = await one<{ visible: number }>(env, `SELECT
    EXISTS(SELECT 1 FROM public_sources WHERE available=1 AND storage_path IN(SELECT value FROM json_each(?)))
    AND NOT EXISTS(SELECT 1 FROM detections d JOIN matchup_anchors c ON c.vod_id=d.vod_id AND c.anchor_seconds=d.frame_time_seconds JOIN matchups m ON m.id=c.matchup_id
      WHERE d.storage_path IN(SELECT value FROM json_each(?)) AND m.status='hidden') AS visible`, paths, paths);
  return result?.visible === 1;
}

export async function publicRevision(env: Env): Promise<string> {
  const row = await one<{ revision: number }>(env, "SELECT revision FROM public_cache_state WHERE id=1");
  if (!row) throw new Error("Public visibility revision unavailable");
  return String(row.revision);
}
