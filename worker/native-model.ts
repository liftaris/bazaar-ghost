import { channelUrl, embedUrl, watchUrl } from "./platform-registry";
import type { FieldKey, FieldObservation, FieldObservations } from "./detections";
import { nameTier } from "./name-policy";
import type {
  Channel,
  Evidence,
  Encounter,
  EvidenceField,
  FieldEvidence,
  Hero,
  NameState,
  Matchup,
  MatchupDetail,
  MatchupResult,
  Recording,
  RecordingSource,
  Streamer,
  StreamerRef,
} from "../contracts/public-api";

/** Public Recording columns (view public_recordings), optionally with a Matchup count. */
export interface RecordingRow {
  id: number;
  platform: string;
  source_id: string;
  source_video_id: string;
  source_part_id: string | null;
  source_part_index: number | null;
  title: string | null;
  published_at: string | null;
  recorded_at: string | null;
  duration_seconds: number;
  availability: string;
  status: string;
  bazaar_chapters: string;
  session_id: string | null;
  streamer_mode: number;
  channel_id: string;
  channel_source_id: string;
  channel_name: string;
  channel_login: string | null;
  channel_avatar: string | null;
  channel_streamer_id: number | null;
  matchup_count?: number;
}
/** One public Source (view public_sources) joined with its Channel. */
export interface SourceRow {
  anchor_id: number;
  matchup_id: number;
  vod_id: number;
  at: number;
  detection_id: string;
  username: string | null;
  confidence: number | null;
  name_state: NameState;
  encounter_confidence: number | null;
  ghost_hero: Hero | null;
  streamer_hero: Hero | null;
  wins_remaining: number | null;
  lethal: number | null;
  game_mode?: "normal" | "tournament" | null;
  tournament_wins?: number | null;
  tournament_losses?: number | null;
  raw_igd?: number | null;
  igd_correction_id?: string | null;
  igd_correction_evidence?: string | null;
  igd_correction_source_refs?: string | null;
  igd_correction_input_digest?: string | null;
  igd_correction_reason?: string | null;
  igd_correction_created_at?: string | null;
  field_evidence: string;
  indexed_at: string;
  rank: string | null;
  igd: number | null;
  truncated: number;
  no_right_edge: number;
  storage_path: string | null;
  platform: string;
  source_id: string;
  source_video_id: string;
  source_part_id: string | null;
  source_part_index: number | null;
  title: string | null;
  published_at: string | null;
  recorded_at: string | null;
  available: number;
  is_reupload: number;
  channel_id: string;
  channel_source_id: string;
  channel_name: string;
  channel_login: string | null;
  channel_avatar: string | null;
  channel_streamer_id: number | null;
}
/** The detection columns an Encounter projection reads; any detection query can supply them. */
export type EncounterRow = Pick<SourceRow, "detection_id" | "vod_id" | "at" | "username" | "confidence" | "name_state"
  | "encounter_confidence" | "ghost_hero" | "streamer_hero" | "wins_remaining" | "lethal" | "game_mode" | "tournament_wins"
  | "tournament_losses" | "raw_igd" | "igd_correction_id" | "igd_correction_evidence" | "igd_correction_source_refs"
  | "igd_correction_input_digest" | "igd_correction_reason" | "igd_correction_created_at" | "field_evidence" | "indexed_at"
  | "rank" | "igd" | "storage_path" | "available">;
/** One row of the public_matchups view plus search relevance. */
export interface MatchupRow {
  matchup_id: number;
  username: string | null;
  confidence: number | null;
  name_state: NameState;
  rank: string | null;
  igd: number | null;
  recorded_timestamp: string | null;
  indexed_at: string;
  session_id: string | null;
  session_time: number | null;
  score: number;
  exact: number;
}
export interface StreamerRefRow {
  id: number;
  display_name: string;
  avatar_url: string | null;
}

export function streamerRef(row: StreamerRefRow): StreamerRef {
  return { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url };
}
/** Map a Channel from joined `channel_*` columns without exposing processing configuration. */
export function channel(
  row: { channel_id: string; channel_source_id: string; channel_name: string; channel_login: string | null; channel_avatar: string | null; channel_streamer_id: number | null },
  platform: string,
): Channel {
  return {
    id: row.channel_id,
    platform,
    sourceId: row.channel_source_id,
    displayName: row.channel_name,
    login: row.channel_login,
    avatarUrl: row.channel_avatar,
    url: channelUrl(platform, { sourceId: row.channel_source_id, login: row.channel_login }),
    streamerId: row.channel_streamer_id,
  };
}
/** `channels` are rows from worker/streamers.ts: id, platform, source_id, display_name, login, avatar_url. */
export function publicStreamer(row: StreamerRefRow, channels: Array<Record<string, any>>): Streamer {
  return {
    ...streamerRef(row),
    channels: channels.map((c) => ({
      id: c.id,
      platform: c.platform,
      sourceId: c.source_id,
      displayName: c.display_name,
      login: c.login,
      avatarUrl: c.avatar_url,
      url: channelUrl(c.platform, { sourceId: c.source_id, login: c.login }),
      streamerId: row.id,
    })),
  };
}
/** Recording cards contain all Channel metadata needed by the frontend. */
export function recording(row: RecordingRow): Recording {
  return {
    id: row.id,
    platform: row.platform,
    sourceId: row.source_id,
    partId: row.source_part_id,
    title: row.title ?? "Untitled video",
    publishedAt: row.published_at,
    recordedAt: row.recorded_at,
    durationSeconds: row.duration_seconds,
    availability: row.availability,
    available: row.availability === "available",
    channel: channel(row, row.platform),
    sessionId: row.session_id,
    streamerMode: !!row.streamer_mode,
    matchupCount: row.matchup_count ?? null,
  };
}
/** Resolve object keys only through the visibility-checked screenshot endpoint. */
function screenshot(path: string | null) {
  if (!path) return null;
  const key = path.replace(
    /^\/(?:storage\/v1\/object\/public\/detections|detections)\//,
    "",
  );
  return `/detections/${key.split("/").map(encodeURIComponent).join("/")}`;
}
function recordingRef(row: { source_id: string; source_video_id: string; source_part_id: string | null; source_part_index: number | null }) {
  return { sourceId: row.source_id, videoId: row.source_video_id, partId: row.source_part_id, partIndex: row.source_part_index };
}
/** A Recording Source with registry-built links targeting its Recording and Recording-relative time. */
export function source(row: SourceRow): RecordingSource {
  const ref = recordingRef(row), embed = embedUrl(row.platform, ref, row.at);
  return {
    kind: "recording",
    platform: row.platform,
    recording: {
      id: row.vod_id,
      sourceId: row.source_id,
      ...(row.source_part_id ? { partId: row.source_part_id } : {}),
      title: row.title ?? "Untitled video",
      publishedAt: row.published_at,
      recordedAt: row.recorded_at,
    },
    at: row.at,
    channel: channel(row, row.platform),
    isReupload: !!row.is_reupload,
    available: !!row.available,
    watchUrl: watchUrl(row.platform, ref, row.at),
    ...(embed ? { embedUrl: embed } : {}),
  };
}
export function evidence(row: SourceRow): Evidence {
  const encounter = projectEncounter([row]);
  return {
    id: row.detection_id,
    recordingId: row.vod_id,
    at: row.at,
    username: row.username,
    confidence: row.confidence,
    nameState: row.name_state,
    encounter,
    fieldEvidence: encounter.fieldEvidence,
    rank: row.rank,
    igd: row.igd,
    truncated: !!row.truncated,
    noRightEdge: !!row.no_right_edge,
    screenshotUrl: row.available ? screenshot(row.storage_path) : null,
  };
}
/** Assemble a Matchup from its display row, ordered Sources and attributed Streamer. */
export function matchup(row: MatchupRow, sources: SourceRow[], streamer: StreamerRef | null): Matchup {
  const encounter = projectEncounter(sources);
  return {
    id: row.matchup_id,
    opponent: { username: row.username, rank: sources.find(s => s.detection_id === encounter.fieldEvidence.rank?.detectionId)?.rank ?? null,
      igd: encounter.igd, confidence: row.confidence, nameState: row.name_state },
    encounter,
    fieldEvidence: encounter.fieldEvidence,
    streamer,
    session: row.session_id ? { id: row.session_id } : null,
    recordedAt: row.recorded_timestamp,
    indexedAt: row.indexed_at,
    sources: sources.map(source),
  };
}
const publicField: Record<FieldKey, EvidenceField> = { encounter: "encounter", username: "username", rank: "rank", igd: "igd",
  ghost_hero: "ghostHero", streamer_hero: "streamerHero", wins_remaining: "winsRemaining", lethal: "lethal",
  game_mode: "gameMode", tournament_wins: "tournamentWins", tournament_losses: "tournamentLosses" };
function observations(row: EncounterRow): FieldObservations {
  const raw: FieldObservations = JSON.parse(row.field_evidence || "{}");
  return row.igd_correction_evidence ? { ...raw, igd: JSON.parse(row.igd_correction_evidence) } : raw;
}
type Candidate = { row: EncounterRow; observation?: FieldObservation };
/** Scores only compare within the same method/model, never across unrelated scales.
 * New direct observations precede legacy unknown-quality fallback; stable time/ID ties.
 * Legacy-only projection retains the old display ordering, without relabeling its score.
 */
function selectField(sources: EncounterRow[], field: FieldKey, observed: Map<EncounterRow, FieldObservations>): Candidate | undefined {
  const value = (r: EncounterRow) => field === "encounter" ? r.encounter_confidence : r[field];
  return sources.flatMap(row => {
    const observation = observed.get(row)?.[field];
    if (value(row) == null && field !== "encounter" && !(field === "username" && observation) && !(field === "igd" && row.igd_correction_id)) return [];
    if (!observation && (row.name_state !== "legacy" || !["encounter", "username", "rank", "igd"].includes(field))) return [];
    return [{ row, observation }];
  }).sort((a, b) => {
    if (field === "igd" && !!a.row.igd_correction_id !== !!b.row.igd_correction_id) return a.row.igd_correction_id ? -1 : 1;
    if (field === "username") return nameTier(a.row) - nameTier(b.row)
      || (b.row.confidence ?? -1) - (a.row.confidence ?? -1)
      || Number(a.row.rank === null) - Number(b.row.rank === null) || Number(a.row.igd === null) - Number(b.row.igd === null)
      || a.row.indexed_at.localeCompare(b.row.indexed_at) || a.row.detection_id.localeCompare(b.row.detection_id);
    if (!!a.observation !== !!b.observation) return a.observation ? -1 : 1;
    if (!a.observation && !b.observation) return (b.row.confidence ?? -1) - (a.row.confidence ?? -1)
      || Number(a.row.rank === null) - Number(b.row.rank === null) || Number(a.row.igd === null) - Number(b.row.igd === null)
      || a.row.indexed_at.localeCompare(b.row.indexed_at) || a.row.detection_id.localeCompare(b.row.detection_id);
    const x = a.observation!, y = b.observation!;
    // Group method/model before comparing confidence: this is a total ordering,
    // unlike a pairwise comparator that skips scores only for unlike methods.
    return Number(!!x.inherited_from) - Number(!!y.inherited_from)
      || x.method.localeCompare(y.method) || (x.model ?? "").localeCompare(y.model ?? "")
      || (y.confidence ?? -1) - (x.confidence ?? -1) || x.at_ms - y.at_ms || a.row.detection_id.localeCompare(b.row.detection_id);
  })[0];
}
/** Turns a stored image path into a client URL; public projection hides images of unavailable Recordings. */
export type ImageUrl = (path: string | null, row: EncounterRow) => string | null;
const publicImage: ImageUrl = (path, row) => row.available ? screenshot(path) : null;
function fieldEvidence({ row, observation: o }: Candidate, field: FieldKey, image: ImageUrl): FieldEvidence {
  const visible = (path: string | null) => image(path, row);
  return { detectionId: row.detection_id, recordingId: row.vod_id, atMs: o?.at_ms ?? row.at * 1000,
    confidence: o ? o.confidence : (field === "username" ? row.confidence : null), method: o?.method ?? "legacy",
    screenshotUrl: visible(o?.image_path ?? row.storage_path), phase: o?.phase ?? "unknown",
    frameSha256: o?.frame_sha256 ?? null, sourceWidth: o?.source_width ?? null, sourceHeight: o?.source_height ?? null,
    region: o?.region ?? null, selectionReason: o?.selection_reason ?? null,
    ...(o?.model ? { model: o.model } : {}), ...(o?.prompt_version ? { promptVersion: o.prompt_version } : {}),
    ...(o?.samples ? { samples: o.samples.map(s => ({ atMs: s.at_ms, screenshotUrl: visible(s.image_path) })) } : {}),
    ...(o?.run_segment_id ? { runSegmentId: o.run_segment_id } : {}),
    ...(o?.inherited_from ? { inheritedFrom: { detectionId: o.inherited_from.detection_id,
      runSegmentId: o.inherited_from.run_segment_id, atMs: o.inherited_from.at_ms } } : {}) };
}
/** Independent per-field winners within an already-established Matchup only. */
export function projectEncounter(sources: EncounterRow[], image: ImageUrl = publicImage): Encounter {
  const observed = new Map(sources.map(row => [row, observations(row)]));
  const chosen = Object.fromEntries((Object.keys(publicField) as FieldKey[]).map(k => [k, selectField(sources, k, observed)])) as Partial<Record<FieldKey, Candidate>>;
  const mode = chosen.game_mode?.row.game_mode ?? null;
  if (mode === "tournament") {
    delete chosen.wins_remaining; delete chosen.lethal;
    // The score pair belongs to the selected mode observation, never independent winners.
    const row = chosen.game_mode!.row;
    for (const key of ["tournament_wins", "tournament_losses"] as const)
      chosen[key] = row[key] != null && observed.get(row)?.[key] ? { row, observation: observed.get(row)?.[key] } : undefined;
  } else {
    delete chosen.tournament_wins; delete chosen.tournament_losses;
    const compatible = sources.filter(row => (row.game_mode ?? null) === mode);
    for (const key of ["wins_remaining", "lethal"] as const) chosen[key] = selectField(compatible, key, observed);
  }
  const fieldEvidenceMap: Encounter["fieldEvidence"] = {};
  for (const key of Object.keys(chosen) as FieldKey[]) if (chosen[key]) fieldEvidenceMap[publicField[key]] = fieldEvidence(chosen[key]!, key, image);
  const day = chosen.igd?.row;
  const rawDay: FieldObservations = day ? JSON.parse(day.field_evidence || "{}") : {};
  return { confidence: chosen.encounter?.row.encounter_confidence ?? null,
    ghostHero: chosen.ghost_hero?.row.ghost_hero ?? null, streamerHero: chosen.streamer_hero?.row.streamer_hero ?? null,
    igd: chosen.igd?.row.igd ?? null, winsRemaining: chosen.wins_remaining?.row.wins_remaining ?? null,
    rawIgd: day ? (day.raw_igd === undefined ? day.igd : day.raw_igd) : null,
    rawIgdEvidence: day && (rawDay.igd || day.name_state === "legacy") ? fieldEvidence({ row: day, observation: rawDay.igd }, "igd", image) : null,
    igdCorrection: day?.igd_correction_id ? { id: day.igd_correction_id, inputDigest: day.igd_correction_input_digest!,
      reason: day.igd_correction_reason!, createdAt: day.igd_correction_created_at!, sourceRefs: JSON.parse(day.igd_correction_source_refs!) } : null,
    gameMode: mode, tournamentWins: chosen.tournament_wins?.row.tournament_wins ?? null,
    tournamentLosses: chosen.tournament_losses?.row.tournament_losses ?? null,
    lethal: chosen.lethal?.row.lethal == null ? null : !!chosen.lethal.row.lethal, fieldEvidence: fieldEvidenceMap };
}
export function result(row: MatchupRow, sources: SourceRow[], streamer: StreamerRef | null): MatchupResult {
  return { ...matchup(row, sources, streamer), relevance: { score: row.score, exact: !!row.exact } };
}
export function detail(row: MatchupRow, sources: SourceRow[], streamer: StreamerRef | null, redirectedFrom?: number): MatchupDetail {
  return {
    ...matchup(row, sources, streamer),
    ...(redirectedFrom !== undefined ? { redirectedFrom } : {}),
    detections: sources.map(evidence),
  };
}
/** Platform-specific playback information; Twitch requires the browser's parent domain. */
export function player(row: RecordingRow) {
  const ref = recordingRef(row);
  return {
    platform: row.platform,
    sourceId: row.source_id,
    watchUrl: watchUrl(row.platform, ref),
    embedUrl: embedUrl(row.platform, ref),
    available: row.availability === "available",
  };
}
