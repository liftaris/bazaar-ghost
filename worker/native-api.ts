import type { Evidence, Page, Playback, Session, SessionCard, Stats, StreamerCard, TimelineMarker } from "../contracts/public-api";
import { canonicalMatchup } from "./coalesce";
import { HttpError, integer, one, requireValue, rows } from "./http";
import { boundary, page, unchanged } from "./native-cursor";
import {
  channel,
  detail,
  evidence,
  player,
  publicStreamer,
  recording,
  result,
  streamerRef,
  type MatchupRow,
  type RecordingRow,
  type SourceRow,
  type StreamerRefRow,
} from "./native-model";
import { trigrams } from "./search";
import { missingChunks, normalizeRanges } from "./processing";
import { publicCache } from "./cache";
import { Timing } from "./timing";
import { memoizesState } from "./visibility";
import { listPlatforms, platform } from "./platform-registry";
import { resolveStreamer } from "./streamers";

const prefix = "/api/v1";
const idValue = (value: string, label = "ID") => {
  requireValue(/^[1-9]\d{0,15}$/.test(value), `Invalid ${label}`);
  return Number(value);
};
const CHANNEL_ID = /^[0-9a-f-]{36}$/;
export function parameters(url: URL, allowed: string[], max = 100) {
  requireValue(url.href.length <= 4096, "Request URL too long");
  for (const key of url.searchParams.keys())
    requireValue(
      allowed.includes(key) && url.searchParams.getAll(key).length === 1,
      "Unsupported query parameter",
    );
  const limit = url.searchParams.get("limit") ?? "50";
  requireValue(/^\d+$/.test(limit), "Invalid limit");
  return integer(Number(limit), "limit", 1, max);
}
function queryText(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  requireValue(q.length <= 128, "Search must be at most 128 characters");
  return q;
}
/** Platform ID lists (`platform` includes, `excludePlatform` excludes), comma separated; unknown IDs are rejected. */
function platformList(url: URL, key: "platform" | "excludePlatform") {
  const value = url.searchParams.get(key);
  if (value === null) return [];
  const ids = value.split(",").map((id) => platform(id).id);
  requireValue(ids.length <= 20, `Too many ${key} values`);
  return [...new Set(ids)];
}
/** An ISO 8601 instant, normalized to the stored `YYYY-MM-DDTHH:MM:SS.sssZ` form so it compares as text. */
function instant(url: URL, key: "from" | "to") {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  requireValue(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value), `Invalid ${key}`);
  const time = new Date(value);
  requireValue(!Number.isNaN(time.getTime()), `Invalid ${key}`);
  return time.toISOString();
}
const SESSION_ID = /^[0-9a-f]{32}$/;
/** Filters shared by /search and /recordings. */
function filters(url: URL) {
  const found: { channel?: string; streamer?: number; recording?: number } = {};
  const channelId = url.searchParams.get("channelId"),
    streamerId = url.searchParams.get("streamerId"),
    recordingId = url.searchParams.get("recordingId");
  if (channelId !== null) {
    requireValue(CHANNEL_ID.test(channelId), "Invalid channelId");
    found.channel = channelId;
  }
  if (streamerId !== null) found.streamer = idValue(streamerId, "streamerId");
  if (recordingId !== null) found.recording = idValue(recordingId, "recordingId");
  return found;
}
const channelColumns = `a.source_id AS channel_source_id,a.display_name AS channel_name,a.login AS channel_login,a.avatar_url AS channel_avatar,
  (SELECT o.streamer_id FROM channel_ownership o WHERE o.channel_id=a.id AND o.ended_at IS NULL) AS channel_streamer_id`;

/** Ordered Sources (MAT-03) of the given Matchups, SQL-ordered so every route agrees. */
async function sourcesOf(env: Env, ids: number[]) {
  const found = ids.length
    ? await rows<SourceRow>(
        env,
        `SELECT s.*,${channelColumns} FROM public_sources s JOIN platform_accounts a ON a.id=s.channel_id
        WHERE s.matchup_id IN(SELECT value FROM json_each(?))
        ORDER BY s.matchup_id,CASE s.kind WHEN 'recording' THEN 0 ELSE 1 END,s.available DESC,s.is_reupload,s.confidence DESC,
        s.recorded_at IS NULL,s.recorded_at,s.vod_id,s.anchor_id`,
        JSON.stringify(ids),
      )
    : [];
  const by = new Map<number, SourceRow[]>();
  for (const row of found) by.set(row.matchup_id, [...(by.get(row.matchup_id) ?? []), row]);
  return by;
}
/** The Streamer a Matchup is attributed to: its Session's, else the owner of a Source's Channel. */
async function streamersOf(env: Env, ids: number[]) {
  const found = ids.length
    ? await rows<StreamerRefRow & { matchup_id: number }>(
        env,
        `SELECT m.id AS matchup_id,i.id,i.display_name,i.avatar_url FROM matchups m
        JOIN streamer_identities i ON i.id=coalesce(
          (SELECT s.streamer_id FROM sessions s WHERE s.id=m.session_id),
          (SELECT min(ms.streamer_id) FROM matchup_streamers ms WHERE ms.matchup_id=m.id))
        WHERE m.id IN(SELECT value FROM json_each(?))`,
        JSON.stringify(ids),
      )
    : [];
  return new Map(found.map((row) => [row.matchup_id, streamerRef(row)]));
}

export async function search(env: Env, url: URL) {
  const timeline = url.searchParams.has("sessionId") && url.searchParams.get("sort") === "time";
  // A whole recording's ghosts are listed in one page, so session-time lists may be longer.
  const limit = parameters(url, ["q", "streamerId", "channelId", "platform", "excludePlatform", "from", "to", "sessionId", "sort", "recordingId", "limit", "cursor"], timeline ? 500 : 100);
  const q = queryText(url),
    state = await boundary(env, url),
    filter = filters(url),
    include = platformList(url, "platform"),
    exclude = platformList(url, "excludePlatform"),
    from = instant(url, "from"),
    to = instant(url, "to"),
    sessionId = url.searchParams.get("sessionId"),
    sort = url.searchParams.get("sort");
  requireValue(sort === null || (sort === "time" && sessionId !== null), "sort=time requires sessionId");
  requireValue(sessionId === null || SESSION_ID.test(sessionId), "Invalid sessionId");
  const grams = trigrams(q);
  if (q && !grams.length) return { items: [], nextCursor: null };
  const clauses = ["p.matchup_id<=?"],
    args: unknown[] = [state.matchups];
  // A filter needs an available Source that satisfies it, so a filtered result is always playable there.
  const scope = (sql: string, ...values: unknown[]) => {
    clauses.push(`EXISTS(SELECT 1 FROM public_sources f WHERE f.matchup_id=p.matchup_id AND f.available=1 AND ${sql})`);
    args.push(...values);
  };
  if (include.length) scope("f.platform IN(SELECT value FROM json_each(?))", JSON.stringify(include));
  if (exclude.length) scope("f.platform NOT IN(SELECT value FROM json_each(?))", JSON.stringify(exclude));
  if (filter.channel) scope("f.channel_id=?", filter.channel);
  if (filter.recording) scope("f.vod_id=?", filter.recording);
  if (filter.streamer !== undefined) {
    clauses.push("EXISTS(SELECT 1 FROM matchup_streamers ms WHERE ms.matchup_id=p.matchup_id AND ms.streamer_id=?)");
    args.push(filter.streamer);
  }
  // A Matchup without a recorded time never satisfies a date filter.
  if (from) (clauses.push("p.recorded_timestamp>=?"), args.push(from));
  if (to) (clauses.push("p.recorded_timestamp<=?"), args.push(to));
  if (sessionId) (clauses.push("p.session_id=?"), args.push(sessionId));
  // Rank only the Matchups a selective condition names (same ranking as the public_matchups view): name hits with `q`,
  // else a Session, a Recording or a Streamer. Without one, every public Matchup is ranked.
  let pool = "",
    poolBinds: unknown[] = [];
  if (q) pool = "SELECT matchup_id FROM hits";
  else if (sessionId) (pool = "SELECT id FROM matchups WHERE session_id=?"), (poolBinds = [sessionId]);
  else if (filter.recording) (pool = "SELECT matchup_id FROM matchup_anchors WHERE vod_id=?"), (poolBinds = [filter.recording]);
  else if (filter.streamer !== undefined) (pool = "SELECT matchup_id FROM matchup_streamers WHERE streamer_id=?"), (poolBinds = [filter.streamer]);
  const hits = q
    ? `candidates AS (SELECT g.name,1.0*count(*)/(?+n.gram_count-count(*)) AS score
    FROM search_grams g JOIN search_names n ON n.name=g.name
    WHERE g.gram IN(SELECT value FROM json_each(?)) GROUP BY g.name
    HAVING 1.0*count(*)/(?+n.gram_count-count(*))>=0.25),
    hits AS (SELECT a.matchup_id,max(c.score) AS score,max(d.username_lower=?) AS exact
    FROM candidates c JOIN detections d ON d.username_lower=c.name JOIN matchup_anchors a ON a.current_detection_id=d.id
    WHERE a.matchup_id<=? GROUP BY a.matchup_id),`
    : "";
  const named = pool
    ? `named AS (SELECT r.matchup_id,r.detection_id,r.username,r.confidence,r.rank,r.igd,r.recorded_timestamp,r.latest_indexed_at AS indexed_at,
      m.session_id,m.session_time
      FROM (SELECT ps.matchup_id,ps.detection_id,ps.username,ps.confidence,ps.rank,ps.igd,ps.recorded_timestamp,
        row_number() OVER (PARTITION BY ps.matchup_id ORDER BY ps.confidence DESC,ps.rank IS NULL,ps.igd IS NULL,ps.indexed_at,ps.detection_id) AS display_rank,
        max(ps.indexed_at) OVER (PARTITION BY ps.matchup_id) AS latest_indexed_at
        FROM public_sources ps WHERE ps.matchup_id IN(${pool})) r
      JOIN matchups m ON m.id=r.matchup_id WHERE r.display_rank=1),`
    : "";
  const candidates = hits + named;
  const binds: unknown[] = [...(q ? [grams.length, JSON.stringify(grams), grams.length, q, state.matchups] : []), ...poolBinds];
  // Session-time order puts Matchups with no mapped time last.
  const order = timeline ? "(coalesce(session_time,1e15),matchup_id)" : "(exact,score,indexed_at,matchup_id)";
  const position = state.after.length ? `WHERE ${order}${timeline ? ">" : "<"}(${state.after.map(() => "?").join(",")})` : "";
  const found = await rows<MatchupRow>(
    env,
    `WITH ${candidates} matched AS (
    SELECT p.*,${q ? "h.score,h.exact" : "1.0 AS score,0 AS exact"}
    FROM ${q ? "hits h JOIN named p ON p.matchup_id=h.matchup_id" : pool ? "named p" : "public_matchups p"}
    WHERE ${clauses.join(" AND ")}) SELECT * FROM matched ${position}
    ORDER BY ${timeline ? "coalesce(session_time,1e15),matchup_id" : "exact DESC,score DESC,indexed_at DESC,matchup_id DESC"} LIMIT ?`,
    ...binds,
    ...args,
    ...state.after,
    limit + 1,
  );
  const resultPage = await page(env, state, found, limit, (row) =>
    timeline ? [row.session_time ?? 1e15, row.matchup_id] : [row.exact, row.score, row.indexed_at, row.matchup_id],
  );
  return { ...resultPage, items: await matchupCards(env, resultPage.items) };
}
/** Public Matchup cards (ordered Sources, Streamer) for already-selected rows, keeping their order. */
export async function matchupCards(env: Env, found: MatchupRow[]) {
  const ids = found.map((row) => row.matchup_id);
  const [sources, streamers] = await Promise.all([sourcesOf(env, ids), streamersOf(env, ids)]);
  return found.map((row) => result(row, sources.get(row.matchup_id) ?? [], streamers.get(row.matchup_id) ?? null));
}
async function matchupDetail(env: Env, url: URL, id: number) {
  parameters(url, []);
  // Matchup IDs are never reused: an old anchor ID or a retired Matchup ID follows `merged_into`.
  const canonical = await canonicalMatchup(env, id);
  const row =
    canonical === null
      ? null
      : await one<MatchupRow>(env, "SELECT *,1.0 AS score,0 AS exact FROM public_matchups WHERE matchup_id=?", canonical);
  if (!row) throw new HttpError(404, "Matchup not available");
  const [sources, streamers] = await Promise.all([sourcesOf(env, [row.matchup_id]), streamersOf(env, [row.matchup_id])]);
  return detail(row, sources.get(row.matchup_id) ?? [], streamers.get(row.matchup_id) ?? null, canonical !== id ? id : undefined);
}

const recordingCount = `(SELECT count(DISTINCT s.matchup_id) FROM public_sources s WHERE s.vod_id=r.id) AS matchup_count`;
async function recordings(env: Env, url: URL) {
  const limit = parameters(url, ["q", "streamerId", "channelId", "platform", "hasMatchups", "limit", "cursor"]);
  const state = await boundary(env, url),
    q = queryText(url),
    filter = filters(url);
  requireValue(!url.searchParams.has("recordingId"), "Unsupported query parameter");
  const clauses = ["r.id<=?", "r.availability='available'"],
    args: unknown[] = [state.recordings];
  if (url.searchParams.has("platform")) (clauses.push("r.platform=?"), args.push(platform(url.searchParams.get("platform")).id));
  if (filter.channel) (clauses.push("r.channel_id=?"), args.push(filter.channel));
  if (filter.streamer !== undefined) {
    clauses.push("(r.channel_streamer_id=? OR EXISTS(SELECT 1 FROM sessions s WHERE s.id=r.session_id AND s.streamer_id=?))");
    args.push(filter.streamer, filter.streamer);
  }
  const has = url.searchParams.get("hasMatchups");
  requireValue(has === null || has === "true" || has === "false", "Invalid hasMatchups");
  if (has === "true") {
    clauses.push("EXISTS(SELECT 1 FROM public_sources s WHERE s.vod_id=r.id AND s.matchup_id<=?)");
    args.push(state.matchups);
  }
  if (q) {
    clauses.push("(instr(lower(coalesce(r.title,'')),?)>0 OR instr(lower(r.source_id),?)>0)");
    args.push(q, q);
  }
  if (state.after.length) (clauses.push("r.id<?"), args.push(state.after[0]));
  const found = await rows<RecordingRow>(
    env,
    `SELECT r.*,${recordingCount} FROM public_recordings r WHERE ${clauses.join(" AND ")} ORDER BY r.id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const resultPage = await page(env, state, found, limit, (row) => [row.id]);
  return { ...resultPage, items: resultPage.items.map(recording) };
}
async function getRecording(env: Env, id: number) {
  const row = await one<RecordingRow>(env, `SELECT r.*,${recordingCount} FROM public_recordings r WHERE r.id=?`, id);
  if (!row) throw new HttpError(404, "Recording not found");
  return row;
}
async function lookupRecording(env: Env, url: URL) {
  parameters(url, ["platform", "sourceId"]);
  const sourceId = url.searchParams.get("sourceId") ?? "";
  requireValue(url.searchParams.has("platform") && sourceId.length > 0 && sourceId.length <= 200, "platform and sourceId required");
  const row = await one<RecordingRow>(
    env,
    `SELECT r.*,${recordingCount} FROM public_recordings r WHERE r.platform=? AND r.source_id=?`,
    platform(url.searchParams.get("platform")).id,
    sourceId,
  );
  if (!row) throw new HttpError(404, "Recording not found");
  return recording(row);
}
async function lookupChannel(env: Env, url: URL) {
  parameters(url, ["platform", "login", "sourceId"]);
  const login = url.searchParams.get("login"),
    sourceId = url.searchParams.get("sourceId");
  requireValue(url.searchParams.has("platform") && (login === null) !== (sourceId === null), "platform and exactly one of login or sourceId required");
  const value = login ?? sourceId!;
  requireValue(value.length > 0 && value.length <= 200, "Invalid lookup value");
  const id = platform(url.searchParams.get("platform")).id;
  const select = `SELECT a.id AS channel_id,a.source_id AS channel_source_id,a.display_name AS channel_name,a.login AS channel_login,a.avatar_url AS channel_avatar,
    o.streamer_id AS channel_streamer_id FROM platform_accounts a LEFT JOIN channel_ownership o ON o.channel_id=a.id AND o.ended_at IS NULL WHERE a.source=?`;
  type Found = Parameters<typeof channel>[0];
  let found: Found[];
  if (sourceId !== null) found = await rows<Found>(env, `${select} AND a.source_id=?`, id, sourceId);
  else {
    found = await rows<Found>(env, `${select} AND a.login=? COLLATE NOCASE LIMIT 2`, id, value);
    if (!found.length) found = await rows<Found>(env, `${select} AND a.display_name=? COLLATE NOCASE LIMIT 2`, id, value);
  }
  if (!found.length) throw new HttpError(404, "Channel not found");
  if (found.length > 1) throw new HttpError(409, "Ambiguous channel; use its ID");
  return channelWithOwner(env, found[0], id);
}
async function channelWithOwner(env: Env, row: Parameters<typeof channel>[0], platformId: string) {
  const owner = row.channel_streamer_id
    ? await one<StreamerRefRow>(env, "SELECT id,display_name,avatar_url FROM streamer_identities WHERE id=?", row.channel_streamer_id)
    : null;
  return { channel: channel(row, platformId), streamer: owner ? streamerRef(owner) : null };
}
async function channelDetail(env: Env, url: URL, id: string) {
  parameters(url, []);
  const found = await one<Parameters<typeof channel>[0] & { platform: string }>(
    env,
    `SELECT a.id AS channel_id,a.source AS platform,a.source_id AS channel_source_id,a.display_name AS channel_name,a.login AS channel_login,a.avatar_url AS channel_avatar,
    o.streamer_id AS channel_streamer_id FROM platform_accounts a LEFT JOIN channel_ownership o ON o.channel_id=a.id AND o.ended_at IS NULL WHERE a.id=?`,
    id,
  );
  if (!found) throw new HttpError(404, "Channel not found");
  return channelWithOwner(env, found, found.platform);
}
/** The Channel `a` published an available Recording of a visible Matchup (what public_sources lists, reached by index). */
const publicContent = `EXISTS(SELECT 1 FROM vods v JOIN matchup_anchors x ON x.vod_id=v.id AND x.current_detection_id IS NOT NULL
  JOIN matchups m ON m.id=x.matchup_id AND m.status='visible' AND m.merged_into IS NULL WHERE v.platform_account_id=a.id AND v.availability='available')`;
/** What public_sources requires of a Matchup `u.matchup_id`: visible, not merged, with an available Recording that has a current detection. */
const publicMatchup = `EXISTS(SELECT 1 FROM matchups m WHERE m.id=u.matchup_id AND m.status='visible' AND m.merged_into IS NULL)
  AND EXISTS(SELECT 1 FROM matchup_anchors b JOIN vods bv ON bv.id=b.vod_id
    WHERE b.matchup_id=u.matchup_id AND b.current_detection_id IS NOT NULL AND bv.availability='available')`;
/** Streamers with at least one public Matchup, with list counts, ordered by Matchup count (best name match first with `q`).
 * A Streamer's platforms are those of its owned Channels with public content; counts are not narrowed by platform filters. */
async function streamers(env: Env, url: URL): Promise<Page<StreamerCard>> {
  const limit = parameters(url, ["q", "platform", "excludePlatform", "cursor", "limit"]),
    state = await boundary(env, url),
    q = queryText(url),
    include = platformList(url, "platform"),
    exclude = platformList(url, "excludePlatform");
  const clauses = ["mc.n>0"],
    args: unknown[] = [];
  const owned = (sql: string, ...values: unknown[]) => {
    clauses.push(`EXISTS(SELECT 1 FROM streamer_platforms sp WHERE sp.streamer_id=i.id AND ${sql})`);
    args.push(...values);
  };
  if (include.length) owned("sp.platform IN(SELECT value FROM json_each(?))", JSON.stringify(include));
  if (exclude.length) owned("sp.platform NOT IN(SELECT value FROM json_each(?))", JSON.stringify(exclude));
  // exact name 0, prefix 1, contains 2 (the display name or an owned Channel's name or login); only those Streamers are counted
  let named = "SELECT id,0 AS tier FROM streamer_identities";
  const tierArgs: unknown[] = [];
  if (q) {
    const names = `SELECT lower(i.display_name) AS n UNION ALL SELECT lower(a.display_name) FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id
      WHERE o.streamer_id=i.id AND o.ended_at IS NULL UNION ALL SELECT lower(coalesce(a.login,'')) FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id
      WHERE o.streamer_id=i.id AND o.ended_at IS NULL`;
    named = `SELECT i.id,coalesce((SELECT min(CASE WHEN n=? THEN 0 WHEN instr(n,?)=1 THEN 1 ELSE 2 END) FROM (${names}) WHERE instr(n,?)>0),9) AS tier
      FROM streamer_identities i WHERE tier<9`;
    tierArgs.push(q, q, q);
  }
  if (state.after.length) (clauses.push("(i.tier,-mc.n,i.id)>(?,?,?)"), args.push(...state.after));
  // matchup_streamers' three sources, by index; counting only the named Streamers one by one beats counting every Streamer.
  const mc = q
    ? `SELECT n.id,(SELECT count(*) FROM (
        SELECT a.matchup_id FROM channel_ownership o JOIN vods v ON v.platform_account_id=o.channel_id JOIN matchup_anchors a ON a.vod_id=v.id
          WHERE o.streamer_id=n.id AND o.ended_at IS NULL
        UNION SELECT a.matchup_id FROM sessions s JOIN vods v ON v.session_id=s.id JOIN matchup_anchors a ON a.vod_id=v.id WHERE s.streamer_id=n.id
        UNION SELECT m.id FROM sessions s JOIN matchups m ON m.session_id=s.id WHERE s.streamer_id=n.id) u
        WHERE u.matchup_id<=? AND ${publicMatchup}) AS n FROM named n`
    : `SELECT u.streamer_id AS id,count(DISTINCT u.matchup_id) AS n FROM (
        SELECT o.streamer_id,a.matchup_id FROM channel_ownership o JOIN vods v ON v.platform_account_id=o.channel_id JOIN matchup_anchors a ON a.vod_id=v.id
          WHERE o.ended_at IS NULL
        UNION SELECT s.streamer_id,a.matchup_id FROM sessions s JOIN vods v ON v.session_id=s.id JOIN matchup_anchors a ON a.vod_id=v.id WHERE s.streamer_id IS NOT NULL
        UNION SELECT s.streamer_id,m.id FROM sessions s JOIN matchups m ON m.session_id=s.id WHERE s.streamer_id IS NOT NULL) u
        WHERE u.matchup_id<=? AND ${publicMatchup} GROUP BY u.streamer_id`;
  // One round trip: the ranked page and, for each Streamer on it, its Channels, Session count and platforms.
  const found = await rows<StreamerRefRow & { tier: number; n: number; channels: string; session_count: number; platforms: string }>(
    env,
    `WITH named AS MATERIALIZED (${named}),
    mc AS (${mc}),
    streamer_platforms AS (SELECT DISTINCT o.streamer_id,a.source AS platform FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id
      WHERE o.ended_at IS NULL AND ${publicContent}),
    ranked AS (SELECT i.id,i.tier,mc.n FROM named i JOIN mc ON mc.id=i.id WHERE ${clauses.join(" AND ")} ORDER BY i.tier,mc.n DESC,i.id LIMIT ?)
    SELECT r.id,r.tier,r.n,i.display_name,i.avatar_url,
      (SELECT json_group_array(json_object('id',c.id,'platform',c.source,'source_id',c.source_id,'display_name',c.display_name,'login',c.login,'avatar_url',c.avatar_url))
        FROM (SELECT a.* FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id WHERE o.ended_at IS NULL AND o.streamer_id=r.id
          ORDER BY a.source,a.display_name,a.id) c) AS channels,
      (SELECT count(*) FROM (
        SELECT s.id AS session_id FROM sessions s WHERE s.merged_into IS NULL AND s.streamer_id=r.id
        UNION SELECT g.session_id FROM channel_ownership o JOIN vods v ON v.platform_account_id=o.channel_id
          JOIN recording_alignments g ON g.vod_id=v.id AND g.revoked_at IS NULL JOIN sessions s ON s.id=g.session_id AND s.merged_into IS NULL
          WHERE o.ended_at IS NULL AND o.streamer_id=r.id) p
        WHERE EXISTS(SELECT 1 FROM recording_alignments g JOIN vods v ON v.id=g.vod_id
          WHERE g.session_id=p.session_id AND g.revoked_at IS NULL AND v.availability='available')) AS session_count,
      (SELECT json_group_array(platform) FROM (SELECT platform FROM streamer_platforms WHERE streamer_id=r.id ORDER BY platform)) AS platforms
    FROM ranked r JOIN streamer_identities i ON i.id=r.id ORDER BY r.tier,r.n DESC,r.id`,
    ...tierArgs,
    state.matchups,
    ...args,
    limit + 1,
  );
  const items = found.slice(0, limit).map(
    (row): StreamerCard => ({
      ...publicStreamer(row, JSON.parse(row.channels)),
      sessionCount: row.session_count,
      matchupCount: row.n,
      platforms: JSON.parse(row.platforms),
    }),
  );
  const resultPage = await page(env, state, found, limit, (row) => [row.tier, -row.n, row.id]);
  return { ...resultPage, items };
}
async function timeline(env: Env, url: URL, id: number): Promise<Page<TimelineMarker>> {
  const limit = parameters(url, ["cursor", "limit"]),
    state = await boundary(env, url);
  const found = await rows<{ matchup_id: number; at: number; username: string; rank: string | null }>(
    env,
    `SELECT matchup_id,at,username,rank FROM public_sources
    WHERE vod_id=? AND matchup_id<=? ${state.after.length ? "AND (at,matchup_id)>(?,?)" : ""}
    ORDER BY at,matchup_id LIMIT ?`,
    id,
    state.matchups,
    ...state.after,
    limit + 1,
  );
  const resultPage = await page(env, state, found, limit, (row) => [row.at, row.matchup_id]);
  return {
    ...resultPage,
    items: resultPage.items.map((row) => ({ id: row.matchup_id, timestampSeconds: row.at, username: row.username, rank: row.rank })),
  };
}
async function recordingEvidence(env: Env, url: URL, id: number): Promise<Page<Evidence>> {
  const limit = parameters(url, ["cursor", "limit"]),
    state = await boundary(env, url);
  const found = await rows<SourceRow>(
    env,
    `SELECT * FROM public_sources WHERE vod_id=? AND matchup_id<=? ${state.after.length ? "AND at>?" : ""} ORDER BY at LIMIT ?`,
    id,
    state.matchups,
    ...state.after,
    limit + 1,
  );
  const resultPage = await page(env, state, found, limit, (row) => [row.at]);
  return { ...resultPage, items: resultPage.items.map(evidence) };
}
async function playback(env: Env, url: URL, id: number): Promise<Playback> {
  parameters(url, []);
  const row = await getRecording(env, id);
  const chunks = await rows<{ start_seconds: number; end_seconds: number }>(
    env,
    "SELECT start_seconds,end_seconds FROM chunks WHERE vod_id=? AND status='completed' ORDER BY start_seconds",
    id,
  );
  const chapters = JSON.parse(row.bazaar_chapters) as number[];
  const eligibleRanges = normalizeRanges(chapters, row.duration_seconds);
  const completedRanges = normalizeRanges(
    chunks.flatMap((chunk) => [chunk.start_seconds, chunk.end_seconds]),
    row.duration_seconds,
  );
  const timelineURL = new URL(`${prefix}/recordings/${id}/timeline?limit=100`, url);
  return {
    recording: recording(row),
    player: player(row),
    chapters,
    processing: {
      status: row.status,
      eligibleRanges,
      completedRanges,
      remainingRanges: normalizeRanges(missingChunks(eligibleRanges, completedRanges).flat(), row.duration_seconds),
    },
    timeline: await timeline(env, timelineURL, id),
  };
}
async function sessionDetail(env: Env, url: URL, requested: string): Promise<Session> {
  parameters(url, []);
  let id = requested;
  for (let hop = 0; hop < 8; hop++) {
    const next = await one<{ merged_into: string | null }>(env, "SELECT merged_into FROM sessions WHERE id=?", id);
    if (!next) throw new HttpError(404, "Session not found");
    if (next.merged_into === null) break;
    id = next.merged_into;
  }
  const [session] = await sessionsOf(env, [id]);
  if (!session) throw new HttpError(404, "Session not found");
  return id !== requested ? { ...session, redirectedFrom: requested } : session;
}
/** Sessions (canonical only) with their Recordings, segments and Matchup counts, in the order given. */
async function sessionsOf(env: Env, ids: string[]): Promise<Session[]> {
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  const [found, segments, counts] = await Promise.all([
    rows<{ id: string; title: string | null; streamer_id: number | null; owner_name: string | null; owner_avatar: string | null }>(
      env,
      `SELECT s.id,s.title,s.streamer_id,i.display_name AS owner_name,i.avatar_url AS owner_avatar FROM sessions s
      LEFT JOIN streamer_identities i ON i.id=s.streamer_id WHERE s.merged_into IS NULL AND s.id IN(SELECT value FROM json_each(?))`,
      json,
    ),
    rows<{ session_id: string; vod_id: number; rec_start: number; rec_end: number | null; offset_seconds: number }>(
      env,
      `SELECT session_id,vod_id,rec_start,rec_end,offset_seconds FROM recording_alignments
      WHERE session_id IN(SELECT value FROM json_each(?)) AND revoked_at IS NULL ORDER BY vod_id,rec_start`,
      json,
    ),
    rows<{ session_id: string; n: number }>(
      env,
      "SELECT session_id,count(*) AS n FROM public_matchups WHERE session_id IN(SELECT value FROM json_each(?)) GROUP BY session_id",
      json,
    ),
  ]);
  const vodIds = [...new Set(segments.map((s) => s.vod_id))];
  const recordingRows = vodIds.length
    ? await rows<RecordingRow>(env, `SELECT r.*,${recordingCount} FROM public_recordings r WHERE r.id IN(SELECT value FROM json_each(?)) ORDER BY r.id`, JSON.stringify(vodIds))
    : [];
  const byId = new Map(found.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const own = segments.filter((s) => s.session_id === id);
    const members = new Set(own.map((s) => s.vod_id));
    return {
      id,
      title: row.title,
      streamer: row.streamer_id ? streamerRef({ id: row.streamer_id, display_name: row.owner_name!, avatar_url: row.owner_avatar }) : null,
      recordings: recordingRows
        .filter((r) => members.has(r.id))
        .map((r) => ({
          recording: recording(r),
          segments: own.filter((s) => s.vod_id === r.id).map((s) => ({ recStart: s.rec_start, recEnd: s.rec_end, offsetSeconds: s.offset_seconds })),
        })),
      matchupCount: counts.find((c) => c.session_id === id)?.n ?? 0,
    };
  });
}
/** Rows of a Session's Recordings (one per Recording, canonical Sessions only) with the facts every Session query ranks on. */
const sessionRecordings = `SELECT g.session_id,r.id,r.platform,r.title,r.duration_seconds,r.availability='available' AS available,
    coalesce(r.recorded_at,r.published_at) AS at,s.streamer_id AS session_streamer,r.channel_streamer_id,
    CASE WHEN s.streamer_id IS NOT NULL AND r.channel_streamer_id IS NOT s.streamer_id THEN 1 ELSE 0 END AS is_reupload,
    r.channel_id,r.channel_source_id,r.channel_name,r.channel_login,r.channel_avatar,s.title AS session_title,lower(i.display_name) AS streamer_name
  FROM (SELECT DISTINCT session_id,vod_id FROM recording_alignments WHERE revoked_at IS NULL) g
  JOIN sessions s ON s.id=g.session_id AND s.merged_into IS NULL
  JOIN public_recordings r ON r.id=g.vod_id AND r.id<=?
  LEFT JOIN streamer_identities i ON i.id=s.streamer_id`;
interface SessionRecordingRow {
  session_id: string;
  id: number;
  platform: string;
  title: string | null;
  duration_seconds: number;
  available: number;
  at: string | null;
  is_reupload: number;
  channel_id: string;
  channel_source_id: string;
  channel_name: string;
  channel_login: string | null;
  channel_avatar: string | null;
  channel_streamer_id: number | null;
  session_title: string | null;
}
/** Sessions that have an available Recording, searched and filtered, newest first (relevance first with `q`).
 * A Session is a Streamer's when it names them or any of its Recordings was published by a Channel they actively own
 * (reuploads included). `startedAt` is its earliest Recording time (recorded, else published). */
async function sessions(env: Env, url: URL): Promise<Page<SessionCard>> {
  const limit = parameters(url, ["q", "streamerId", "platform", "excludePlatform", "from", "to", "limit", "cursor"]),
    state = await boundary(env, url),
    q = queryText(url),
    include = platformList(url, "platform"),
    exclude = platformList(url, "excludePlatform"),
    from = instant(url, "from"),
    to = instant(url, "to"),
    streamerId = url.searchParams.get("streamerId");
  const having = ["max(available)=1"],
    args: unknown[] = [];
  const scope = (sql: string, ...values: unknown[]) => (having.push(`max(available=1 AND ${sql})=1`), args.push(...values));
  if (include.length) scope("platform IN(SELECT value FROM json_each(?))", JSON.stringify(include));
  if (exclude.length) scope("platform NOT IN(SELECT value FROM json_each(?))", JSON.stringify(exclude));
  if (streamerId !== null) {
    having.push("max(session_streamer=? OR channel_streamer_id=?)=1");
    args.push(idValue(streamerId, "streamerId"), idValue(streamerId, "streamerId"));
  }
  // A Session without a Recording time never satisfies a date filter.
  if (from) (having.push("min(at)>=?"), args.push(from));
  if (to) (having.push("min(at)<=?"), args.push(to));
  let relevance = "0";
  if (q) {
    const names = ["streamer_name", "lower(channel_name)", "lower(coalesce(channel_login,''))"];
    relevance = `max(CASE WHEN ${names.map((n) => `${n}=?`).join(" OR ")} THEN 3
      WHEN ${names.map((n) => `instr(${n},?)=1`).join(" OR ")} THEN 2
      WHEN ${[...names, "lower(coalesce(title,''))"].map((n) => `instr(${n},?)>0`).join(" OR ")} THEN 1 ELSE 0 END)`;
    having.push("rel>0");
  }
  if (state.after.length) (having.push("(rel,started,session_id)<(?,?,?)"), args.push(...state.after));
  const found = await rows<{ session_id: string; rel: number; started: string }>(
    env,
    `WITH recs AS (${sessionRecordings}) SELECT session_id,${relevance} AS rel,coalesce(min(at),'') AS started FROM recs
    GROUP BY session_id HAVING ${having.join(" AND ")} ORDER BY rel DESC,started DESC,session_id DESC LIMIT ?`,
    state.recordings,
    ...(q ? Array(10).fill(q) : []),
    ...args,
    limit + 1,
  );
  const resultPage = await page(env, state, found, limit, (row) => [row.rel, row.started, row.session_id]);
  return { ...resultPage, items: await sessionCards(env, resultPage.items.map((row) => row.session_id), state, { include, exclude }) };
}
async function sessionCards(env: Env, ids: string[], state: { recordings: number }, scope: { include: string[]; exclude: string[] }): Promise<SessionCard[]> {
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  const [recs, counts, owners] = await Promise.all([
    rows<SessionRecordingRow>(
      env,
      `WITH recs AS (${sessionRecordings}) SELECT * FROM recs WHERE session_id IN(SELECT value FROM json_each(?))`,
      state.recordings,
      json,
    ),
    rows<{ session_id: string; n: number }>(
      env,
      "SELECT session_id,count(*) AS n FROM public_matchups WHERE session_id IN(SELECT value FROM json_each(?)) GROUP BY session_id",
      json,
    ),
    rows<StreamerRefRow & { session_id: string }>(
      env,
      `SELECT s.id AS session_id,i.id,i.display_name,i.avatar_url FROM sessions s JOIN streamer_identities i ON i.id=s.streamer_id
      WHERE s.id IN(SELECT value FROM json_each(?))`,
      json,
    ),
  ]);
  const countOf = new Map(counts.map((c) => [c.session_id, c.n])),
    ownerOf = new Map(owners.map((o) => [o.session_id, streamerRef(o)]));
  return ids.flatMap((id) => {
    const own = recs.filter((r) => r.session_id === id);
    const inScope = (r: SessionRecordingRow) =>
      +(!!r.available && (!scope.include.length || scope.include.includes(r.platform)) && !scope.exclude.includes(r.platform));
    // The best Recording: in the requested platforms, available, the Streamer's own before a reupload, then the earliest.
    const best = own.toSorted(
      (a, b) =>
        inScope(b) - inScope(a) || b.available - a.available || a.is_reupload - b.is_reupload || (a.at ?? "\uffff").localeCompare(b.at ?? "\uffff") || a.id - b.id,
    )[0];
    if (!best) return [];
    return {
      id,
      title: best.title ?? best.session_title,
      streamer: ownerOf.get(id) ?? null,
      channel: channel(best, best.platform),
      startedAt: own.reduce<string | null>((min, r) => (r.at && (!min || r.at < min) ? r.at : min), null),
      durationSeconds: best.duration_seconds,
      matchupCount: countOf.get(id) ?? 0,
      platforms: [...new Set(own.filter((r) => r.available).map((r) => r.platform))].sort(),
      defaultRecording: { id: best.id, platform: best.platform },
    };
  });
}

/** Recognize only explicit public contracts; social/auth routes keep their private behavior. */
export function nativePath(path: string) {
  return /^\/api\/v1\/(search|stats|platforms|streamers(?:\/quality|\/[1-9]\d{0,15})?|recordings(?:\/lookup|\/[1-9]\d{0,15}\/(?:playback|timeline|detections))?|channels\/(?:lookup|[0-9a-f-]{36})|matchups\/[1-9]\d{0,15}|sessions|sessions\/[0-9a-f]{32})$/.test(
    path,
  );
}
/** Dispatch the native public API without allowing arbitrary table/column access. */
async function nativeLoad(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET")
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  const url = new URL(req.url),
    path = url.pathname.slice(prefix.length);
  let output: unknown;
  if (path === "/search") output = await search(env, url);
  else if (path === "/platforms") {
    parameters(url, []);
    output = {
      items: listPlatforms().map(({ id, name, mark, capabilities, embed }) => ({ id, name, mark, capabilities, embed })),
      nextCursor: null,
    };
  } else if (path === "/streamers") output = await streamers(env, url);
  else if (path === "/streamers/quality") {
    const limit = parameters(url, ["cursor", "limit"]),
      state = await boundary(env, url);
    const found = await rows<{ login: string; displayName: string; averageConfidence: number }>(
      env,
      `SELECT login,display_name AS displayName,avg_confidence AS averageConfidence FROM streamer_detection_stats
      WHERE avg_confidence<0.5 ${state.after.length ? "AND login>?" : ""} ORDER BY login LIMIT ?`,
      ...state.after,
      limit + 1,
    );
    output = await page(env, state, found, limit, (row) => [row.login]);
  } else if (/^\/streamers\/\d+$/.test(path)) {
    parameters(url, []);
    const found = await resolveStreamer(env, Number(path.split("/")[2]));
    output = publicStreamer(found as StreamerRefRow, found.channels);
  } else if (path === "/recordings") output = await recordings(env, url);
  else if (path === "/recordings/lookup") output = await lookupRecording(env, url);
  else if (path === "/channels/lookup") output = await lookupChannel(env, url);
  else if (path.startsWith("/channels/")) output = await channelDetail(env, url, path.slice("/channels/".length));
  else if (path === "/sessions") output = await sessions(env, url);
  else if (path === "/stats") {
    parameters(url, []);
    output = await one<Stats>(
      env,
      `SELECT count(DISTINCT matchup_id) AS matchups,count(DISTINCT CASE WHEN available=1 THEN vod_id END) AS recordings,
      (SELECT count(DISTINCT ms.streamer_id) FROM matchup_streamers ms WHERE ms.matchup_id IN(SELECT matchup_id FROM public_sources)) AS streamers
      FROM public_sources`,
    );
  } else if (path.startsWith("/sessions/")) output = await sessionDetail(env, url, path.slice("/sessions/".length));
  else {
    const match = path.match(/^\/(recordings|matchups)\/(\d+)(?:\/(playback|timeline|detections))?$/)!;
    const id = idValue(match[2]);
    output =
      match[1] === "matchups"
        ? await matchupDetail(env, url, id)
        : match[3] === "playback"
          ? await playback(env, url, id)
          : (await getRecording(env, id), match[3] === "detections" ? await recordingEvidence(env, url, id) : await timeline(env, url, id));
  }
  return Response.json(output, { headers: { "Cache-Control": "no-store" } });
}

/** Cache public payloads behind current primary-D1 visibility and correction checks.
 * Signed cursors are verified before cache access, including their expiration.
 * Never cache session state, errors, or a response spanning a correction.
 */
export async function nativeRoute(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname === `${prefix}/platforms`) return nativeLoad(req, env);
  const timing = new Timing(),
    timed = timing.wrap(env);
  const attempt = async () => {
    const state = await boundary(timed, url);
    const cacheUrl = new URL(url);
    cacheUrl.searchParams.set("native-revision", `${state.revision}:${state.matchups}:${state.recordings}`);
    return publicCache(new Request(cacheUrl, req), timed, async () => {
      const loaded = await nativeLoad(req, timed);
      await unchanged(timed, state, true);
      return loaded;
    });
  };
  let response: Response;
  try {
    response = await attempt();
  } catch (error) {
    // A boundary taken from the short-lived revision memo may predate a correction; the failed check refreshed it.
    if (!memoizesState(env) || !(error instanceof HttpError) || error.status !== 409 || url.searchParams.has("cursor")) throw error;
    response = await attempt();
  }
  const result = new Response(response.body, response);
  result.headers.set("Server-Timing", timing.header());
  return result;
}
