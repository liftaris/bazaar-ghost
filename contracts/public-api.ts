/** Public, platform-neutral contracts. Copied into the frontend by generate_frontend_api.py. */
export type Platform = "twitch" | "youtube" | "bilibili";
/** A bounded page. A null cursor means the result set is exhausted. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
/** Platform account identity; display names are never identifiers. */
export interface Creator {
  id: string;
  platform: Platform;
  sourceId: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
}
/** What a platform's player and catalog support; clients gate UI on these instead of platform names. */
export interface PlatformCapabilities {
  seek: boolean;
  timeEvents: boolean;
  mute: boolean;
  fullscreen: boolean;
  swap: boolean;
  clips: boolean;
  createClip: boolean;
  clipParentRange: boolean;
  qualitySelectable: boolean;
}
/** A registered platform. `Platform` above stays a closed union for v1 only. */
export interface PlatformDefinition {
  id: string;
  name: string;
  mark: string;
  capabilities: PlatformCapabilities;
  embed: { kind: string; requires: string[] };
}
/** Public OCR quality summary used by the existing help page. */
export interface CreatorQuality {
  login: string;
  displayName: string;
  averageConfidence: number;
}
/** Video metadata shared by search and playback responses. */
export interface Video {
  id: number;
  platform: Platform;
  sourceId: string;
  title: string;
  publishedAt: string | null;
  durationSeconds: number;
  availability: string;
  creator: Creator;
  matchupCount: number | null;
}
/** A durable video anchor with its current OCR evidence, independent of OCR UUIDs. */
export interface Matchup {
  id: number;
  video: Video;
  timestampSeconds: number;
  recordedAt: string | null;
  indexedAt: string;
  detection: {
    id: string;
    username: string;
    confidence: number;
    rank: string | null;
    igd: number | null;
    truncated: boolean;
    noRightEdge: boolean;
    screenshotUrl: string | null;
  };
  relevance: { score: number; exact: boolean };
}
/** Verified alternate recordings of this occurrence; never inferred from a name alone. */
export interface MatchupDetail {
  matchup: Matchup;
  groupId: string | null;
  appearances: Matchup[];
}
/** Compact timeline marker, identified by durable matchup ID. */
export interface TimelineMarker {
  id: number;
  timestampSeconds: number;
  username: string;
  rank: string | null;
}
/** Player capabilities and completed coverage are distinct from video availability. */
export interface Playback {
  video: Video;
  player: {
    platform: Platform;
    sourceId: string;
    watchUrl: string;
    embedUrl: string | null;
    available: boolean;
  };
  chapters: number[];
  processing: {
    status: string;
    eligibleRanges: number[][];
    completedRanges: number[][];
    remainingRanges: number[][];
  };
  timeline: Page<TimelineMarker>;
}
/** Public aggregate counts, cached separately from result pages. */
export interface Stats {
  creators: number;
  videos: number;
  matchups: number;
}
/** Response types for the supported public GET routes. */
export interface PublicRoutes {
  "/search": Page<Matchup>;
  "/creators": Page<Creator>;
  "/creators/resolve": Creator;
  "/creators/quality": Page<CreatorQuality>;
  "/videos": Page<Video>;
  "/videos/resolve": Video;
  "/stats": Stats;
  "/platforms": Page<PlatformDefinition>;
  [path: `/videos/${number}/playback`]: Playback;
  [path: `/videos/${number}/timeline`]: Page<TimelineMarker>;
  [path: `/matchups/${number}`]: MatchupDetail;
}
