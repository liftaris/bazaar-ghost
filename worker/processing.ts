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
import { dispatchBranch, workflowDispatchUrl } from "./platform-ingestion-dispatch";
import { atomic } from "./atomic";
import { automaticVideoPredicate } from "./automatic-processing";
import { expectedProfile, profileCheck } from "./profiles";
import { proposeForRecording } from "./session-proposals";
import type { ChunkStatus, OperatorRunInputs, OpsWorkflowPayload, ProcessorMode, RunInputs, RunQuality } from "../contracts/operator-api";

/** A recording that may be processed. Expects vod_processing_context aliased as v. */
export const ELIGIBLE_RECORDING = "v.processing_enabled=1 AND v.ready_for_processing=1 AND v.availability='available'";
export function eligibleRecording(vodId: number) {
  return { sql: `EXISTS(SELECT 1 FROM vod_processing_context v WHERE v.id=? AND ${ELIGIBLE_RECORDING})`, args: [vodId] };
}
/** Statuses a chunk may be queued or reset from. Queued, processing and archived chunks are never touched. */
export const RESETTABLE: readonly ChunkStatus[] = ["pending", "failed", "completed"];
export const resettable = (column: string) => `${column} IN(${RESETTABLE.map((status) => `'${status}'`).join(",")})`;

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
const STALE_QUEUE_MS = 60 * 60_000;
export async function recover(env: Env) {
  const time = now(), stale = new Date(Date.now() - STALE_QUEUE_MS).toISOString();
  await env.DB.batch([
    statement(
      env,
      `UPDATE chunk_runs SET status='expired',finished_at=?,error='Lease expired'
      WHERE status='processing' AND claim_token IN(SELECT claim_token FROM chunks WHERE status='processing' AND lease_expires_at<?)`,
      time,
      time,
    ),
    statement(
      env,
      `UPDATE chunk_runs SET status='expired',finished_at=?,error='Queued run never started'
      WHERE status='queued' AND EXISTS(SELECT 1 FROM chunks c WHERE c.id=chunk_runs.chunk_id AND c.status='queued' AND c.queued_at=chunk_runs.queued_at AND c.queued_at<?)`,
      time,
      stale,
    ),
    statement(
      env,
      "UPDATE chunks SET status='failed',attempt_count=attempt_count+1,last_error='Queued run never started',updated_at=? WHERE status='queued' AND queued_at<?",
      time,
      stale,
    ),
    statement(
      env,
      `UPDATE chunks SET
      status=CASE WHEN attempt_count<max_attempts THEN 'pending' ELSE 'failed' END,
      claim_token=NULL,lease_expires_at=NULL,
      last_error=CASE WHEN status='failed' THEN last_error ELSE 'Lease expired' END,updated_at=?
      WHERE (status='processing' AND lease_expires_at<?)
        OR (status='failed' AND attempt_count<max_attempts AND updated_at<=?)`,
      time,
      time,
      new Date(Date.now() - 5 * 60_000).toISOString(),
    ),
  ]);
}
export async function pendingVideos(env: Env, limit = 100, platformsOnly = false) {
  const time = now();
  return rows(env, `SELECT v.id FROM vod_processing_context v
    WHERE ${ELIGIBLE_RECORDING}
    AND v.status IN('pending','partial','failed') AND json_array_length(v.bazaar_chapters)>0
    AND ${automaticVideoPredicate}
    ${platformsOnly ? `AND v.source IN(${ingestionPlatforms().map(entry => `'${entry.id}'`).join(',')})` : ''}
    AND (NOT EXISTS(SELECT 1 FROM chunks WHERE vod_id=v.id) OR EXISTS(
      SELECT 1 FROM chunks WHERE vod_id=v.id AND status='pending' AND (scheduled_for IS NULL OR scheduled_for<=?)))
    ORDER BY coalesce((SELECT max(priority) FROM chunks WHERE vod_id=v.id AND status='pending'
      AND (scheduled_for IS NULL OR scheduled_for<=?)),CASE WHEN v.source='twitch' THEN 0 ELSE -10 END) DESC,
      v.published_at DESC,v.id LIMIT ?`, time,time,integer(limit,'pending video limit',1,100));
}
export async function dispatchAutomatic(env: Env, vodId: number): Promise<Dispatched> {
  const allowed = await one(env, `SELECT 1 FROM vods v WHERE id=? AND ${automaticVideoPredicate}`, vodId);
  return allowed
    ? dispatch(env, vodId, { origin: "automatic", automaticFence: true, inputs: resolveInputs(env, {}, true) })
    : { chunkIds: [], batches: [] };
}

const QUALITY = /^(?:360|480|720|1080)p(?:60)?$/;
const RUNTIME_IMAGE = /^ghcr\.io\/liftaris\/bazaar-ghost\/sfde-next@sha256:[a-f0-9]{64}$/;
const OPERATOR_INPUTS: Record<keyof OperatorRunInputs, true> = { mode: true, quality: true };
const isMode = (value: unknown): value is ProcessorMode => value === "next" || value === "legacy";
const isQuality = (value: unknown): value is RunQuality => typeof value === "string" && QUALITY.test(value);

export function allowedModes(env: Env): ProcessorMode[] {
  return env.ENVIRONMENT === "validation" || env.ENVIRONMENT === "local" ? ["next", "legacy"] : ["legacy"];
}
/**
 * Parse requested inputs at a boundary. Automatic validation runs default to NEXT and every other run to legacy;
 * the runtime image is always this deployment's validation pin.
 */
export function resolveInputs(env: Env, requested: unknown, automatic = false): RunInputs {
  requireValue(requested !== null && typeof requested === "object" && !Array.isArray(requested), "Invalid run inputs");
  const given: Record<string, unknown> = { ...requested };
  requireValue(Object.keys(given).every((key) => Object.hasOwn(OPERATOR_INPUTS, key)), "Unsupported run inputs");
  const mode = given.mode ?? (automatic && env.ENVIRONMENT === "validation" ? "next" : "legacy");
  requireValue(isMode(mode) && allowedModes(env).includes(mode), "Processor mode is not allowed in this environment");
  const quality = given.quality ?? "480p";
  requireValue(isQuality(quality), "Invalid quality");
  const runtime = env.ENVIRONMENT === "validation" && env.SFDE_RUNTIME_IMAGE ? env.SFDE_RUNTIME_IMAGE : null;
  requireValue(runtime === null || RUNTIME_IMAGE.test(runtime), "Invalid SFDE runtime image");
  return { mode, quality, runtime_image: runtime };
}
export function requireDispatch(env: Env) {
  if (env.OUTBOUND_ENABLED !== "true" || !env.GITHUB_TOKEN)
    throw new HttpError(503, "GitHub dispatch is not configured");
}

export type Requester = { origin: "automatic" } | { origin: "manual" } | { origin: "operator"; requestedBy: string };
export type RunRequest = Requester & { inputs: RunInputs; automaticFence?: boolean };

/** One recording's dispatch under fixed inputs: which chunks may queue (fence on chunks c) and the workflow payload. */
export interface Workflow {
  vodId: number;
  inputs: RunInputs;
  fence: { sql: string; args: unknown[] };
  payload(ids: string[], queuedAt: string | null): OpsWorkflowPayload;
}
export async function workflow(env: Env, vodId: number, inputs: RunInputs, automaticFence = false): Promise<Workflow> {
  const branch = dispatchBranch(env.ENVIRONMENT);
  const vod = await one(env, "SELECT source,source_id FROM vods WHERE id=?", vodId);
  if (!vod) throw new HttpError(404, "VOD not found");
  const details = await vodDetails(env, vod.source_id, vod.source);
  if (inputs.runtime_image) requireValue(/^[a-f0-9]{40}$/.test(env.BUILD_COMMIT), "Invalid SFDE runtime revision");
  const next = inputs.mode === "next";
  const profile = next ? null : profileCheck(details.profile);
  return {
    vodId,
    inputs,
    fence: {
      sql: `c.vod_id=? AND ${resettable("c.status")} AND EXISTS(SELECT 1 FROM vod_processing_context v
        ${profile ? "JOIN sfde_profiles p ON p.id=v.effective_profile_id" : ""}
        WHERE v.id=c.vod_id AND ${ELIGIBLE_RECORDING} AND v.old_templates=?
        ${profile ? `AND p.id=? AND ${profile.sql}` : ""} ${automaticFence ? `AND ${automaticVideoPredicate}` : ""})`,
      args: [vodId, details.old_templates, ...(profile ? [details.profile.id, ...profile.args] : [])],
    },
    payload: (ids, queuedAt) => ({
      ref: branch,
      inputs: {
        vod_id: vod.source_id,
        source: vod.source,
        chunk_uuids: JSON.stringify(ids),
        ...(queuedAt ? { queued_at: queuedAt } : {}),
        old_templates: String(details.old_templates),
        quality: inputs.quality,
        ...(next ? { sfde_next: "true" } : { sfde_profile: JSON.stringify(details.streamers.sfde_profiles) }),
        ...(inputs.runtime_image ? { runtime_image: inputs.runtime_image, processor_revision: env.BUILD_COMMIT } : {}),
        environment: env.ENVIRONMENT,
      },
    }),
  };
}
/** Why each chunk would not queue under this workflow right now; null when it would. Read-only. */
export function queueability(env: Env, flow: Workflow, chunkIds: string[]) {
  return rows<{ chunk_id: string; reason: string | null }>(
    env,
    `SELECT r.value AS chunk_id,CASE
      WHEN c.id IS NULL OR c.vod_id<>? THEN 'Chunk not found in this recording'
      WHEN NOT ${resettable("c.status")} THEN 'Chunk is '||c.status
      WHEN v.availability<>'available' THEN 'Recording is '||v.availability
      WHEN NOT v.ready_for_processing THEN 'Recording is not ready for processing'
      WHEN NOT v.processing_enabled THEN 'Recording has processing disabled'
      WHEN NOT (${flow.fence.sql}) THEN 'Recording profile or template era no longer matches'
      END AS reason
    FROM json_each(?) r LEFT JOIN chunks c ON c.id=r.value LEFT JOIN vod_processing_context v ON v.id=c.vod_id`,
    flow.vodId,
    ...flow.fence.args,
    JSON.stringify(chunkIds),
  );
}
export interface Queued {
  chunkIds: string[];
  runIds: string[];
  payload: OpsWorkflowPayload | null;
}
/**
 * Move these chunks straight from a resettable status to queued and record their runs, in one batch,
 * then dispatch the workflow. An operator run gets exactly one attempt. A refused dispatch restores
 * each chunk's prior status and max_attempts and marks its run dispatch_failed.
 */
export async function queue(env: Env, flow: Workflow, chunkIds: string[], requester: Requester): Promise<Queued> {
  requireValue(chunkIds.length <= 256, "At most 256 chunks per dispatch");
  requireDispatch(env);
  const queuedAt = now();
  const planned = chunkIds.map((chunk) => ({ chunk, run: crypto.randomUUID() }));
  const [inserted] = await env.DB.batch([
    statement(
      env,
      `INSERT INTO chunk_runs(id,chunk_id,vod_id,origin,requested_by,inputs,status,queued_at,prior_status,prior_max_attempts)
      SELECT json_extract(r.value,'$.run'),c.id,c.vod_id,?,?,?,'queued',?,c.status,c.max_attempts
      FROM json_each(?) r JOIN chunks c ON c.id=json_extract(r.value,'$.chunk') WHERE ${flow.fence.sql} RETURNING id`,
      requester.origin,
      requester.origin === "operator" ? requester.requestedBy : null,
      JSON.stringify(flow.inputs),
      queuedAt,
      JSON.stringify(planned),
      ...flow.fence.args,
    ),
    statement(
      env,
      `UPDATE chunks SET status='queued',queued_at=?,updated_at=?,claim_token=NULL,lease_expires_at=NULL,scheduled_for=NULL,
        max_attempts=${requester.origin === "operator" ? "attempt_count+1" : "max_attempts"}
      WHERE id IN(SELECT r.chunk_id FROM chunk_runs r JOIN json_each(?) j ON r.id=json_extract(j.value,'$.run'))`,
      queuedAt,
      queuedAt,
      JSON.stringify(planned),
    ),
  ]);
  const runs = new Set(inserted.results.map((row: any) => row.id));
  const queued = planned.filter(({ run }) => runs.has(run));
  if (!queued.length) return { chunkIds: [], runIds: [], payload: null };
  const result = { chunkIds: queued.map((q) => q.chunk), runIds: queued.map((q) => q.run), payload: flow.payload(queued.map((q) => q.chunk), queuedAt) };
  try {
    await external(env, workflowDispatchUrl("process-vod.yml"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "BazaarGhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result.payload),
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    await env.DB.batch([
      statement(
        env,
        `UPDATE chunks SET status=r.prior_status,max_attempts=r.prior_max_attempts,queued_at=NULL,updated_at=?
        FROM chunk_runs r WHERE r.chunk_id=chunks.id AND r.id IN(SELECT value FROM json_each(?)) AND chunks.status='queued' AND chunks.queued_at=r.queued_at`,
        now(),
        JSON.stringify(result.runIds),
      ),
      statement(
        env,
        "UPDATE chunk_runs SET status='dispatch_failed',finished_at=?,error=? WHERE id IN(SELECT value FROM json_each(?)) AND status='queued'",
        now(),
        message,
        JSON.stringify(result.runIds),
      ),
    ]);
    throw new HttpError(502, message);
  }
  return result;
}
export interface Dispatched {
  chunkIds: string[];
  batches: Queued[];
}
/** Plan the recording and queue its pending chunks. */
export async function dispatch(env: Env, vodId: number, request: RunRequest): Promise<Dispatched> {
  const pending = await plan(env, vodId);
  if (!pending.length) return { chunkIds: [], batches: [] };
  const flow = await workflow(env, vodId, request.inputs, request.automaticFence);
  const batches: Queued[] = [];
  for (let offset = 0; offset < pending.length; offset += 256) {
    const batch = await queue(env, flow, pending.slice(offset, offset + 256).map((c) => String(c.id)), request);
    if (batch.chunkIds.length) batches.push(batch);
  }
  return { chunkIds: batches.flatMap((b) => b.chunkIds), batches };
}
/** A GitHub run identity from untrusted input; absent fields stay null. */
export function githubRun(input: { github_run_id?: unknown; github_run_attempt?: unknown }) {
  return {
    runId: input.github_run_id == null ? null : integer(input.github_run_id, "github_run_id", 1),
    runAttempt: input.github_run_attempt == null ? null : integer(input.github_run_attempt, "github_run_attempt", 1),
  };
}
export type GithubRun = ReturnType<typeof githubRun>;
/** The runner reports its GitHub run while preparing a dispatch, before any claim. */
export async function recordGithubRun(env: Env, ids: string[], queuedAt: string, github: GithubRun) {
  const result = await statement(
    env,
    `UPDATE chunk_runs SET github_run_id=coalesce(?,github_run_id),github_run_attempt=coalesce(?,github_run_attempt)
    WHERE chunk_id IN(SELECT value FROM json_each(?)) AND queued_at=? AND status IN('queued','processing')`,
    github.runId,
    github.runAttempt,
    JSON.stringify(ids),
    queuedAt,
  ).run();
  return result.meta.changes;
}
export async function claim(
  env: Env,
  id: string,
  queuedAt: string | null = null,
  expected?: { profile: unknown; oldTemplates: unknown; processorMode?: unknown },
  github: GithubRun = { runId: null, runAttempt: null },
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
  // A claim without queued_at adopts the chunk's queued run, or records a manual run when the chunk was pending.
  const [claimed] = await env.DB.batch([
    statement(
      env,
      `UPDATE chunks SET status='processing',claim_token=?,attempt_count=attempt_count+1,started_at=?,updated_at=?,lease_expires_at=?,last_error=NULL,completed_at=NULL,
        frames_processed=0,detections_count=0,processing_duration_ms=NULL
      WHERE id=? AND status IN('pending','queued') AND (? IS NULL OR (status='queued' AND queued_at=?)) AND EXISTS(SELECT 1 FROM vod_processing_context v WHERE v.id=chunks.vod_id AND ${ELIGIBLE_RECORDING}${fence.sql}) RETURNING id`,
      token,
      time,
      time,
      new Date(Date.now() + 35 * 60_000).toISOString(),
      uuid(id),
      queuedAt,
      queuedAt,
      ...fence.args,
    ),
    statement(
      env,
      `UPDATE chunk_runs SET status='processing',claim_token=?,claimed_at=?,github_run_id=coalesce(?,github_run_id),github_run_attempt=coalesce(?,github_run_attempt)
      WHERE chunk_id=? AND status='queued' AND queued_at=(SELECT queued_at FROM chunks WHERE id=? AND claim_token=?)`,
      token,
      time,
      github.runId,
      github.runAttempt,
      id,
      id,
      token,
    ),
    statement(
      env,
      `INSERT INTO chunk_runs(id,chunk_id,vod_id,origin,status,queued_at,claim_token,claimed_at,github_run_id,github_run_attempt)
      SELECT ?,c.id,c.vod_id,'manual','processing',?,?,?,?,? FROM chunks c
      WHERE c.id=? AND c.claim_token=? AND NOT EXISTS(SELECT 1 FROM chunk_runs WHERE claim_token=?)`,
      crypto.randomUUID(),
      time,
      token,
      time,
      github.runId,
      github.runAttempt,
      id,
      token,
      token,
    ),
  ]);
  const chunk = claimed.results[0];
  return { claimed: Boolean(chunk), claim_token: chunk ? token : null };
}
export async function failQueued(env: Env, ids: string[], queuedAt: string, error: string, github: GithubRun) {
  const time = now();
  const [failed] = await env.DB.batch([
    statement(
      env,
      `UPDATE chunks SET status='failed',attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE id IN(SELECT value FROM json_each(?)) AND status='queued' AND queued_at=? RETURNING id`,
      error,
      time,
      JSON.stringify(ids),
      queuedAt,
    ),
    statement(
      env,
      `UPDATE chunk_runs SET status='failed',finished_at=?,error=?,github_run_id=coalesce(?,github_run_id),github_run_attempt=coalesce(?,github_run_attempt)
      WHERE chunk_id IN(SELECT value FROM json_each(?)) AND queued_at=? AND status='queued'
      AND EXISTS(SELECT 1 FROM chunks c WHERE c.id=chunk_runs.chunk_id AND c.status='failed' AND c.queued_at=chunk_runs.queued_at)`,
      time,
      error,
      github.runId,
      github.runAttempt,
      JSON.stringify(ids),
      queuedAt,
    ),
  ]);
  return failed.results.length;
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
  const [result] = await env.DB.batch([
    statement(
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
    ),
    statement(
      env,
      `UPDATE chunk_runs SET status=c.status,finished_at=c.updated_at,error=c.last_error,frames_processed=c.frames_processed,detections_count=c.detections_count
      FROM chunks c WHERE c.id=? AND c.claim_token=chunk_runs.claim_token AND chunk_runs.claim_token=? AND chunk_runs.status='processing' AND c.status IN('completed','failed')`,
      id,
      token,
    ),
  ]);
  if (!result.meta.changes) throw new HttpError(409, "Lost chunk claim");
  if (data.status === "completed") {
    // A finished Recording may match another Recording; failures are retried by the scheduled sweep.
    const vod = await one(env, "SELECT v.id FROM chunks c JOIN vods v ON v.id=c.vod_id WHERE c.id=? AND v.status='completed'", id);
    if (vod) await proposeForRecording(env, vod.id).catch((error) =>
      console.log(JSON.stringify({ event: "session_proposal_failed", vod_id: vod.id, error: String(error) })));
  }
  return { updated: true };
}
