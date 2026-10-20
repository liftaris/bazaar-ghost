import { embedUrl, watchUrl } from "./platform-registry";
import type {
  Creator,
  Matchup,
  Platform,
  Video,
} from "../contracts/public-api";

/** Columns shared by public video and matchup queries. */
export interface VideoRow {
  id: number;
  source: Platform;
  source_id: string;
  source_video_id: string | null;
  source_part_id: string | null;
  source_part_index: number | null;
  title: string | null;
  duration_seconds: number;
  published_at: string | null;
  availability: string;
  creator_id: string;
  creator_source_id: string;
  creator_name: string;
  creator_login: string | null;
  creator_avatar: string | null;
  matchup_count?: number;
  bazaar_chapters: string;
  status: string;
}
/** Current published evidence at a durable anchor. */
export interface MatchupRow extends VideoRow {
  matchup_id: number;
  vod_id: number;
  detection_id: string;
  username: string;
  confidence: number;
  rank: string | null;
  igd: number | null;
  frame_time_seconds: number;
  storage_path: string | null;
  truncated: number;
  no_right_edge: number;
  recorded_timestamp: string | null;
  indexed_at: string;
  score: number;
  exact: number;
}
/** Map platform identity without exposing processing configuration. */
export function creator(row: VideoRow): Creator {
  return {
    id: row.creator_id,
    platform: row.source,
    sourceId: row.creator_source_id,
    name: row.creator_name,
    login: row.creator_login,
    avatarUrl: row.creator_avatar,
  };
}
/** Video cards contain all creator metadata needed by the frontend. */
export function video(row: VideoRow): Video {
  return {
    id: row.id,
    platform: row.source,
    sourceId: row.source_id,
    title: row.title ?? "Untitled video",
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds,
    availability: row.availability,
    creator: creator(row),
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
/** Preserve OCR confidence independently of search relevance. */
export function matchup(row: MatchupRow): Matchup {
  return {
    id: row.matchup_id,
    video: video({ ...row, id: row.vod_id }),
    timestampSeconds: row.frame_time_seconds,
    recordedAt: row.recorded_timestamp,
    indexedAt: row.indexed_at,
    detection: {
      id: row.detection_id,
      username: row.username,
      confidence: row.confidence,
      rank: row.rank,
      igd: row.igd,
      truncated: !!row.truncated,
      noRightEdge: !!row.no_right_edge,
      screenshotUrl: screenshot(row.storage_path),
    },
    relevance: { score: row.score, exact: !!row.exact },
  };
}
/** Platform-specific playback information; Twitch requires the browser's parent domain. */
export function player(row: VideoRow) {
  const recording = { sourceId: row.source_id, videoId: row.source_video_id, partId: row.source_part_id, partIndex: row.source_part_index };
  const watch = watchUrl(row.source, recording), embed = embedUrl(row.source, recording);
  return {
    platform: row.source,
    sourceId: row.source_id,
    watchUrl: watch,
    embedUrl: embed,
    available: row.availability === "available",
  };
}
