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

export interface PublicState {
  search: number;
  cache: number;
  matchups: number;
  recordings: number;
}
const STATE_TTL_MS = 3000;
let remembered: { at: number; state: Promise<PublicState> } | undefined;

/** Revisions and high watermarks in one D1 round trip. Only hosted environments reuse the result for
 * a few seconds: a stale value can only delay a correction by that long or cause an extra 409 restart,
 * and `fresh` forces a read where a request must prove nothing changed while it ran.
 */
export const memoizesState = (env: Env) => env.ENVIRONMENT === "validation" || env.ENVIRONMENT === "production";
export function publicState(env: Env, fresh = false): Promise<PublicState> {
  const reuse = memoizesState(env);
  if (reuse && !fresh && remembered && Date.now() - remembered.at < STATE_TTL_MS) return remembered.state;
  const at = Date.now();
  const state = one<PublicState>(
    env,
    `SELECT s.revision AS search,c.revision AS cache,(SELECT coalesce(max(id),0) FROM matchups) AS matchups,
    (SELECT coalesce(max(id),0) FROM vods) AS recordings FROM public_search_state s,public_cache_state c WHERE s.id=1 AND c.id=1`,
  ).then((row) => {
    if (!row) throw new Error("Public visibility revision unavailable");
    return row;
  });
  if (reuse) {
    const entry = { at, state };
    remembered = entry;
    state.catch(() => {
      if (remembered === entry) remembered = undefined;
    });
  }
  return state;
}
export async function publicRevision(env: Env): Promise<string> {
  return String((await publicState(env)).cache);
}
