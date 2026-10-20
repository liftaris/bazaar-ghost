import type { Evidence, Page, Playback, Session, Stats, TimelineMarker } from "../contracts/public-api";
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
import { listPlatforms, platform } from "./platform-registry";
import { listStreamers, resolveStreamer } from "./streamers";

const prefix = "/api/v1";
const idValue = (value: string, label = "ID") => {
  requireValue(/^[1-9]\d{0,15}$/.test(value), `Invalid ${label}`);
  return Number(value);
};
const CHANNEL_ID = /^[0-9a-f-]{36}$/;
export function parameters(url: URL, allowed: string[]) {
  requireValue(url.href.length <= 4096, "Request URL too long");
  for (const key of url.searchParams.keys())
    requireValue(
      allowed.includes(key) && url.searchParams.getAll(key).length === 1,
      "Unsupported query parameter",
    );
  const limit = url.searchParams.get("limit") ?? "50";
  requireValue(/^\d+$/.test(limit), "Invalid limit");
  return integer(Number(limit), "limit", 1, 100);
}
function queryText(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  requireValue(q.length <= 128, "Search must be at most 128 characters");
  return q;
}
/** Filters shared by /search and /recordings. `scope` renders the "has an available Source matching" test. */
function filters(url: URL) {
  const found: { platform?: string; channel?: string; streamer?: number; recording?: number } = {};
  const platformId = url.searchParams.get("platform"),
    channelId = url.searchParams.get("channelId"),
    streamerId = url.searchParams.get("streamerId"),
    recordingId = url.searchParams.get("recordingId");
  if (platformId !== null) found.platform = platform(platformId).id;
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
  const limit = parameters(url, ["q", "streamerId", "channelId", "platform", "recordingId", "limit", "cursor"]);
  const q = queryText(url),
    state = await boundary(env, url),
    filter = filters(url);
  const grams = trigrams(q);
  if (q && !grams.length) return { items: [], nextCursor: null };
  const clauses = ["p.matchup_id<=?"],
    args: unknown[] = [state.matchups];
  // A filter needs an available Source that satisfies it, so a filtered result is always playable there.
  const scope = (sql: string, ...values: unknown[]) => {
    clauses.push(`EXISTS(SELECT 1 FROM public_sources f WHERE f.matchup_id=p.matchup_id AND f.available=1 AND ${sql})`);
    args.push(...values);
  };
  if (filter.platform) scope("f.platform=?", filter.platform);
  if (filter.channel) scope("f.channel_id=?", filter.channel);
  if (filter.recording) scope("f.vod_id=?", filter.recording);
  if (filter.streamer !== undefined) {
    clauses.push("EXISTS(SELECT 1 FROM matchup_streamers ms WHERE ms.matchup_id=p.matchup_id AND ms.streamer_id=?)");
    args.push(filter.streamer);
  }
  const candidates = q
    ? `candidates AS (SELECT g.name,1.0*count(*)/(?+n.gram_count-count(*)) AS score
    FROM search_grams g JOIN search_names n ON n.name=g.name
    WHERE g.gram IN(SELECT value FROM json_each(?)) GROUP BY g.name
    HAVING 1.0*count(*)/(?+n.gram_count-count(*))>=0.25),
    hits AS (SELECT s.matchup_id,max(c.score) AS score,max(s.username_lower=?) AS exact
    FROM public_sources s JOIN candidates c ON c.name=s.username_lower WHERE s.matchup_id<=? GROUP BY s.matchup_id),`
    : "";
  const binds: unknown[] = q ? [grams.length, JSON.stringify(grams), grams.length, q, state.matchups] : [];
  const position = state.after.length ? "WHERE (exact,score,indexed_at,matchup_id)<(?,?,?,?)" : "";
  const found = await rows<MatchupRow>(
    env,
    `WITH ${candidates} matched AS (
    SELECT p.*,${q ? "h.score,h.exact" : "1.0 AS score,0 AS exact"}
    FROM ${q ? "hits h JOIN public_matchups p ON p.matchup_id=h.matchup_id" : "public_matchups p"}
    WHERE ${clauses.join(" AND ")}) SELECT * FROM matched ${position}
    ORDER BY exact DESC,score DESC,indexed_at DESC,matchup_id DESC LIMIT ?`,
    ...binds,
    ...args,
    ...state.after,
    limit + 1,
  );
  const resultPage = await page(env, state, found, limit, (row) => [row.exact, row.score, row.indexed_at, row.matchup_id]);
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
  if (filter.platform) (clauses.push("r.platform=?"), args.push(filter.platform));
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
  const owner = found[0].channel_streamer_id
    ? await one<StreamerRefRow>(env, "SELECT id,display_name,avatar_url FROM streamer_identities WHERE id=?", found[0].channel_streamer_id)
    : null;
  return { channel: channel(found[0], id), streamer: owner ? streamerRef(owner) : null };
}
async function streamers(env: Env, url: URL) {
  const limit = parameters(url, ["q", "cursor", "limit"]),
    state = await boundary(env, url),
    q = queryText(url);
  // The picker lists Streamers that have at least one public Matchup.
  const clauses = [
    "i.id>?",
    "EXISTS(SELECT 1 FROM matchup_streamers ms WHERE ms.streamer_id=i.id AND EXISTS(SELECT 1 FROM public_sources ps WHERE ps.matchup_id=ms.matchup_id))",
  ];
  const args: unknown[] = [Number(state.after[0] ?? 0)];
  if (q) {
    clauses.push(`(instr(lower(i.display_name),?)>0 OR EXISTS(SELECT 1 FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id
      WHERE o.streamer_id=i.id AND o.ended_at IS NULL AND (instr(lower(a.display_name),?)>0 OR instr(lower(coalesce(a.login,'')),?)>0)))`);
    args.push(q, q, q);
  }
  const ids = await rows<{ id: number }>(env, `SELECT i.id FROM streamer_identities i WHERE ${clauses.join(" AND ")} ORDER BY i.id LIMIT ?`, ...args, limit + 1);
  const found = (await listStreamers(env, { ids: ids.map((row) => row.id) })).map((row) => publicStreamer(row as StreamerRefRow, row.channels));
  return page(env, state, found, limit, (row) => [row.id]);
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
  const session = await one<{ id: string; title: string | null; streamer_id: number | null }>(env, "SELECT id,title,streamer_id FROM sessions WHERE id=? AND merged_into IS NULL", id);
  if (!session) throw new HttpError(404, "Session not found");
  const owner = session.streamer_id
    ? await one<StreamerRefRow>(env, "SELECT id,display_name,avatar_url FROM streamer_identities WHERE id=?", session.streamer_id)
    : null;
  const segments = await rows<{ vod_id: number; rec_start: number; rec_end: number | null; offset_seconds: number }>(
    env,
    "SELECT vod_id,rec_start,rec_end,offset_seconds FROM recording_alignments WHERE session_id=? AND revoked_at IS NULL ORDER BY vod_id,rec_start",
    id,
  );
  const ids = [...new Set(segments.map((s) => s.vod_id))];
  const found = ids.length
    ? await rows<RecordingRow>(env, `SELECT r.*,${recordingCount} FROM public_recordings r WHERE r.id IN(SELECT value FROM json_each(?)) ORDER BY r.id`, JSON.stringify(ids))
    : [];
  const count = (await one<{ n: number }>(env, "SELECT count(*) AS n FROM public_matchups WHERE session_id=?", id))!.n;
  return {
    id,
    title: session.title,
    streamer: owner ? streamerRef(owner) : null,
    recordings: found.map((row) => ({
      recording: recording(row),
      segments: segments
        .filter((s) => s.vod_id === row.id)
        .map((s) => ({ recStart: s.rec_start, recEnd: s.rec_end, offsetSeconds: s.offset_seconds })),
    })),
    matchupCount: count,
    ...(id !== requested ? { redirectedFrom: requested } : {}),
  };
}

/** Recognize only explicit public contracts; social/auth routes keep their private behavior. */
export function nativePath(path: string) {
  return /^\/api\/v1\/(search|stats|platforms|streamers(?:\/quality|\/[1-9]\d{0,15})?|recordings(?:\/lookup|\/[1-9]\d{0,15}\/(?:playback|timeline|detections))?|channels\/lookup|matchups\/[1-9]\d{0,15}|sessions\/[0-9a-f]{32})$/.test(
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
  const state = await boundary(env, url);
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set("native-revision", `${state.revision}:${state.matchups}:${state.recordings}`);
  const response = await publicCache(new Request(cacheUrl, req), env, async () => {
    const loaded = await nativeLoad(req, env);
    await unchanged(env, state);
    return loaded;
  });
  await unchanged(env, state);
  return response;
}
