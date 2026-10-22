import {
  HttpError,
  integer,
  now,
  one,
  requireValue,
  rows,
  statement,
  uuid,
  decodeRow,
  external,
} from "./http";
import { source, videoIdentity, ingestionPlatforms } from "./platform-registry";
import { dispatchBranch } from "./platform-ingestion-dispatch";
import { atomic } from "./atomic";
import { automaticVideoPredicate } from "./automatic-processing";
import { expectedProfile, profileCheck } from "./profiles";
import { proposeForRecording } from "./session-proposals";

export function normalizeRanges(
  input: unknown,
  duration: number,
): [number, number][] {
  requireValue(
    Array.isArray(input) && input.length % 2 === 0,
    "Invalid Bazaar chapters",
  );
  const ranges: [number, number][] = [];
  for (let i = 0; i < input.length; i += 2) {
    integer(input[i], "chapter start");
    integer(input[i + 1], "chapter end");
    const start = Math.min(duration, input[i]),
      end = Math.min(duration, input[i + 1]);
    requireValue(end >= start, "Reversed chapter");
    if (end > start) ranges.push([start, end]);
  }
  const merged: [number, number][] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
export function missingChunks(
  ranges: [number, number][],
  existing: [number, number][],
): [number, number][] {
  const missing: [number, number][] = [];
  for (const [start, end] of ranges) {
    let cursor = start;
    for (const [a, b] of [...existing].sort((a, b) => a[0] - b[0])) {
      if (b <= cursor || a >= end) continue;
      while (cursor < Math.min(a, end)) {
        const next = Math.min(cursor + 1800, a, end);
        missing.push([cursor, next]);
        cursor = next;
      }
      cursor = Math.max(cursor, b);
    }
    while (cursor < end) {
      const next = Math.min(cursor + 1800, end);
      missing.push([cursor, next]);
      cursor = next;
    }
  }
  return missing;
}
export async function vodDetails(
  env: Env,
  sourceId: string,
  platform = "twitch",
): Promise<Record<string, any>> {
  videoIdentity(source(platform),sourceId);
  const vod = await one(
    env,
    "SELECT * FROM vod_processing_context WHERE source=? AND source_id=?",
    platform, sourceId,
  );
  if (!vod) throw new HttpError(404, "VOD not found");
  const profile = await one(
    env,
    "SELECT * FROM sfde_profiles WHERE id=?",
    vod.effective_profile_id,
  );
  return {
    ...decodeRow(vod),
    profile: profile && decodeRow(profile),
    old_templates: Boolean(vod.old_templates),
    streamers: {
      processing_enabled: Boolean(vod.processing_enabled),
      sfde_profiles: profile && decodeRow(profile),
    },
  };
}
export async function plan(
  env: Env,
  vodId: number,
  checks: Array<{sql:string;args:unknown[]}> = [],
): Promise<Record<string, any>[]> {
  let vod = await one(
    env,
    "SELECT * FROM vod_processing_context WHERE id=?",
    vodId,
  );
  if (
    !vod ||
    !vod.processing_enabled ||
    !vod.ready_for_processing ||
    vod.availability !== "available"
  )
    return [];
  // Retry a concurrent planner's overlap conflict by reading its committed intervals.
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await rows(
      env,
      "SELECT start_seconds,end_seconds,chunk_index FROM chunks WHERE vod_id=? ORDER BY start_seconds",
      vodId,
    );
    const gaps = missingChunks(
      normalizeRanges(JSON.parse(vod.bazaar_chapters), vod.duration_seconds),
      existing.map((c) => [c.start_seconds, c.end_seconds]),
    );
    const index = existing.reduce((m, c) => Math.max(m, c.chunk_index), -1) + 1;
    if (!gaps.length) break;
    const priority = vod.source === "twitch" ? 0 : -10;
    try {
      await atomic(env,[...checks,{sql:"SELECT EXISTS(SELECT 1 FROM vod_processing_context WHERE id=? AND duration_seconds=? AND bazaar_chapters=? AND processing_enabled=1 AND ready_for_processing=1 AND availability='available')",args:[vodId,vod.duration_seconds,vod.bazaar_chapters]}],[
        ...gaps.map(([a, b], i) =>
          statement(
            env,
            "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,priority) VALUES(?,?,?,?,?,?)",
            crypto.randomUUID(),
            vodId,
            a,
            b,
            index + i,
            priority,
          ),
        ),
        statement(
          env,
          "UPDATE vods SET status=CASE WHEN status='completed' THEN 'partial' ELSE status END WHERE id=?",
          vodId,
        ),
      ]);
      break;
    } catch (error) {
      if (attempt === 2 || !(String(error).includes("overlapping chunk") || (error instanceof HttpError && error.status===409))) throw error;
      vod = await one(env,"SELECT * FROM vod_processing_context WHERE id=?",vodId);
      if (!vod || !vod.processing_enabled || !vod.ready_for_processing || vod.availability !== "available") return [];
    }
  }
  return rows(
    env,
    "SELECT * FROM chunks WHERE vod_id=? AND status='pending' AND (scheduled_for IS NULL OR scheduled_for<=?) ORDER BY start_seconds",
    vodId,
    now(),
  );
}
export async function recover(env: Env) {
  const time = now();
  await statement(
    env,
    `UPDATE chunks SET
      status=CASE WHEN attempt_count+CASE WHEN status='queued' THEN 1 ELSE 0 END<3 THEN 'pending' ELSE 'failed' END,
      attempt_count=attempt_count+CASE WHEN status='queued' THEN 1 ELSE 0 END,
      claim_token=NULL,lease_expires_at=NULL,
      last_error=CASE WHEN status='failed' THEN last_error ELSE 'Lease expired' END,updated_at=?
      WHERE (status='processing' AND lease_expires_at<?) OR (status='queued' AND queued_at<?)
        OR (status='failed' AND attempt_count<3 AND updated_at<=?)`,
    time,
    time,
    new Date(Date.now() - 35 * 60_000).toISOString(),
    new Date(Date.now() - 5 * 60_000).toISOString(),
  ).run();
}
export async function pendingVideos(env: Env, limit = 3, platformsOnly = false) {
  const time = now();
  return rows(env, `SELECT v.id FROM vod_processing_context v
    WHERE v.processing_enabled=1 AND v.ready_for_processing=1 AND v.availability='available'
    AND v.status IN('pending','partial','failed') AND json_array_length(v.bazaar_chapters)>0
    AND ${automaticVideoPredicate}
    ${platformsOnly ? `AND v.source IN(${ingestionPlatforms().map(entry => `'${entry.id}'`).join(',')})` : ''}
    AND (NOT EXISTS(SELECT 1 FROM chunks WHERE vod_id=v.id) OR EXISTS(
      SELECT 1 FROM chunks WHERE vod_id=v.id AND status='pending' AND (scheduled_for IS NULL OR scheduled_for<=?)))
    ORDER BY coalesce((SELECT max(priority) FROM chunks WHERE vod_id=v.id AND status='pending'
      AND (scheduled_for IS NULL OR scheduled_for<=?)),CASE WHEN v.source='twitch' THEN 0 ELSE -10 END) DESC,
      v.published_at DESC,v.id LIMIT ?`, time,time,integer(limit,'pending video limit',1,100));
}
export async function dispatchAutomatic(env: Env, vodId: number) {
  const allowed = await one(env, `SELECT 1 FROM vods v WHERE id=? AND ${automaticVideoPredicate}`, vodId);
  return allowed ? dispatch(env, vodId, true) : [];
}
export async function dispatch(env: Env, vodId: number, automatic = false) {
  const pending = await plan(env, vodId);
  if (!pending.length) return [];
  const branch = dispatchBranch(env.ENVIRONMENT);
  if (env.OUTBOUND_ENABLED !== "true" || !env.GITHUB_TOKEN)
    throw new HttpError(503, "GitHub dispatch is not configured");
  const vod = await one(env, "SELECT source,source_id FROM vods WHERE id=?", vodId);
  const details = await vodDetails(env, vod!.source_id, vod!.source);
  const profile = profileCheck(details.profile);
  const configured = await one(
    env,
    "SELECT value FROM processing_config WHERE key='max_concurrent_chunks'",
  );
  const maxActive = integer(
    Number(configured?.value ?? 10),
    "max_concurrent_chunks",
    1,
    256,
  );
  const dispatched: string[] = [];
  for (let offset = 0; offset < pending.length; offset += 256) {
    const queuedAt = now();
    const claims = await env.DB.batch(
      pending
        .slice(offset, offset + 256)
        .map((c) =>
          statement(
            env,
            `UPDATE chunks SET status='queued',queued_at=?,updated_at=? WHERE id=? AND status='pending' AND (scheduled_for IS NULL OR scheduled_for<=?) AND EXISTS(SELECT 1 FROM vod_processing_context v JOIN sfde_profiles p ON p.id=v.effective_profile_id WHERE v.id=chunks.vod_id AND v.processing_enabled=1 AND v.ready_for_processing=1 AND v.availability='available' AND p.id=? AND ${profile.sql} AND v.old_templates=? ${automatic ? `AND ${automaticVideoPredicate}` : ''}) AND (SELECT count(*) FROM chunks WHERE status IN('queued','processing'))<? RETURNING id`,
            queuedAt,
            queuedAt,
            c.id,
            queuedAt,
            details.profile.id,
            ...profile.args,
            details.old_templates,
            maxActive,
          ),
        ),
    );
    const ids = claims.flatMap((r) => r.results.map((c: any) => c.id));
    if (!ids.length) continue;
    try {
      await external(
        env,
        "https://api.github.com/repos/liftaris/bazaar-ghost/actions/workflows/process-vod.yml/dispatches",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "BazaarGhost",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: branch,
            inputs: {
              vod_id: vod!.source_id,
              source: vod!.source,
              chunk_uuids: JSON.stringify(ids),
              queued_at: queuedAt,
              old_templates: String(details.old_templates),
              sfde_profile: JSON.stringify(details.streamers.sfde_profiles),
              environment: env.ENVIRONMENT,
            },
          }),
        },
      );
      dispatched.push(...ids);
    } catch (error) {
      await env.DB.batch(
        ids.map((id) =>
          statement(
            env,
            "UPDATE chunks SET status='pending',queued_at=NULL WHERE id=? AND status='queued' AND queued_at=?",
            id,
            queuedAt,
          ),
        ),
      );
      throw error;
    }
  }
  return dispatched;
}
export async function claim(
  env: Env,
  id: string,
  queuedAt: string | null = null,
  expected?: { profile: unknown; oldTemplates: unknown; processorMode?: unknown },
) {
  requireValue(
    queuedAt === null ||
      (typeof queuedAt === "string" && Number.isFinite(Date.parse(queuedAt))),
    "Invalid dispatch timestamp",
  );
  let fence = { sql: '', args: [] as unknown[] };
  if (expected) {
    requireValue(expected.processorMode === undefined || expected.processorMode === 'legacy' || expected.processorMode === 'next', 'Invalid processor mode');
    const next = expected.processorMode === 'next';
    if (next) requireValue(env.ENVIRONMENT === 'validation' || env.ENVIRONMENT === 'local', 'NEXT claims require validation/local');
    requireValue(typeof expected.oldTemplates === 'boolean', 'Expected template era required');
    if (next) {
      // Automatic layout is independent of saved crop/profile mutations, but
      // still binds the catalog template era in the same atomic claim update.
      fence = { sql: ' AND v.old_templates=?', args: [expected.oldTemplates] };
    } else {
      const profile = expectedProfile(expected.profile);
      const match = profileCheck(profile);
      fence = {
        sql: ` AND v.old_templates=? AND v.effective_profile_id=? AND EXISTS(SELECT 1 FROM sfde_profiles p WHERE p.id=v.effective_profile_id AND ${match.sql})`,
        args: [expected.oldTemplates, profile.id, ...match.args],
      };
    }
  }
  const token = crypto.randomUUID(),
    time = now();
  const chunk = await one(
    env,
    `UPDATE chunks SET status='processing',claim_token=?,attempt_count=attempt_count+1,started_at=?,updated_at=?,lease_expires_at=?,last_error=NULL,completed_at=NULL
    WHERE id=? AND status IN('pending','queued') AND (? IS NULL OR (status='queued' AND queued_at=?)) AND EXISTS(SELECT 1 FROM vod_processing_context v WHERE v.id=chunks.vod_id AND v.processing_enabled=1 AND v.ready_for_processing=1 AND v.availability='available'${fence.sql}) RETURNING id`,
    token,
    time,
    time,
    new Date(Date.now() + 35 * 60_000).toISOString(),
    uuid(id),
    queuedAt,
    queuedAt,
    ...fence.args,
  );
  return { claimed: Boolean(chunk), claim_token: chunk ? token : null };
}
export async function owned(env: Env, id: string, token: string | null) {
  if (!token) throw new HttpError(409, "Claim token required");
  const chunk = await one(
    env,
    "SELECT c.*,v.source,v.source_id,v.creator_name AS streamer FROM chunks c JOIN vod_processing_context v ON v.id=c.vod_id WHERE c.id=? AND c.claim_token=? AND c.status='processing' AND c.lease_expires_at>?",
    uuid(id),
    token,
    now(),
  );
  if (!chunk)
    throw new HttpError(
      409,
      "Chunk claim expired or belongs to another runner",
    );
  return chunk;
}
export async function updateChunk(
  env: Env,
  id: string,
  token: string | null,
  data: Record<string, any>,
) {
  await owned(env, id, token);
  requireValue(
    ["processing", "completed", "failed"].includes(data.status),
    "Invalid chunk status",
  );
  const changes: Record<string, any> = {
    status: data.status,
    updated_at: now(),
  };
  for (const field of [
    "frames_processed",
    "detections_count",
    "processing_duration_ms",
  ])
    if (data[field] != null) changes[field] = integer(data[field], field);
  if (data.quality != null) {
    requireValue(
      typeof data.quality === 'string' && data.quality.length <= 32 &&
        /^[1-9]\d*p(?:\d+(?:\.\d+)?)?$/.test(data.quality) &&
        (!data.quality.split('p')[1] || Number(data.quality.split('p')[1]) > 0),
      "Invalid quality",
    );
    changes.quality = data.quality;
  }
  if (data.error != null)
    changes.last_error = String(data.error).slice(0, 2000);
  if (data.status !== "processing") {
    changes.lease_expires_at = null;
    changes.completed_at = data.status === "completed" ? now() : null;
  }
  const result = await statement(
    env,
    `UPDATE chunks SET ${Object.keys(changes)
      .map((k) => `${k}=?`)
      .join(
        ",",
      )} WHERE id=? AND claim_token=? AND status='processing' AND lease_expires_at>?`,
    ...Object.values(changes),
    id,
    token,
    now(),
  ).run();
  if (!result.meta.changes) throw new HttpError(409, "Lost chunk claim");
  if (data.status === "completed") {
    // A finished Recording may match another Recording; failures are retried by the scheduled sweep.
    const vod = await one(env, "SELECT v.id FROM chunks c JOIN vods v ON v.id=c.vod_id WHERE c.id=? AND v.status='completed'", id);
    if (vod) await proposeForRecording(env, vod.id).catch((error) =>
      console.log(JSON.stringify({ event: "session_proposal_failed", vod_id: vod.id, error: String(error) })));
  }
  return { updated: true };
}
