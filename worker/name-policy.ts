/** Observed OCR text is not necessarily an identity. Keep display and discovery separate. */
export function nameTier(row: { username: string | null; name_state: string; confidence: number | null }) {
  if (row.username === null) return 3;
  if (row.name_state === "legacy" || row.name_state === "complete") return (row.confidence ?? 0) > 0.7 ? 0 : 1;
  return 2;
}
/** Must match the public_matchups view's name ranking. */
export const nameOrder = (alias: string) => `CASE WHEN ${alias}.username IS NULL THEN 3
  WHEN ${alias}.name_state IN('legacy','complete') AND ${alias}.confidence>0.7 THEN 0
  WHEN ${alias}.name_state IN('legacy','complete') THEN 1 ELSE 2 END,
  ${alias}.confidence DESC,${alias}.rank IS NULL,${alias}.igd IS NULL,${alias}.indexed_at,${alias}.detection_id`;

/** Discovery policy only: never use this to remove Sources, scoped browse or saved fights.
 * All associated recordings count, not only the selected/available Source. */
export const discoveryAllowed = (matchupId: string) => `NOT EXISTS(
  SELECT 1 FROM matchups policy_m JOIN sessions policy_s ON policy_s.id=policy_m.session_id
  WHERE policy_m.id=${matchupId} AND policy_s.streamer_mode=1)
  AND NOT EXISTS(SELECT 1 FROM matchup_anchors policy_a JOIN vods policy_v ON policy_v.id=policy_a.vod_id
    LEFT JOIN sessions policy_vs ON policy_vs.id=policy_v.session_id
    WHERE policy_a.matchup_id=${matchupId} AND (policy_v.streamer_mode=1 OR coalesce(policy_vs.streamer_mode,0)=1))`;
