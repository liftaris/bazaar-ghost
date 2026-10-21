/** Public, platform-neutral contracts. Copied into the frontend by generate_frontend_api.py. */
/** A registry platform ID; never a closed union, so a new platform needs no contract change. */
export type PlatformId = string;
/** A bounded page. A null cursor means the result set is exhausted. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
/** A Streamer without its Channels, as attached to Matchups and Sessions. */
export interface StreamerRef {
  id: number;
  displayName: string;
  avatarUrl: string | null;
}
/** A platform account. `streamerId` is its active owner; display names are never identifiers. */
export interface Channel {
  id: string;
  platform: PlatformId;
  sourceId: string;
  displayName: string;
  login: string | null;
  avatarUrl: string | null;
  /** The Channel's page on its platform; null when it cannot be built from what is stored. */
  url: string | null;
  streamerId: number | null;
}
/** A person with every Channel they actively own, across platforms. */
export interface Streamer extends StreamerRef {
  channels: Channel[];
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
/** A registered platform. */
export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  mark: string;
  capabilities: PlatformCapabilities;
  embed: { kind: string; requires: string[] };
}
/** Public OCR quality summary used by the existing help page. */
export interface StreamerQuality {
  login: string;
  displayName: string;
  averageConfidence: number;
}
/** One platform copy of a Session's footage. A Bilibili part is its own Recording. */
export interface Recording {
  id: number;
  platform: PlatformId;
  sourceId: string;
  partId: string | null;
  title: string;
  publishedAt: string | null;
  recordedAt: string | null;
  durationSeconds: number;
  availability: string;
  available: boolean;
  channel: Channel;
  sessionId: string | null;
  /** Visible Matchups with a Detection in this Recording; null where the route does not count them. */
  matchupCount: number | null;
}
/** Where a Source plays. `at` is Recording-relative (part-relative on Bilibili). */
export interface RecordingSource {
  kind: "recording";
  platform: PlatformId;
  recording: { id: number; sourceId: string; partId?: string; title: string; publishedAt: string | null; recordedAt: string | null };
  at: number;
  channel: Channel;
  isReupload: boolean;
  available: boolean;
  watchUrl: string;
  embedUrl?: string;
}
/** A short platform video of the Matchup. Declared for later use; the API does not emit it yet. */
export interface ClipSource {
  kind: "clip";
  platform: PlatformId;
  clip: { id: string; sourceId: string };
  range?: [number, number];
  parent?: { id: number; sourceId: string; partId?: string };
  attribution: Channel;
  available: boolean;
  watchUrl: string;
  embedUrl?: string;
}
/** A playable way to watch a Matchup. Order is defined (MAT-03): recordings before clips, available first,
 * own before reuploads, best Detection confidence, earliest recording time, lowest Recording ID. */
export type Source = RecordingSource | ClipSource;
export type NameState = "legacy" | "complete" | "partial" | "obstructed" | "masked" | "unreadable";
export type Hero = "vanessa" | "pygmalien" | "dooley" | "mak" | "jules" | "stelle" | "karnok" | "the_dragons";
export type EvidenceField = "encounter" | "username" | "rank" | "igd" | "ghostHero" | "streamerHero" | "winsRemaining" | "lethal";
/** One selected observation, at its actual image time, not necessarily the encounter anchor. */
export interface FieldEvidence {
  detectionId: string;
  recordingId: number;
  atMs: number;
  confidence: number | null;
  method: string;
  screenshotUrl: string | null;
  phase: "intro" | "pre_fight" | "post_fight" | "unknown";
  frameSha256: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  region: [number, number, number, number] | null;
  selectionReason: string | null;
  model?: string;
  promptVersion?: string;
  samples?: Array<{ atMs: number; screenshotUrl: string | null }>;
  /** Processor-observed continuity segment, not a Session or server-verified visual run. */
  runSegmentId?: string;
  /** Original persisted direct proof; atMs/image above remain that original observation. */
  inheritedFrom?: { detectionId: string; runSegmentId: string; atMs: number };
}
export interface Encounter {
  /** Encounter confidence is separate from username confidence; unknown for legacy observations. */
  confidence: number | null;
  ghostHero: Hero | null;
  streamerHero: Hero | null;
  igd: number | null;
  winsRemaining: number | null;
  lethal: boolean | null;
  fieldEvidence: Partial<Record<EvidenceField, FieldEvidence>>;
}
/** The best-supported name, rank and in-game day of a Matchup (MAT-04). */
export interface Opponent {
  username: string | null;
  rank: string | null;
  igd: number | null;
  /** Username recognition confidence only. */
  confidence: number | null;
  nameState: NameState;
}
/** One distinct fight with every way to watch it. */
export interface Matchup {
  id: number;
  opponent: Opponent;
  encounter: Encounter;
  /** Alias of encounter.fieldEvidence, also including selected name/rank evidence. */
  fieldEvidence: Partial<Record<EvidenceField, FieldEvidence>>;
  streamer: StreamerRef | null;
  session: { id: string } | null;
  recordedAt: string | null;
  indexedAt: string;
  sources: Source[];
}
/** A search hit: relevance is search-only and separate from OCR confidence. */
export interface MatchupResult extends Matchup {
  relevance: { score: number; exact: boolean };
}
/** SFDE evidence for a Matchup in one Recording. `screenshotUrl` is null when its Recording is unavailable. */
export interface Evidence {
  id: string;
  recordingId: number;
  at: number;
  username: string | null;
  confidence: number | null;
  nameState: NameState;
  encounter: Encounter;
  fieldEvidence: Partial<Record<EvidenceField, FieldEvidence>>;
  rank: string | null;
  igd: number | null;
  truncated: boolean;
  noRightEdge: boolean;
  screenshotUrl: string | null;
}
/** A Matchup with all its contributing Detections. `redirectedFrom` is set when the requested ID was retired. */
export interface MatchupDetail extends Matchup {
  redirectedFrom?: number;
  detections: Evidence[];
}
/** A Streamer with list counts. `platforms` are those of its owned Channels with public content. */
export interface StreamerCard extends Streamer {
  sessionCount: number;
  matchupCount: number;
  platforms: PlatformId[];
}
/** A Session's Recordings with their time mappings; `session_time = recording_time + offsetSeconds`. */
export interface Session {
  id: string;
  title: string | null;
  streamer: StreamerRef | null;
  recordings: Array<{
    recording: Recording;
    segments: Array<{ recStart: number; recEnd: number | null; offsetSeconds: number }>;
  }>;
  matchupCount: number;
  redirectedFrom?: string;
}
/** Lean Session list item. `channel` is the Channel that published the default Recording (the fallback label when there is no Streamer). */
export interface SessionCard {
  id: string;
  title: string | null;
  streamer: StreamerRef | null;
  channel: Channel;
  startedAt: string | null;
  durationSeconds: number | null;
  matchupCount: number;
  /** Platforms with an available Recording, sorted. */
  platforms: PlatformId[];
  defaultRecording: { id: number; platform: PlatformId };
}
/** Compact timeline marker, identified by Matchup ID. */
export interface TimelineMarker {
  id: number;
  timestampSeconds: number;
  username: string | null;
  nameState: NameState;
  rank: string | null;
}
/** Player capabilities and completed coverage are distinct from Recording availability. */
export interface Playback {
  recording: Recording;
  player: {
    platform: PlatformId;
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
/** A Channel resolved from a platform login, with its owner if any. */
export interface ChannelLookup {
  channel: Channel;
  streamer: StreamerRef | null;
}
/** Public aggregate counts of public Matchups, cached separately from result pages. */
export interface Stats {
  matchups: number;
  recordings: number;
  streamers: number;
}
/** Response types for the supported public GET routes. */
export interface PublicRoutes {
  "/search": Page<MatchupResult>;
  /** Private (cookie session, no-store): the caller's saved public Matchups, most recently saved first. */
  "/me/favorites": Page<MatchupResult>;
  "/streamers": Page<StreamerCard>;
  "/streamers/quality": Page<StreamerQuality>;
  "/recordings/lookup": Recording;
  "/channels/lookup": ChannelLookup;
  "/sessions": Page<SessionCard>;
  "/stats": Stats;
  "/platforms": Page<PlatformDefinition>;
  [path: `/streamers/${number}`]: Streamer;
  [path: `/recordings/${number}/playback`]: Playback;
  [path: `/recordings/${number}/timeline`]: Page<TimelineMarker>;
  [path: `/recordings/${number}/detections`]: Page<Evidence>;
  [path: `/matchups/${number}`]: MatchupDetail;
  [path: `/channels/${string}`]: ChannelLookup;
  [path: `/sessions/${string}`]: Session;
}
