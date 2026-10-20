import { channelUrl, embedUrl, watchUrl } from "./platform-registry";
import type {
  Channel,
  Evidence,
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
  username: string;
  confidence: number;
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
/** One row of the public_matchups view plus search relevance. */
export interface MatchupRow {
  matchup_id: number;
  username: string;
  confidence: number;
  rank: string | null;
  igd: number | null;
  recorded_timestamp: string | null;
  indexed_at: string;
  session_id: string | null;
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
  return {
    id: row.detection_id,
    recordingId: row.vod_id,
    at: row.at,
    username: row.username,
    confidence: row.confidence,
    rank: row.rank,
    igd: row.igd,
    truncated: !!row.truncated,
    noRightEdge: !!row.no_right_edge,
    screenshotUrl: row.available ? screenshot(row.storage_path) : null,
  };
}
/** Assemble a Matchup from its display row, ordered Sources and attributed Streamer. */
export function matchup(row: MatchupRow, sources: SourceRow[], streamer: StreamerRef | null): Matchup {
  return {
    id: row.matchup_id,
    opponent: { username: row.username, rank: row.rank, igd: row.igd, confidence: row.confidence },
    streamer,
    session: row.session_id ? { id: row.session_id } : null,
    recordedAt: row.recorded_timestamp,
    indexedAt: row.indexed_at,
    sources: sources.map(source),
  };
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
