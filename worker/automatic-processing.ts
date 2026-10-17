import { one, requireValue } from "./http";

// Shared by the scheduler, queue consumer and atomic reservation. An old queued
// message must not bypass a changed rollout scope or launch historical backfill.
export const automaticVideoPredicate = `
  (NOT EXISTS(SELECT 1 FROM processing_config WHERE key='automatic_vods') OR
    v.source||':'||v.source_id IN(SELECT value FROM json_each((SELECT value FROM processing_config WHERE key='automatic_vods'))))
  AND (NOT EXISTS(SELECT 1 FROM processing_config WHERE key='automatic_vods_since') OR
    julianday(v.published_at)>=julianday((SELECT value FROM processing_config WHERE key='automatic_vods_since')))
`;

export async function automaticSince(env: Env): Promise<string | null> {
  const setting = await one(env, "SELECT value FROM processing_config WHERE key='automatic_vods_since'");
  if (!setting) return null;
  requireValue(typeof setting.value === "string" && /^\d{4}-\d\d-\d\dT/.test(setting.value) && Number.isFinite(Date.parse(setting.value)), "Invalid automatic processing start");
  return new Date(setting.value).toISOString();
}
