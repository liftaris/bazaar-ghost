import {
  HttpError,
  integer,
  now,
  one,
  requireValue,
  statement,
} from "./http";
import { plan } from "./processing";
import { atomic } from "./atomic";
import { profileCheck } from "./profiles";

export async function retryVod(env: Env, input: Record<string, any>) {
  const id = integer(input.vod_id, "vod_id", 1);
  const mode = input.mode ?? "failed";
  requireValue(
    ["failed", "all"].includes(mode),
    "Retry mode must be failed or all",
  );
  const vod = await one(
    env,
    "SELECT * FROM vod_processing_context WHERE id=?",
    id,
  );
  requireValue(
    vod &&
      vod.availability === "available" &&
      vod.ready_for_processing &&
      vod.processing_enabled,
    "VOD is not eligible",
  );
  if (
    await one(
      env,
      "SELECT id FROM chunks WHERE vod_id=? AND status IN('processing','queued')",
      id,
    )
  )
    throw new HttpError(409, "VOD has active workers");
  // Account eligibility or a new claim can change after the helpful preflight
  // errors above. Recheck both with the reset so a competing operator/runner wins.
  const [, , result] = await atomic(env, [
    {
      sql: "EXISTS(SELECT 1 FROM vod_processing_context WHERE id=? AND availability='available' AND ready_for_processing=1 AND processing_enabled=1)",
      args: [id],
    },
    {
      sql: "NOT EXISTS(SELECT 1 FROM chunks WHERE vod_id=? AND status IN('processing','queued'))",
      args: [id],
    },
  ], [statement(
    env,
    `UPDATE chunks SET status='pending',last_error=NULL,claim_token=NULL,completed_at=NULL,lease_expires_at=NULL,attempt_count=0
    WHERE vod_id=? AND status ${mode === "all" ? "IN('completed','failed','pending')" : "='failed'"} RETURNING id`,
    id,
  )]);
  return { reset: result.results.length, chunks: await plan(env, id) };
}
export async function setStreamer(env: Env, input: Record<string, any>) {
  const id = integer(input.id, "id", 1);
  const changes: Record<string, any> = { updated_at: now() };
  if (input.processing_enabled != null) {
    requireValue(
      typeof input.processing_enabled === "boolean",
      "Invalid processing_enabled",
    );
    changes.processing_enabled = input.processing_enabled;
  }
  if (input.sfde_profile_id != null)
    changes.sfde_profile_id = integer(
      input.sfde_profile_id,
      "sfde_profile_id",
      1,
    );
  if (input.login != null) {
    requireValue(
      typeof input.login === "string" &&
        /^[a-zA-Z0-9_]{1,25}$/.test(input.login),
      "Invalid login",
    );
    changes.login = input.login.toLowerCase();
  }
  if (input.display_name != null) {
    requireValue(
      typeof input.display_name === "string" &&
        input.display_name.length <= 100,
      "Invalid display_name",
    );
    changes.display_name = input.display_name;
  }
  if (!(await one(env, "SELECT id FROM streamers WHERE id=?", id))) {
    requireValue(changes.login, "New streamer requires login");
    await statement(
      env,
      "INSERT INTO streamers(id,login,display_name,processing_enabled,sfde_profile_id) VALUES(?,?,?,?,?)",
      id,
      changes.login,
      changes.display_name,
      changes.processing_enabled ?? true,
      changes.sfde_profile_id ?? 1,
    ).run();
  } else {
    const checks = changes.sfde_profile_id == null ? [] : [{
      sql: `NOT EXISTS(SELECT 1 FROM vod_processing_context v JOIN chunks c ON c.vod_id=v.id
        WHERE v.streamer_id=? AND v.source='twitch' AND v.sfde_profile_id IS NULL
        AND v.effective_profile_id<>? AND c.status IN('queued','processing'))`,
      args: [id, changes.sfde_profile_id],
    }];
    await atomic(env, checks, [statement(
      env,
      `UPDATE streamers SET ${Object.keys(changes)
        .map((k) => `${k}=?`)
        .join(",")} WHERE id=?`,
      ...Object.values(changes),
      id,
    )]);
  }
  return { updated: true };
}
export async function setProfile(env: Env, input: Record<string, any>) {
  const id = integer(input.id, "id", 1);
  requireValue(
    typeof input.profile_name === "string" &&
      input.profile_name.length > 0 &&
      input.profile_name.length <= 100,
    "Invalid profile_name",
  );
  for (const field of ["crop_region", "igd_crop_region"]) {
    if (field === "igd_crop_region" && input[field] == null) continue;
    const r = input[field];
    requireValue(
      Array.isArray(r) &&
        r.length === 4 &&
        r.every((v) => typeof v === "number" && Number.isFinite(v)),
      "Invalid crop region",
    );
    requireValue(
      r[0] >= 0 &&
        r[1] >= 0 &&
        r[2] > 0 &&
        r[3] > 0 &&
        r[0] + r[2] <= 1.000000001 &&
        r[1] + r[3] <= 1.000000001,
      "Crop must fit the frame",
    );
  }
  if (input.custom_edge != null)
    requireValue(
      typeof input.custom_edge === "number" &&
        input.custom_edge > 0 &&
        input.custom_edge <= 1,
      "Invalid custom_edge",
    );
  if (input.opaque_edge != null)
    requireValue(typeof input.opaque_edge === "boolean", "Invalid opaque_edge");
  const match = profileCheck({ ...input, opaque_edge: input.opaque_edge ?? true });
  await atomic(env, [{
    sql: `NOT EXISTS(SELECT 1 FROM sfde_profiles p WHERE p.id=? AND NOT (${match.sql})
      AND EXISTS(SELECT 1 FROM vod_processing_context v JOIN chunks c ON c.vod_id=v.id
        WHERE v.effective_profile_id=p.id AND c.status IN('queued','processing')))`,
    args: [id, ...match.args],
  }], [statement(
    env,
    `INSERT INTO sfde_profiles(id,profile_name,crop_region,igd_crop_region,custom_edge,opaque_edge) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_name=excluded.profile_name,crop_region=excluded.crop_region,igd_crop_region=excluded.igd_crop_region,custom_edge=excluded.custom_edge,opaque_edge=excluded.opaque_edge,updated_at=?`,
    id,
    input.profile_name,
    JSON.stringify(input.crop_region),
    input.igd_crop_region ? JSON.stringify(input.igd_crop_region) : null,
    input.custom_edge,
    input.opaque_edge ?? true,
    now(),
  )]);
  return { updated: true };
}
