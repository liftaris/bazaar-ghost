import type {
  CatalogWorkState,
  ChunkStatus,
  InventoryChannel,
  InventoryItem,
  InventoryState,
  IngestionJobKind,
  IngestionJobStatus,
  OpsAttention,
  OpsAttentionKind,
  OpsAttentionTarget,
  OpsChannelRef,
  OpsChunk,
  OpsDetection,
  OpsDetectionRow,
  OpsIngestion,
  OpsIngestionJob,
  OpsRecording,
  OpsReprocessRecording,
  OpsReprocessResponse,
  OpsRoutes,
  OpsRun,
  OpsStreamer,
  RecordingStatus,
  RunInputs,
  StatusCounts,
} from "../contracts/operator-api";
import type { Page } from "../contracts/public-api";
import { authenticated, requireCsrf, type AuthEnv, type Identity } from "./auth";
import { jsonBody, only, privateResponse } from "./auth/security";
import { body, HttpError, one, readText, requireValue, rows, statement, uuid } from "./http";
import { parameters } from "./native-api";
import { keysetAfter, keysetPage } from "./native-cursor";
import { objectPath, projectEncounter, streamerRef, type EncounterRow, type ImageUrl, type StreamerRefRow } from "./native-model";
import { listPlatforms, platform, watchUrl, type RecordingRef } from "./platform-registry";
import { actionsRunUrl } from "./platform-ingestion-dispatch";
import { allowedModes, queue, queueability, requireDispatch, RESETTABLE, resolveInputs, workflow } from "./processing";
import { Twitch } from "./twitch";
import { safeObjectKey } from "./visibility";

const prefix = "/api/v1/ops";
const sqlNow = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const zero = {
  chunk: { pending: 0, queued: 0, processing: 0, completed: 0, failed: 0, archived: 0 } satisfies StatusCounts<ChunkStatus>,
  recording: { pending: 0, processing: 0, completed: 0, partial: 0, failed: 0 } satisfies StatusCounts<RecordingStatus>,
  ingestion: { pending: 0, waiting: 0, processing: 0, completed: 0, skipped: 0 } satisfies StatusCounts<IngestionJobStatus>,
};
const ingestionKinds: Record<IngestionJobKind, true> = { account: true, video: true, discovery: true };

function counts<S extends string>(base: StatusCounts<S>, found: Iterable<{ status: string; n: number }>): StatusCounts<S> {
  const result = { ...base };
  for (const { status, n } of found) result[status as S] = n;
  return result;
}
function enumValue<S extends string>(base: Record<S, unknown>, value: string, label: string): S {
  requireValue(Object.hasOwn(base, value), `Invalid ${label}`);
  return value as S;
}
function positiveId(value: string, label: string) {
  requireValue(/^[1-9]\d{0,15}$/.test(value), `Invalid ${label}`);
  return Number(value);
}
function textFilter(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  requireValue(q.length <= 128, "Search must be at most 128 characters");
  return q;
}

export async function requireOperator(req: Request, env: AuthEnv): Promise<Identity> {
  const identity = await authenticated(req, env);
  if (!(await one(env, "SELECT 1 FROM operators WHERE user_id=?", identity.userId)))
    throw new HttpError(403, "Operator access required");
  return identity;
}

interface ChunkRow {
  id: string;
  vod_id: number;
  chunk_index: number;
  start_seconds: number;
  end_seconds: number;
  status: ChunkStatus;
  attempt_count: number;
  last_error: string | null;
  quality: string | null;
  frames_processed: number | null;
  detections_count: number | null;
  processing_duration_ms: number | null;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  lease_expires_at: string | null;
  updated_at: string;
}
const chunkColumns = `id,vod_id,chunk_index,start_seconds,end_seconds,status,attempt_count,last_error,quality,frames_processed,
  detections_count,processing_duration_ms,queued_at,started_at,completed_at,lease_expires_at,coalesce(updated_at,created_at) AS updated_at`;
function toOpsChunk(row: ChunkRow): OpsChunk {
  return {
    id: row.id,
    recordingId: row.vod_id,
    index: row.chunk_index,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    status: row.status,
    attempts: row.attempt_count,
    lastError: row.last_error,
    quality: row.quality,
    framesProcessed: row.frames_processed,
    detections: row.detections_count,
    durationMs: row.processing_duration_ms,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseExpiresAt: row.lease_expires_at,
    updatedAt: row.updated_at,
  };
}

interface ChannelRow {
  channel_id: string;
  channel_platform: string;
  channel_source_id: string;
  channel_name: string | null;
}
function toOpsChannel(row: ChannelRow): OpsChannelRef {
  return { id: row.channel_id, platform: row.channel_platform, sourceId: row.channel_source_id, displayName: row.channel_name };
}

interface WatchRow {
  platform: string;
  source_id: string;
  source_video_id: string;
  source_part_id: string | null;
  source_part_index: number | null;
}
function watchRef(row: WatchRow): RecordingRef {
  return { sourceId: row.source_id, videoId: row.source_video_id, partId: row.source_part_id, partIndex: row.source_part_index };
}
const watchColumns = `v.source AS platform,v.source_id,coalesce(v.source_video_id,v.source_id) AS source_video_id,v.source_part_id,v.source_part_index`;

interface RecordingRow extends WatchRow, ChannelRow {
  id: number;
  title: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  status: RecordingStatus;
  availability: OpsRecording["availability"];
  ready_for_processing: number;
  processing_enabled: number;
  template_version: OpsRecording["templateVersion"];
  bazaar_chapters: string;
  profile_id: number | null;
  profile_name: string | null;
  streamer_id: number | null;
  streamer_name: string | null;
  streamer_avatar: string | null;
  chunk_counts: string;
  detection_count: number;
  last_activity_at: string;
}
const lastActivity = "coalesce((SELECT max(c.updated_at) FROM chunks c WHERE c.vod_id=v.id),v.updated_at,v.created_at,'')";
function toOpsRecording(row: RecordingRow): OpsRecording {
  const chunkCounts: Record<string, number> = JSON.parse(row.chunk_counts);
  return {
    id: row.id,
    platform: row.platform,
    sourceId: row.source_id,
    url: watchUrl(row.platform, watchRef(row)),
    title: row.title,
    durationSeconds: row.duration_seconds,
    publishedAt: row.published_at,
    status: row.status,
    availability: row.availability,
    readyForProcessing: !!row.ready_for_processing,
    processingEnabled: !!row.processing_enabled,
    templateVersion: row.template_version,
    profile: row.profile_id === null ? null : { id: row.profile_id, name: row.profile_name! },
    bazaarChapters: JSON.parse(row.bazaar_chapters),
    channel: row.channel_id === null ? null : toOpsChannel(row),
    streamer: row.streamer_id === null ? null : streamerRef({ id: row.streamer_id, display_name: row.streamer_name!, avatar_url: row.streamer_avatar }),
    chunkCounts: counts(zero.chunk, Object.entries(chunkCounts).map(([status, n]) => ({ status, n }))),
    detections: row.detection_count,
    lastActivityAt: row.last_activity_at,
  };
}
/** Recordings by ID, in the order given; unknown IDs are skipped. */
async function recordings(env: Env, ids: number[]): Promise<OpsRecording[]> {
  if (!ids.length) return [];
  const found = await rows<RecordingRow>(
    env,
    `SELECT v.id,${watchColumns},v.title,v.duration_seconds,v.published_at,v.status,v.availability,v.ready_for_processing,
      v.processing_enabled,v.template_version,v.bazaar_chapters,p.id AS profile_id,p.profile_name,
      a.id AS channel_id,a.source AS channel_platform,a.source_id AS channel_source_id,a.display_name AS channel_name,
      i.id AS streamer_id,i.display_name AS streamer_name,i.avatar_url AS streamer_avatar,
      (SELECT json_group_object(status,n) FROM (SELECT status,count(*) AS n FROM chunks WHERE vod_id=v.id GROUP BY status)) AS chunk_counts,
      (SELECT count(*) FROM detections WHERE vod_id=v.id) AS detection_count,${lastActivity} AS last_activity_at
    FROM vod_processing_context v
    LEFT JOIN platform_accounts a ON a.id=v.platform_account_id
    LEFT JOIN channel_ownership o ON o.channel_id=a.id AND o.ended_at IS NULL
    LEFT JOIN streamer_identities i ON i.id=o.streamer_id
    LEFT JOIN sfde_profiles p ON p.id=v.effective_profile_id
    WHERE v.id IN(SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  );
  const byId = new Map(found.map((row) => [row.id, toOpsRecording(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}
async function recording(env: Env, id: number) {
  const [found] = await recordings(env, [id]);
  if (!found) throw new HttpError(404, "Recording not found");
  return found;
}

/** Corrections apply only while the detection's raw inputs are unchanged, as in the public_sources view. */
const detectionFrom = `FROM detections d
  LEFT JOIN igd_corrections c ON c.detection_id=d.id AND c.raw_igd IS d.igd AND c.raw_field_evidence=d.field_evidence AND c.raw_publish_body IS d.publish_body
  LEFT JOIN matchup_anchors x ON x.current_detection_id=d.id`;
const detectionRowColumns = `d.id AS detection_id,d.chunk_id,d.vod_id,d.frame_time_seconds AS at,d.username,d.name_state,d.rank,
  CASE WHEN c.id IS NOT NULL THEN c.igd ELSE d.igd END AS igd,d.wins_remaining,d.ghost_hero,d.streamer_hero,x.matchup_id`;
type DetectionRow = Pick<EncounterRow, "detection_id" | "vod_id" | "at" | "username" | "name_state" | "rank" | "igd" | "wins_remaining" | "ghost_hero" | "streamer_hero"> & {
  chunk_id: string;
  matchup_id: number | null;
};
function toOpsDetectionRow(row: DetectionRow): OpsDetectionRow {
  return {
    id: row.detection_id,
    chunkId: row.chunk_id,
    at: row.at,
    username: row.username,
    nameState: row.name_state,
    rank: row.rank,
    igd: row.igd,
    winsRemaining: row.wins_remaining,
    ghostHero: row.ghost_hero,
    streamerHero: row.streamer_hero,
    matchupId: row.matchup_id,
  };
}
function detectionRows(env: Env, column: "d.vod_id" | "d.chunk_id", value: string | number) {
  return rows<DetectionRow>(env, `SELECT ${detectionRowColumns} ${detectionFrom} WHERE ${column}=? ORDER BY d.frame_time_seconds,d.id`, value);
}
/** Every image an operator sees, hidden and debug frames included, streams through the private image route. */
const opsImage: ImageUrl = (path) => (path ? `${prefix}/images/${objectPath(path)}` : null);
type DetectionDetailRow = DetectionRow & EncounterRow & WatchRow & {
  truncated: number;
  no_right_edge: number;
  anchor_seconds: number | null;
};
function toOpsDetection(row: DetectionDetailRow): OpsDetection {
  const encounter = projectEncounter([row], opsImage);
  return {
    ...toOpsDetectionRow(row),
    recordingId: row.vod_id,
    confidence: row.confidence,
    encounterConfidence: row.encounter_confidence,
    lethal: row.lethal === null ? null : !!row.lethal,
    gameMode: row.game_mode ?? null,
    tournamentWins: row.tournament_wins ?? null,
    tournamentLosses: row.tournament_losses ?? null,
    truncated: !!row.truncated,
    noRightEdge: !!row.no_right_edge,
    screenshotUrl: opsImage(row.storage_path, row),
    fieldEvidence: encounter.fieldEvidence,
    igdCorrection: encounter.igdCorrection,
    sourceUrlAt: watchUrl(row.platform, watchRef(row), row.anchor_seconds ?? row.at),
  };
}
async function detection(env: Env, id: string): Promise<OpsDetection> {
  const row = await one<DetectionDetailRow>(
    env,
    `SELECT ${detectionRowColumns},d.confidence,d.encounter_confidence,d.lethal,d.game_mode,d.tournament_wins,d.tournament_losses,
      d.truncated,d.no_right_edge,d.storage_path,d.field_evidence,d.created_at AS indexed_at,1 AS available,d.igd AS raw_igd,
      c.id AS igd_correction_id,c.evidence AS igd_correction_evidence,c.source_refs AS igd_correction_source_refs,
      c.input_digest AS igd_correction_input_digest,c.reason AS igd_correction_reason,c.created_at AS igd_correction_created_at,
      x.anchor_seconds,${watchColumns}
    ${detectionFrom} JOIN vods v ON v.id=d.vod_id WHERE d.id=?`,
    id,
  );
  if (!row) throw new HttpError(404, "Detection not found");
  return toOpsDetection(row);
}

/** Each attention group selects id, recording_id, label, error and at (ISO) for its rows; target names what its id addresses. */
const chunkAttention = (where: string, at: string) => `SELECT c.id,c.vod_id AS recording_id,
  v.source||' '||v.source_id||' chunk '||c.chunk_index AS label,c.last_error AS error,${at} AS at
  FROM chunks c JOIN vods v ON v.id=c.vod_id WHERE ${where}`;
const attentionGroups: Record<OpsAttentionKind, { sql: string; target: OpsAttentionTarget["kind"] }> = {
  exhausted_chunk: { target: "chunk", sql: chunkAttention("c.status='failed' AND c.attempt_count>=c.max_attempts", "c.updated_at") },
  expired_lease: { target: "chunk", sql: chunkAttention(`c.status='processing' AND c.lease_expires_at<${sqlNow}`, "c.lease_expires_at") },
  stale_queued: { target: "chunk", sql: chunkAttention("c.status='queued' AND c.queued_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')", "c.queued_at") },
  failing_ingestion: { target: "ingestion_job", sql: `SELECT j.id,NULL AS recording_id,j.source||' '||j.kind||' '||j.source_id AS label,j.last_error AS error,
    coalesce(j.last_attempt_at,j.created_at) AS at FROM platform_ingestion_jobs j
    WHERE j.status IN('pending','waiting') AND j.attempts>=3 AND j.last_error IS NOT NULL` },
  catalog_failed: { target: "streamer", sql: `SELECT CAST(w.streamer_id AS TEXT) AS id,NULL AS recording_id,coalesce(s.display_name,s.login,CAST(w.streamer_id AS TEXT)) AS label,
    w.last_error AS error,strftime('%Y-%m-%dT%H:%M:%fZ',w.updated_at/1000.0,'unixepoch') AS at
    FROM twitch_catalog_work w LEFT JOIN streamers s ON s.id=w.streamer_id WHERE w.state='failed'` },
  dispatch_unconfirmed: { target: "dispatch", sql: `SELECT CAST(d.id AS TEXT) AS id,NULL AS recording_id,coalesce('run '||d.run_id,'ticket '||d.ticket_id) AS label,
    d.outcome AS error,coalesce(d.finished_at,d.last_attempt_at) AS at
    FROM platform_ingestion_dispatch d WHERE d.outcome IN('delivery_unconfirmed','failure')` },
};
async function attentionGroup(env: Env, kind: OpsAttentionKind): Promise<OpsAttention> {
  const group = attentionGroups[kind];
  const found = await rows<{ id: string; recording_id: number | null; label: string; error: string | null; at: string | null; total: number }>(
    env,
    `SELECT *,count(*) OVER () AS total FROM (${group.sql}) ORDER BY at DESC LIMIT 5`,
  );
  return {
    kind,
    count: found[0]?.total ?? 0,
    samples: found.map((row) => ({
      id: row.id,
      recordingId: row.recording_id,
      label: row.label,
      error: row.error,
      at: row.at,
      target: { kind: group.target, id: row.id },
    })),
  };
}
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function seconds(from: string | null, to: string | null) {
  const value = (Date.parse(to ?? "") - Date.parse(from ?? "")) / 1000;
  return Number.isFinite(value) && value >= 0 ? [value] : [];
}
async function overview(env: Env, url: URL): Promise<OpsRoutes["/overview"]> {
  parameters(url, []);
  const hour = 3_600_000, first = Math.floor(Date.now() / hour) * hour - 23 * hour, since = new Date(first).toISOString();
  type Count = { status: string; n: number };
  const [chunks, vods, jobs, attention, completed, failed, timed] = await Promise.all([
    rows<Count>(env, "SELECT status,count(*) AS n FROM chunks GROUP BY status"),
    rows<Count>(env, "SELECT status,count(*) AS n FROM vods GROUP BY status"),
    rows<Count>(env, "SELECT status,count(*) AS n FROM platform_ingestion_jobs GROUP BY status"),
    Promise.all((Object.keys(attentionGroups) as OpsAttentionKind[]).map((kind) => attentionGroup(env, kind))),
    rows<{ hour: string; n: number }>(env, `SELECT strftime('%Y-%m-%dT%H:00:00.000Z',completed_at) AS hour,count(*) AS n FROM chunks
      WHERE status='completed' AND completed_at>=? GROUP BY hour`, since),
    rows<{ hour: string; n: number }>(env, `SELECT strftime('%Y-%m-%dT%H:00:00.000Z',updated_at) AS hour,count(*) AS n FROM chunks
      WHERE status='failed' AND updated_at>=? GROUP BY hour`, since),
    rows<{ queued_at: string | null; started_at: string | null; completed_at: string }>(env, `SELECT queued_at,started_at,completed_at FROM chunks
      WHERE status='completed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 200`),
  ]);
  const byHour = (found: { hour: string; n: number }[]) => new Map(found.map((row) => [row.hour, row.n]));
  const done = byHour(completed), broke = byHour(failed);
  return {
    generatedAt: new Date().toISOString(),
    chunks: counts(zero.chunk, chunks),
    recordings: counts(zero.recording, vods),
    ingestion: counts(zero.ingestion, jobs),
    attention,
    throughput: Array.from({ length: 24 }, (_, index) => {
      const key = new Date(first + index * hour).toISOString();
      return { hour: key, completed: done.get(key) ?? 0, failed: broke.get(key) ?? 0 };
    }),
    timings: {
      queueToClaimSeconds: median(timed.flatMap((row) => seconds(row.queued_at, row.started_at))),
      claimToDoneSeconds: median(timed.flatMap((row) => seconds(row.started_at, row.completed_at))),
    },
  };
}

async function listRecordings(env: Env, url: URL): Promise<Page<OpsRecording>> {
  const limit = parameters(url, ["status", "chunkStatus", "platform", "q", "streamerId", "cursor", "limit"]);
  const clauses = ["1"], args: unknown[] = [];
  const status = url.searchParams.get("status"), chunkStatus = url.searchParams.get("chunkStatus"), source = url.searchParams.get("platform");
  const streamer = url.searchParams.get("streamerId"), q = textFilter(url);
  if (status === "attention")
    clauses.push(`EXISTS(SELECT 1 FROM chunks c WHERE c.vod_id=v.id AND (c.status='failed' OR (c.status='processing' AND c.lease_expires_at<${sqlNow})))`);
  else if (status !== null) (clauses.push("v.status=?"), args.push(enumValue(zero.recording, status, "status")));
  if (chunkStatus !== null)
    (clauses.push("EXISTS(SELECT 1 FROM chunks c WHERE c.vod_id=v.id AND c.status=?)"), args.push(enumValue(zero.chunk, chunkStatus, "chunkStatus")));
  if (source !== null) (clauses.push("v.source=?"), args.push(platform(source).id));
  if (q) (clauses.push("(instr(lower(coalesce(v.title,'')),?)>0 OR instr(lower(v.source_id),?)>0)"), args.push(q, q));
  if (streamer !== null)
    (clauses.push("EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=v.platform_account_id AND o.ended_at IS NULL AND o.streamer_id=?)"),
      args.push(positiveId(streamer, "streamerId")));
  const after = await keysetAfter(env, url);
  const found = await rows<{ id: number; last_activity_at: string }>(
    env,
    `SELECT * FROM (SELECT v.id,${lastActivity} AS last_activity_at FROM vods v WHERE ${clauses.join(" AND ")})
    ${after.length ? "WHERE (last_activity_at,id)<(?,?)" : ""} ORDER BY last_activity_at DESC,id DESC LIMIT ?`,
    ...args,
    ...after,
    limit + 1,
  );
  const page = await keysetPage(env, url, found, limit, (row) => [row.last_activity_at, row.id]);
  return { ...page, items: await recordings(env, page.items.map((row) => row.id)) };
}
interface RunRow {
  id: string;
  chunk_id: string;
  origin: OpsRun["origin"];
  requested_by: string | null;
  inputs: string | null;
  status: OpsRun["status"];
  queued_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  github_run_id: number | null;
  github_run_attempt: number | null;
  error: string | null;
  frames_processed: number | null;
  detections_count: number | null;
}
function toOpsRun(row: RunRow): OpsRun {
  return {
    id: row.id,
    chunkId: row.chunk_id,
    origin: row.origin,
    requestedBy: row.requested_by,
    inputs: row.inputs === null ? null : JSON.parse(row.inputs),
    status: row.status,
    queuedAt: row.queued_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    githubRunUrl: row.github_run_id === null ? null : actionsRunUrl(row.github_run_id, row.github_run_attempt),
    error: row.error,
    framesProcessed: row.frames_processed,
    detections: row.detections_count,
  };
}
async function runs(env: Env, column: "vod_id" | "chunk_id", value: string | number) {
  const found = await rows<RunRow>(env, `SELECT * FROM chunk_runs WHERE ${column}=? ORDER BY queued_at DESC,id DESC LIMIT 50`, value);
  return found.map(toOpsRun);
}
async function recordingDetail(env: Env, url: URL, id: number): Promise<OpsRoutes["/recordings/:id"]> {
  parameters(url, []);
  const [found, chunks, detections, history] = await Promise.all([
    recording(env, id),
    rows<ChunkRow>(env, `SELECT ${chunkColumns} FROM chunks WHERE vod_id=? ORDER BY chunk_index`, id),
    detectionRows(env, "d.vod_id", id),
    runs(env, "vod_id", id),
  ]);
  return { recording: found, chunks: chunks.map(toOpsChunk), detections: detections.map(toOpsDetectionRow), runs: history };
}
async function chunkDetail(env: Env, url: URL, id: string): Promise<OpsRoutes["/chunks/:id"]> {
  parameters(url, []);
  const chunk = await one<ChunkRow>(env, `SELECT ${chunkColumns} FROM chunks WHERE id=?`, id);
  if (!chunk) throw new HttpError(404, "Chunk not found");
  const [found, detections, history] = await Promise.all([recording(env, chunk.vod_id), detectionRows(env, "d.chunk_id", id), runs(env, "chunk_id", id)]);
  const latest = history.find((run) => run.inputs)?.inputs;
  return {
    chunk: toOpsChunk(chunk),
    recording: found,
    detections: detections.map(toOpsDetectionRow),
    runs: history,
    runDefaults: { inputs: resolveInputs(env, latest ? { mode: latest.mode, quality: latest.quality } : {}), allowedModes: allowedModes(env) },
  };
}

const REPROCESS_LIMIT = 50;
async function reprocessRecording(env: Env, identity: Identity, vodId: number, ids: string[], inputs: RunInputs, dryRun: boolean): Promise<OpsReprocessRecording> {
  const refused = (error: HttpError) => ({
    recordingId: vodId, chunkIds: [], runIds: [], payload: null, skipped: ids.map((chunkId) => ({ chunkId, reason: error.message })), error: error.message, status: error.status,
  });
  try {
    const flow = await workflow(env, vodId, inputs);
    if (dryRun) {
      const reasons = await queueability(env, flow, ids);
      const queueable = reasons.filter((row) => row.reason === null).map((row) => row.chunk_id);
      return {
        recordingId: vodId,
        chunkIds: queueable,
        runIds: [],
        payload: queueable.length ? flow.payload(queueable, null) : null,
        skipped: reasons.flatMap((row) => (row.reason === null ? [] : [{ chunkId: row.chunk_id, reason: row.reason }])),
      };
    }
    const queued = await queue(env, flow, ids, { origin: "operator", requestedBy: identity.userId });
    const missed = ids.filter((id) => !queued.chunkIds.includes(id));
    const reasons = missed.length ? await queueability(env, flow, missed) : [];
    return { recordingId: vodId, ...queued, skipped: reasons.map((row) => ({ chunkId: row.chunk_id, reason: row.reason ?? "Chunk changed while queueing" })) };
  } catch (error) {
    if (error instanceof HttpError) return refused(error);
    throw error;
  }
}
async function reprocess(req: Request, env: AuthEnv, identity: Identity): Promise<Response> {
  await requireCsrf(req, env, identity);
  const data = await jsonBody(req);
  only(data, ["chunk_ids", "inputs", "dry_run"]);
  requireValue(Array.isArray(data.chunk_ids) && data.chunk_ids.length >= 1 && data.chunk_ids.length <= REPROCESS_LIMIT,
    `chunk_ids must list 1 to ${REPROCESS_LIMIT} chunks`);
  requireValue(data.dry_run === undefined || typeof data.dry_run === "boolean", "Invalid dry_run");
  const dryRun = data.dry_run === true;
  const ids = [...new Set(data.chunk_ids.map((id) => uuid(id).toLowerCase()))];
  const inputs = resolveInputs(env, data.inputs ?? {});
  if (!dryRun) requireDispatch(env);
  const found = await rows<{ id: string; vod_id: number; status: ChunkStatus }>(
    env,
    "SELECT id,vod_id,status FROM chunks WHERE id IN(SELECT value FROM json_each(?))",
    JSON.stringify(ids),
  );
  const byId = new Map(found.map((chunk) => [chunk.id, chunk]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new HttpError(404, `Unknown chunks: ${missing.join(",")}`);
  const busy = found.filter((chunk) => !RESETTABLE.includes(chunk.status));
  if (busy.length) throw new HttpError(409, `Chunks cannot be reprocessed: ${busy.map((chunk) => `${chunk.id} is ${chunk.status}`).join(", ")}`);
  const groups = new Map<number, string[]>();
  for (const chunk of ids.map((id) => byId.get(id)!)) groups.set(chunk.vod_id, [...(groups.get(chunk.vod_id) ?? []), chunk.id]);
  const recordings: Array<OpsReprocessRecording & { status?: number }> = [];
  for (const [vodId, chunkIds] of groups) recordings.push(await reprocessRecording(env, identity, vodId, chunkIds, inputs, dryRun));
  const body: OpsReprocessResponse = { dispatched: !dryRun, recordings: recordings.map(({ status: _, ...recording }) => recording) };
  if (recordings.some((recording) => recording.chunkIds.length)) return Response.json(body);
  const status = recordings.some((recording) => recording.status === 502) ? 502 : 409;
  return Response.json({ ...body, error: dryRun ? "No chunk would queue" : "No chunk was queued" }, { status });
}

async function ownedChannels(env: Env, streamerIds: number[]) {
  const found = await rows<ChannelRow & { streamer_id: number }>(
    env,
    `SELECT o.streamer_id,a.id AS channel_id,a.source AS channel_platform,a.source_id AS channel_source_id,a.display_name AS channel_name
    FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id
    WHERE o.ended_at IS NULL AND o.streamer_id IN(SELECT value FROM json_each(?)) ORDER BY a.source,a.display_name,a.id`,
    JSON.stringify(streamerIds),
  );
  const by = new Map<number, OpsChannelRef[]>();
  for (const row of found) by.set(row.streamer_id, [...(by.get(row.streamer_id) ?? []), toOpsChannel(row)]);
  return by;
}
async function listStreamers(env: Env, url: URL): Promise<Page<OpsStreamer>> {
  const limit = parameters(url, ["q", "cursor", "limit"]), q = textFilter(url), after = await keysetAfter(env, url);
  const found = await rows<StreamerRefRow & { sort_name: string }>(
    env,
    `SELECT * FROM (SELECT i.id,i.display_name,i.avatar_url,lower(i.display_name) AS sort_name FROM streamer_identities i
      ${q ? "WHERE instr(lower(i.display_name),?)>0" : ""})
    ${after.length ? "WHERE (sort_name,id)>(?,?)" : ""} ORDER BY sort_name,id LIMIT ?`,
    ...(q ? [q] : []),
    ...after,
    limit + 1,
  );
  const page = await keysetPage(env, url, found, limit, (row) => [row.sort_name, row.id]);
  const ids = page.items.map((row) => row.id);
  const [channels, statuses] = await Promise.all([
    ownedChannels(env, ids),
    rows<{ streamer_id: number; status: string; n: number }>(
      env,
      `SELECT o.streamer_id,v.status,count(*) AS n FROM channel_ownership o JOIN vods v ON v.platform_account_id=o.channel_id
      WHERE o.ended_at IS NULL AND o.streamer_id IN(SELECT value FROM json_each(?)) GROUP BY o.streamer_id,v.status`,
      JSON.stringify(ids),
    ),
  ]);
  return {
    ...page,
    items: page.items.map((row) => {
      const recordingCounts = counts(zero.recording, statuses.filter((s) => s.streamer_id === row.id));
      return {
        ...streamerRef(row),
        channels: channels.get(row.id) ?? [],
        recordings: Object.values(recordingCounts).reduce((sum, n) => sum + n, 0),
        recordingCounts,
      };
    }),
  };
}

interface Listed {
  videoId: string;
  title: string | null;
  url: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  job: { status: IngestionJobStatus; reason: string | null } | null;
}
const INVENTORY_CAP = 200;
const jobReason = "coalesce(json_extract(j.state,'$.reason'),json_extract(j.state,'$.archive_state'),j.last_error)";
const jobInventory: Record<IngestionJobStatus, InventoryState> = {
  pending: "waiting", waiting: "waiting", processing: "waiting", completed: "cataloged", skipped: "skipped",
};
const recordingInventory: Record<RecordingStatus, InventoryState> = {
  pending: "cataloged", processing: "processing", partial: "partial", completed: "processed", failed: "failed",
};
function inventoryState(job: Listed["job"], found: OpsRecording | null): InventoryState {
  if (found) return Object.values(found.chunkCounts).some((n) => n > 0) ? recordingInventory[found.status] : "cataloged";
  return job ? jobInventory[job.status] : "not_seen";
}
function helixDuration(value: unknown) {
  const match = typeof value === "string" ? /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value) : null;
  return match && value ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null;
}
async function twitchArchives(twitch: Twitch, channel: OpsChannelRef): Promise<Listed[]> {
  const page = await twitch.helix("videos", { user_id: channel.sourceId, type: "archive", first: "100" });
  if (!Array.isArray(page?.data)) throw new Error("Invalid Twitch video listing");
  return page.data.flatMap((video: Record<string, unknown>): Listed[] => {
    if (typeof video.id !== "string") return [];
    const published = [video.published_at, video.created_at].find((value): value is string => typeof value === "string") ?? null;
    return [{
      videoId: video.id,
      title: typeof video.title === "string" ? video.title : null,
      url: watchUrl("twitch", { sourceId: video.id }),
      publishedAt: published,
      durationSeconds: helixDuration(video.duration),
      job: null,
    }];
  });
}
async function ingestionVideos(env: Env, channel: OpsChannelRef): Promise<Listed[]> {
  const found = await rows<{ source_id: string; status: IngestionJobStatus; reason: string | null }>(
    env,
    `SELECT j.source_id,j.status,${jobReason} AS reason FROM platform_ingestion_jobs j
    WHERE j.kind='video' AND j.account_id=? ORDER BY j.created_at DESC LIMIT ?`,
    channel.id,
    INVENTORY_CAP,
  );
  return found.map((row) => ({
    videoId: row.source_id,
    title: null,
    url: watchUrl(channel.platform, { sourceId: row.source_id, videoId: row.source_id, partIndex: 1 }),
    publishedAt: null,
    durationSeconds: null,
    job: { status: row.status, reason: row.reason },
  }));
}
async function channelInventory(env: Env, twitch: Twitch, channel: OpsChannelRef): Promise<InventoryChannel> {
  const own = await rows<{ id: number; video_id: string }>(
    env,
    "SELECT id,coalesce(source_video_id,source_id) AS video_id FROM vods WHERE platform_account_id=? ORDER BY published_at DESC,id DESC LIMIT ?",
    channel.id,
    INVENTORY_CAP,
  );
  const live = channel.platform === "twitch";
  let origin: InventoryChannel["origin"] = live ? "live" : "jobs", error: string | null = null, listed: Listed[] = [];
  try {
    listed = live ? await twitchArchives(twitch, channel) : await ingestionVideos(env, channel);
  } catch (failure) {
    origin = "error";
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const ours = await recordings(env, own.map((row) => row.id));
  const videoOf = new Map(own.map((row) => [row.id, row.video_id]));
  const item = (video: Listed | null, found: OpsRecording | null): InventoryItem => ({
    sourceId: found?.sourceId ?? video!.videoId,
    title: found?.title ?? video?.title ?? null,
    url: found?.url ?? video!.url,
    publishedAt: found?.publishedAt ?? video?.publishedAt ?? null,
    durationSeconds: found?.durationSeconds ?? video?.durationSeconds ?? null,
    state: inventoryState(video?.job ?? null, found),
    reason: video?.job?.reason ?? null,
    recordingId: found?.id ?? null,
    chunkCounts: found?.chunkCounts ?? null,
    availability: found?.availability ?? null,
  });
  const matched = new Set<number>();
  const items = listed.flatMap((video) => {
    const parts = ours.filter((found) => videoOf.get(found.id) === video.videoId);
    parts.forEach((found) => matched.add(found.id));
    return parts.length ? parts.map((found) => item(video, found)) : [item(video, null)];
  });
  items.push(...ours.filter((found) => !matched.has(found.id)).map((found) => item(null, found)));
  items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return { channel, origin, error, items: items.slice(0, INVENTORY_CAP) };
}
async function inventory(env: Env, url: URL, id: number): Promise<OpsRoutes["/streamers/:id/inventory"]> {
  parameters(url, []);
  const streamer = await one<StreamerRefRow>(env, "SELECT id,display_name,avatar_url FROM streamer_identities WHERE id=?", id);
  if (!streamer) throw new HttpError(404, "Streamer not found");
  const twitch = new Twitch(env), channels = (await ownedChannels(env, [id])).get(id) ?? [];
  return { streamer: streamerRef(streamer), channels: await Promise.all(channels.map((channel) => channelInventory(env, twitch, channel))) };
}

interface JobRow {
  id: string;
  source: string;
  kind: IngestionJobKind;
  source_id: string;
  account_id: string | null;
  status: IngestionJobStatus;
  attempts: number;
  last_error: string | null;
  reason: string | null;
  next_attempt_at: string;
  last_attempt_at: string | null;
  completed_at: string | null;
  created_at: string;
  activity: string;
}
function toOpsIngestionJob(row: JobRow): OpsIngestionJob {
  return {
    id: row.id,
    platform: row.source,
    kind: row.kind,
    sourceId: row.source_id,
    accountId: row.account_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    reason: row.reason,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}
type Dispatch = NonNullable<OpsIngestion["dispatch"]>;
async function ingestion(env: Env, url: URL): Promise<OpsIngestion> {
  const limit = parameters(url, ["platform", "kind", "status", "cursor", "limit"]);
  const clauses = ["1"], args: unknown[] = [];
  const source = url.searchParams.get("platform"), kind = url.searchParams.get("kind"), status = url.searchParams.get("status");
  if (source !== null) (clauses.push("j.source=?"), args.push(platform(source).id));
  if (kind !== null) (clauses.push("j.kind=?"), args.push(enumValue(ingestionKinds, kind, "kind")));
  if (status !== null) (clauses.push("j.status=?"), args.push(enumValue(zero.ingestion, status, "status")));
  const after = await keysetAfter(env, url);
  const [settings, dispatch, catalog, jobs] = await Promise.all([
    rows<{ source: string; ingestion_enabled: number; discovery_enabled: number; processing_enabled: number; notifications_enabled: number }>(
      env,
      "SELECT source,ingestion_enabled,discovery_enabled,processing_enabled,notifications_enabled FROM platform_settings",
    ),
    one<{ state: Dispatch["state"]; outcome: Dispatch["outcome"]; run_id: string | null; started_at: string | null; finished_at: string | null; delivery_failures: number }>(
      env,
      "SELECT state,outcome,run_id,started_at,finished_at,delivery_failures FROM platform_ingestion_dispatch WHERE id=1",
    ),
    rows<StreamerRefRow & { state: CatalogWorkState; attempt_count: number; last_error: string | null; due_at: number }>(
      env,
      `SELECT coalesce(i.id,w.streamer_id) AS id,coalesce(i.display_name,s.display_name,s.login,CAST(w.streamer_id AS TEXT)) AS display_name,
        coalesce(i.avatar_url,s.profile_image_url) AS avatar_url,w.state,w.attempt_count,w.last_error,w.due_at
      FROM twitch_catalog_work w LEFT JOIN streamers s ON s.id=w.streamer_id
      LEFT JOIN platform_accounts a ON a.source='twitch' AND a.source_id=CAST(w.streamer_id AS TEXT)
      LEFT JOIN channel_ownership o ON o.channel_id=a.id AND o.ended_at IS NULL
      LEFT JOIN streamer_identities i ON i.id=o.streamer_id
      ORDER BY w.state='idle',w.updated_at DESC,w.streamer_id LIMIT 100`,
    ),
    rows<JobRow>(
      env,
      `SELECT * FROM (SELECT j.id,j.source,j.kind,j.source_id,j.account_id,j.status,j.attempts,j.last_error,${jobReason} AS reason,
        j.next_attempt_at,j.last_attempt_at,j.completed_at,j.created_at,coalesce(j.last_attempt_at,j.created_at) AS activity
        FROM platform_ingestion_jobs j WHERE ${clauses.join(" AND ")})
      ${after.length ? "WHERE (activity,id)<(?,?)" : ""} ORDER BY activity DESC,id DESC LIMIT ?`,
      ...args,
      ...after,
      limit + 1,
    ),
  ]);
  const saved = new Map(settings.map((row) => [row.source, row]));
  const page = await keysetPage(env, url, jobs, limit, (row) => [row.activity, row.id]);
  return {
    platforms: listPlatforms().map(({ id }) => {
      const row = saved.get(id);
      return {
        platform: id,
        ingestionEnabled: row?.ingestion_enabled === 1,
        discoveryEnabled: row?.discovery_enabled === 1,
        processingEnabled: row?.processing_enabled === 1,
        notificationsEnabled: row?.notifications_enabled === 1,
      };
    }),
    dispatch: dispatch && {
      state: dispatch.state,
      outcome: dispatch.outcome,
      runUrl: dispatch.run_id ? actionsRunUrl(dispatch.run_id) : null,
      startedAt: dispatch.started_at,
      finishedAt: dispatch.finished_at,
      deliveryFailures: dispatch.delivery_failures,
    },
    catalog: catalog.map((row) => ({
      streamer: streamerRef(row),
      state: row.state,
      attempts: row.attempt_count,
      lastError: row.last_error,
      dueAt: new Date(row.due_at).toISOString(),
    })),
    jobs: { ...page, items: page.items.map(toOpsIngestionJob) },
  };
}

async function image(env: Env, url: URL, encoded: string) {
  parameters(url, []);
  let key: string;
  try {
    key = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, "Invalid image key");
  }
  requireValue(safeObjectKey(key), "Invalid image key");
  const object = await env.DETECTIONS.get(key);
  if (!object) throw new HttpError(404, "Image not found");
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ETag: object.httpEtag,
    },
  });
}

interface Context {
  env: AuthEnv;
  url: URL;
  id: string;
  identity: Identity;
}
const handlers: { [K in keyof OpsRoutes]: (context: Context) => Promise<OpsRoutes[K]> } = {
  "/me": async ({ url, identity }) => (parameters(url, []), { operator: true, userId: identity.userId }),
  "/overview": ({ env, url }) => overview(env, url),
  "/recordings": ({ env, url }) => listRecordings(env, url),
  "/recordings/:id": ({ env, url, id }) => recordingDetail(env, url, positiveId(id, "recording ID")),
  "/chunks/:id": ({ env, url, id }) => chunkDetail(env, url, uuid(id).toLowerCase()),
  "/detections/:id": ({ env, url, id }) => (parameters(url, []), detection(env, uuid(id).toLowerCase())),
  "/streamers": ({ env, url }) => listStreamers(env, url),
  "/streamers/:id/inventory": ({ env, url, id }) => inventory(env, url, positiveId(id, "streamer ID")),
  "/ingestion": ({ env, url }) => ingestion(env, url),
};
const routes = Object.entries(handlers).map(
  ([template, handler]) => [new RegExp(`^${template.replace(":id", "([^/]+)")}$`), handler as (context: Context) => Promise<unknown>] as const,
);

/** Operator routes under /api/v1/ops: reads, and the CSRF-checked reprocess write. Every response is private; only images may be cached, and only by the browser. */
export async function opsRoute(req: Request, env: AuthEnv): Promise<Response> {
  try {
    const url = new URL(req.url), path = url.pathname.slice(prefix.length);
    const identity = await requireOperator(req, env);
    if (path === "/reprocess") {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return privateResponse(await reprocess(req, env, identity));
    }
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    if (path.startsWith("/images/")) return await image(env, url, path.slice("/images/".length));
    for (const [pattern, handler] of routes) {
      const match = pattern.exec(path);
      if (match) return privateResponse(Response.json(await handler({ env, url, id: match[1] ?? "", identity })));
    }
    throw new HttpError(404, "Operator endpoint not found");
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(JSON.stringify({ event: "ops_api_failed", error: String(error) }));
    return privateResponse(Response.json({ error: error instanceof HttpError ? error.message : "Operator request failed" },
      { status: error instanceof HttpError ? error.status : 500 }));
  }
}

const USER_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** Who may use the operator console; routed behind the ADMIN_KEY check. */
export async function operatorsAdminRoute(req: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/admin/operators" && req.method === "GET")
    return Response.json(await rows(env, `SELECT o.user_id,u.name,o.granted_by,o.granted_at FROM operators o JOIN app_users u ON u.id=o.user_id
      ORDER BY o.granted_at,o.user_id`));
  const match = path.match(/^\/api\/admin\/operators\/([^/]+)$/);
  if (!match) throw new HttpError(404, "Unknown operators endpoint");
  const userId = decodeURIComponent(match[1]);
  requireValue(USER_ID.test(userId), "Invalid user ID");
  if (req.method === "PUT") {
    const data = (await readText(req.clone())).trim() ? await body(req) : {};
    only(data, ["granted_by"]);
    const grantedBy = data.granted_by ?? "admin";
    requireValue(typeof grantedBy === "string" && grantedBy.length >= 1 && grantedBy.length <= 200, "Invalid granted_by");
    await statement(env, "INSERT INTO operators(user_id,granted_by) SELECT id,? FROM app_users WHERE id=? ON CONFLICT(user_id) DO NOTHING", grantedBy, userId).run();
    const granted = await one(env, "SELECT user_id,granted_by,granted_at FROM operators WHERE user_id=?", userId);
    if (!granted) throw new HttpError(404, "User not found");
    return Response.json(granted);
  }
  if (req.method === "DELETE") {
    const removed = await statement(env, "DELETE FROM operators WHERE user_id=? RETURNING user_id", userId).all();
    return Response.json({ user_id: userId, revoked: removed.results.length > 0 });
  }
  throw new HttpError(405, "Method not allowed");
}
