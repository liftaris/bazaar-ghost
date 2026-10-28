// Operator console contract. Every route lives under /api/v1/ops and requires an operator session.
import type { EvidenceField, FieldEvidence, Hero, IgdCorrection, NameState, Page, PlatformId } from "./public-api";

export type ChunkStatus = "pending" | "queued" | "processing" | "completed" | "failed" | "archived";
export type RecordingStatus = "pending" | "processing" | "completed" | "partial" | "failed";
export type Availability = "available" | "unavailable" | "unknown" | "checking" | "expired";
export type IngestionJobStatus = "pending" | "waiting" | "processing" | "completed" | "skipped";
export type IngestionJobKind = "account" | "video" | "discovery";
export type CatalogWorkState = "idle" | "pending" | "queued" | "running" | "failed";

/** Counts keyed by every member of a status union; absent statuses are 0, never missing. */
export type StatusCounts<S extends string> = Record<S, number>;

export interface OpsMe {
  operator: true;
  userId: string;
}

export interface OpsChunk {
  id: string;
  recordingId: number;
  index: number;
  startSeconds: number;
  endSeconds: number;
  status: ChunkStatus;
  attempts: number;
  lastError: string | null;
  quality: string | null;
  framesProcessed: number | null;
  detections: number | null;
  durationMs: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
}

export interface OpsChannelRef {
  id: string;
  platform: PlatformId;
  sourceId: string;
  displayName: string | null;
}

export interface OpsStreamerRef {
  id: number;
  displayName: string;
  avatarUrl: string | null;
}

export interface OpsRecording {
  id: number;
  platform: PlatformId;
  sourceId: string;
  /** Watch URL on the source platform. */
  url: string;
  title: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  status: RecordingStatus;
  availability: Availability;
  readyForProcessing: boolean;
  processingEnabled: boolean;
  templateVersion: "auto" | "old" | "current";
  profile: { id: number; name: string } | null;
  /** Flat [start, end, start, end, ...] seconds, as stored. */
  bazaarChapters: number[];
  channel: OpsChannelRef | null;
  streamer: OpsStreamerRef | null;
  chunkCounts: StatusCounts<ChunkStatus>;
  detections: number;
  /** Latest chunk updated_at, or the recording's own updated time when it has no chunks. */
  lastActivityAt: string;
}

export interface OpsDetectionRow {
  id: string;
  chunkId: string;
  at: number;
  username: string | null;
  nameState: NameState;
  rank: string | null;
  igd: number | null;
  winsRemaining: number | null;
  ghostHero: Hero | null;
  streamerHero: Hero | null;
  matchupId: number | null;
}

/** "next" is the evidence-based processor and runs only in validation and local. */
export type ProcessorMode = "next" | "legacy";
/** Requested template height; a 60 suffix prefers the 60 FPS rendition. */
export type RunQuality = `${"360" | "480" | "720" | "1080"}p${"" | "60"}`;

/** What a chunk run was dispatched with. The saved profile and template era always come from the recording. */
export interface RunInputs {
  mode: ProcessorMode;
  /** The requested quality. Old-template recordings process at 480p whatever was requested. */
  quality: RunQuality;
  /** The digest-pinned SFDE image this deployment dispatched, or null when the workflow built the processor from the branch. Not an operator input. */
  runtime_image: string | null;
}
/** The inputs an operator chooses. */
export type OperatorRunInputs = Pick<RunInputs, "mode" | "quality">;

export type RunStatus = "queued" | "dispatch_failed" | "processing" | "completed" | "failed" | "expired";
/** "automatic" is the scheduler and platform sweep, "operator" the console, "manual" the admin key or a runner claim the backend did not dispatch. */
export type RunOrigin = "automatic" | "operator" | "manual";

export interface OpsRun {
  id: string;
  chunkId: string;
  origin: RunOrigin;
  /** Operator user ID; set only when origin is "operator". */
  requestedBy: string | null;
  /** null for a manual claim the backend did not dispatch. */
  inputs: RunInputs | null;
  status: RunStatus;
  queuedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  /** GitHub Actions run, reported by the runner when it prepares or claims the chunk. */
  githubRunUrl: string | null;
  error: string | null;
  framesProcessed: number | null;
  detections: number | null;
}

/** Inputs a new operator run of this chunk starts from, and the modes this environment allows. */
export interface OpsRunDefaults {
  inputs: RunInputs;
  allowedModes: ProcessorMode[];
}

export interface OpsRecordingDetail {
  recording: OpsRecording;
  chunks: OpsChunk[];
  detections: OpsDetectionRow[];
  /** Newest first, at most 50. */
  runs: OpsRun[];
}

export interface OpsChunkDetail {
  chunk: OpsChunk;
  recording: OpsRecording;
  detections: OpsDetectionRow[];
  /** Newest first, at most 50. */
  runs: OpsRun[];
  runDefaults: OpsRunDefaults;
}

/** POST /api/v1/ops/reprocess with the X-CSRF-Token header. */
export interface OpsReprocessRequest {
  /** 1 to 50 chunk IDs. Unknown IDs are a 404; queued, processing or archived chunks are a 409. */
  chunk_ids: string[];
  inputs?: Partial<OperatorRunInputs>;
  /** Report what would queue, and the payloads, without writing anything. */
  dry_run?: boolean;
}

/** The GitHub workflow_dispatch body. A dry run omits inputs.queued_at, which is assigned at dispatch. */
export interface OpsWorkflowPayload {
  ref: string;
  inputs: Record<string, string>;
}

/**
 * One recording's share of a reprocess request. An operator run gets one attempt: the chunk is not
 * retried automatically, and its attempt count keeps counting.
 */
export interface OpsReprocessRecording {
  recordingId: number;
  /** Chunks queued, or in a dry run the chunks that would queue. */
  chunkIds: string[];
  runIds: string[];
  /** null when no chunk queued. */
  payload: OpsWorkflowPayload | null;
  /** Requested chunks that did not (or would not) queue, with the reason. */
  skipped: Array<{ chunkId: string; reason: string }>;
  /** Set when the whole recording failed, for example when GitHub refused the dispatch. */
  error?: string;
}

/** 200 when any recording queued (or would queue); otherwise 502 if GitHub refused a dispatch, else 409, with the same body. */
export interface OpsReprocessResponse {
  dispatched: boolean;
  recordings: OpsReprocessRecording[];
  /** Set on 409 and 502. */
  error?: string;
}

export interface OpsDetection extends OpsDetectionRow {
  recordingId: number;
  confidence: number | null;
  encounterConfidence: number | null;
  lethal: boolean | null;
  gameMode: "normal" | "tournament" | null;
  tournamentWins: number | null;
  tournamentLosses: number | null;
  truncated: boolean;
  noRightEdge: boolean;
  /** Full-frame detection image through /api/v1/ops/images. */
  screenshotUrl: string | null;
  /** Every screenshotUrl inside points at /api/v1/ops/images, including hidden and debug frames. */
  fieldEvidence: Partial<Record<EvidenceField, FieldEvidence>>;
  igdCorrection: IgdCorrection | null;
  /** Source watch URL positioned at the detection's anchor time. */
  sourceUrlAt: string;
}

export type OpsAttentionKind =
  | "exhausted_chunk"
  | "expired_lease"
  | "stale_queued"
  | "failing_ingestion"
  | "catalog_failed"
  | "dispatch_unconfirmed";

/** What a sample links to. Streamer IDs are streamer identity IDs; the dispatch target is the ingestion dispatcher singleton. */
export interface OpsAttentionTarget {
  kind: "chunk" | "recording" | "streamer" | "ingestion_job" | "dispatch";
  id: string;
}

export interface OpsAttention {
  kind: OpsAttentionKind;
  count: number;
  /** Up to five examples, newest first. */
  samples: Array<{ id: string; recordingId: number | null; label: string; error: string | null; at: string | null; target: OpsAttentionTarget }>;
}

export interface OpsOverview {
  generatedAt: string;
  chunks: StatusCounts<ChunkStatus>;
  recordings: StatusCounts<RecordingStatus>;
  ingestion: StatusCounts<IngestionJobStatus>;
  attention: OpsAttention[];
  /** 24 hourly buckets, oldest first, hour as ISO start of hour. */
  throughput: Array<{ hour: string; completed: number; failed: number }>;
  /** Medians over the latest 200 completed chunks; null when none. */
  timings: { queueToClaimSeconds: number | null; claimToDoneSeconds: number | null };
}

export interface OpsStreamer extends OpsStreamerRef {
  channels: OpsChannelRef[];
  recordings: number;
  recordingCounts: StatusCounts<RecordingStatus>;
}

export type InventoryState =
  | "not_seen"
  | "skipped"
  | "waiting"
  | "cataloged"
  | "processing"
  | "partial"
  | "processed"
  | "failed";

export interface InventoryItem {
  sourceId: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  state: InventoryState;
  /** Skip or wait reason from ingestion state, or the provider error. */
  reason: string | null;
  recordingId: number | null;
  chunkCounts: StatusCounts<ChunkStatus> | null;
  availability: Availability | null;
}

export interface InventoryChannel {
  channel: OpsChannelRef;
  /** "live" = fetched from the platform now; "jobs" = from ingestion jobs; "error" = platform fetch failed. */
  origin: "live" | "jobs" | "error";
  error: string | null;
  items: InventoryItem[];
}

export interface OpsInventory {
  streamer: OpsStreamerRef;
  channels: InventoryChannel[];
}

export interface OpsIngestionJob {
  id: string;
  platform: PlatformId;
  kind: IngestionJobKind;
  sourceId: string;
  accountId: string | null;
  status: IngestionJobStatus;
  attempts: number;
  lastError: string | null;
  reason: string | null;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface OpsIngestion {
  platforms: Array<{
    platform: PlatformId;
    ingestionEnabled: boolean;
    discoveryEnabled: boolean;
    processingEnabled: boolean;
    notificationsEnabled: boolean;
  }>;
  dispatch: {
    state: "idle" | "queued" | "running";
    outcome: "accepted" | "delivery_unconfirmed" | "success" | "failure" | "cancelled" | null;
    runUrl: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    deliveryFailures: number;
  } | null;
  catalog: Array<{
    streamer: OpsStreamerRef;
    state: CatalogWorkState;
    attempts: number;
    lastError: string | null;
    dueAt: string;
  }>;
  jobs: Page<OpsIngestionJob>;
}

/** Query parameters accepted by each list route. Unknown parameters are a 400. */
export interface OpsQueries {
  /** q matches title or source ID; chunkStatus keeps recordings with at least one chunk in that status. */
  "/recordings": {
    status?: RecordingStatus | "attention";
    chunkStatus?: ChunkStatus;
    platform?: PlatformId;
    q?: string;
    streamerId?: number;
    cursor?: string;
    limit?: number;
  };
  "/streamers": { q?: string; cursor?: string; limit?: number };
  "/ingestion": { platform?: PlatformId; kind?: IngestionJobKind; status?: IngestionJobStatus; cursor?: string; limit?: number };
}

/** Path templates use ":id" for the trailing path segment. */
export interface OpsRoutes {
  "/me": OpsMe;
  "/overview": OpsOverview;
  "/recordings": Page<OpsRecording>;
  "/recordings/:id": OpsRecordingDetail;
  "/chunks/:id": OpsChunkDetail;
  "/detections/:id": OpsDetection;
  "/streamers": Page<OpsStreamer>;
  "/streamers/:id/inventory": OpsInventory;
  "/ingestion": OpsIngestion;
}

/** POST routes. Each requires the X-CSRF-Token header and a JSON body. */
export interface OpsMutations {
  "/reprocess": { request: OpsReprocessRequest; response: OpsReprocessResponse };
}
