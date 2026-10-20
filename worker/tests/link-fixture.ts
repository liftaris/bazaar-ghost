import { linkAnchors, splitMatchup } from "../coalesce";
import { rows } from "../http";

const anchorsOf = (env: Env, detections: string[]) =>
  rows<{ id: number; matchup_id: number }>(env, "SELECT id,matchup_id FROM matchup_anchors WHERE current_detection_id IN(SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(detections));
/** Links the anchors of the given detections with `link` overrides; returns the canonical Matchup ID as text. */
export async function linkDetections(env: Env, detections: string[], evidence = "Verified the same fight by hand") {
  const result = await linkAnchors(env, (await anchorsOf(env, detections)).map(a => a.id), { actor: "test", evidence });
  return { matchup_id: String(result.matchup_id) };
}
/** Splits the detection's anchor off its Matchup with `unlink` overrides. */
export async function unlinkDetection(env: Env, detection: string, evidence = "Reversing the earlier review") {
  const [anchor] = await anchorsOf(env, [detection]);
  return splitMatchup(env, anchor.matchup_id, [anchor.id], { actor: "test", evidence });
}
