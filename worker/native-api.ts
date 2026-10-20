import type {
  MatchupDetail,
  Page,
  Playback,
  Stats,
  TimelineMarker,
} from "../contracts/public-api";
import { HttpError, integer, one, requireValue, rows } from "./http";
import { boundary, page, unchanged } from "./native-cursor";
import { listStreamers, resolveStreamer } from "./streamers";
import {
  creator,
  matchup,
  player,
  video,
  type MatchupRow,
  type VideoRow,
} from "./native-model";
import { trigrams } from "./search";
import { missingChunks, normalizeRanges } from "./processing";
import { publicCache } from "./cache";
import { listPlatforms } from "./platform-registry";

const prefix = "/api/v1";
const idValue = (value: string) => {
  requireValue(/^[1-9]\d*$/.test(value), "Invalid ID");
  return integer(Number(value), "ID", 1);
};
function parameters(url: URL, allowed: string[]) {
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
type Streamer = Awaited<ReturnType<typeof resolveStreamer>>;
function publicStreamer(row: Streamer) {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    channels: row.channels.map((c: Record<string, any>) => ({
      id: c.id, platform: c.platform, sourceId: c.source_id, displayName: c.display_name, login: c.login, avatarUrl: c.avatar_url,
    })),
  };
}
function queryText(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  requireValue(q.length <= 128, "Search must be at most 128 characters");
  return q;
}
function filters(url: URL, alias: string) {
  const clauses: string[] = [],
    args: unknown[] = [];
  const source = url.searchParams.get("source"),
    account = url.searchParams.get("creatorId");
  if (source) {
    requireValue(
      listPlatforms().some((entry) => entry.id === source),
      "Invalid source",
    );
    clauses.push(`${alias}.source=?`);
    args.push(source);
  }
  if (account) {
    requireValue(
      new RegExp(`^(twitch:[1-9]\\d*|(?:${listPlatforms().map((entry) => entry.id).join("|")}):[0-9a-f-]{36})$`).test(account),
      "Invalid creator ID",
    );
    clauses.push(`${alias}.creator_id=?`);
    args.push(account);
  }
  return { clauses, args };
}
const videoCount = `(SELECT count(*) FROM public_matchups m WHERE m.vod_id=v.id) AS matchup_count`;

async function search(env: Env, url: URL) {
  const limit = parameters(url, [
    "type",
    "q",
    "source",
    "creatorId",
    "videoId",
    "limit",
    "cursor",
  ]);
  requireValue(
    !url.searchParams.has("type") ||
      url.searchParams.get("type") === "matchups",
    "Unsupported search type",
  );
  const q = queryText(url),
    state = await boundary(env, url);
  const { clauses, args } = filters(url, "m");
  clauses.push("m.matchup_id<=?");
  args.push(state.clips);
  if (url.searchParams.has("videoId")) {
    clauses.push("m.vod_id=?");
    args.push(idValue(url.searchParams.get("videoId")!));
  }
  const grams = trigrams(q);
  if (q && !grams.length) return { items: [], nextCursor: null };
  const candidates = q
    ? `candidates AS (SELECT g.name,1.0*count(*)/(?+n.gram_count-count(*)) AS score
    FROM search_grams g JOIN search_names n ON n.name=g.name
    WHERE g.gram IN(SELECT value FROM json_each(?)) GROUP BY g.name
    HAVING 1.0*count(*)/(?+n.gram_count-count(*))>=0.25),`
    : "";
  const binds: unknown[] = q
    ? [grams.length, JSON.stringify(grams), grams.length, q]
    : [];
  const position = state.after.length
    ? "WHERE (exact,score,indexed_at,matchup_id)<(?,?,?,?)"
    : "";
  const result = await rows<MatchupRow>(
    env,
    `WITH ${candidates} matched AS (
    SELECT m.*,${q ? "c.score" : "1.0"} AS score,${q ? "named.username_lower=?" : "0"} AS exact
    FROM public_matchups m ${q ? "JOIN detections named ON named.id=m.detection_id JOIN candidates c ON c.name=named.username_lower" : ""}
    WHERE ${clauses.join(" AND ")}) SELECT * FROM matched ${position}
    ORDER BY exact DESC,score DESC,indexed_at DESC,matchup_id DESC LIMIT ?`,
    ...binds,
    ...args,
    ...state.after,
    limit + 1,
  );
  const resultPage = await page(env, state, result, limit, (row) => [
    row.exact,
    row.score,
    row.indexed_at,
    row.matchup_id,
  ]);
  return { ...resultPage, items: resultPage.items.map(matchup) };
}
async function videos(env: Env, url: URL) {
  const limit = parameters(url, [
    "q",
    "source",
    "creatorId",
    "hasMatchups",
    "limit",
    "cursor",
  ]);
  const state = await boundary(env, url),
    q = queryText(url);
  const { clauses, args } = filters(url, "v");
  clauses.push("v.id<=?", "v.availability='available'");
  args.push(state.videos);
  const has = url.searchParams.get("hasMatchups");
  requireValue(
    has === null || has === "true" || has === "false",
    "Invalid hasMatchups",
  );
  if (has === "true") {
    clauses.push(
      "EXISTS(SELECT 1 FROM public_matchups m WHERE m.vod_id=v.id AND m.matchup_id<=?)",
    );
    args.push(state.clips);
  }
  if (q) {
    clauses.push(
      "(instr(lower(coalesce(v.title,'')),?)>0 OR instr(lower(v.source_id),?)>0)",
    );
    args.push(q, q);
  }
  if (state.after.length) {
    clauses.push("v.id<?");
    args.push(state.after[0]);
  }
  const result = await rows<VideoRow>(
    env,
    `SELECT v.*,${videoCount} FROM public_videos v WHERE ${clauses.join(" AND ")} ORDER BY v.id DESC LIMIT ?`,
    ...args,
    limit + 1,
  );
  const resultPage = await page(env, state, result, limit, (row) => [row.id]);
  return { ...resultPage, items: resultPage.items.map(video) };
}
async function creators(env: Env, url: URL) {
  const limit = parameters(url, [
    "q",
    "source",
    "creatorId",
    "cursor",
    "limit",
  ]);
  const state = await boundary(env, url),
    q = queryText(url);
  const { clauses, args } = filters(url, "m");
  clauses.push("m.matchup_id<=?");
  args.push(state.clips);
  if (q) {
    clauses.push(
      "(instr(lower(m.creator_name),?)>0 OR instr(lower(coalesce(m.creator_login,'')),?)>0)",
    );
    args.push(q, q);
  }
  if (state.after.length) {
    clauses.push("m.creator_id>?");
    args.push(state.after[0]);
  }
  const result = await rows<VideoRow>(
    env,
    `SELECT m.creator_id,m.source,m.creator_source_id,m.creator_name,m.creator_login,m.creator_avatar
    FROM public_matchups m WHERE ${clauses.join(" AND ")}
    GROUP BY m.creator_id ORDER BY m.creator_id LIMIT ?`,
    ...args,
    limit + 1,
  );
  const resultPage = await page(env, state, result, limit, (row) => [
    row.creator_id,
  ]);
  return { ...resultPage, items: resultPage.items.map(creator) };
}
async function getVideo(env: Env, id: number) {
  const row = await one<VideoRow>(
    env,
    `SELECT v.*,${videoCount} FROM public_videos v WHERE v.id=?`,
    id,
  );
  if (!row) throw new HttpError(404, "Video not found");
  return row;
}
async function timeline(
  env: Env,
  url: URL,
  id: number,
): Promise<Page<TimelineMarker>> {
  const limit = parameters(url, ["cursor", "limit"]),
    state = await boundary(env, url);
  const result = await rows<{
    matchup_id: number;
    frame_time_seconds: number;
    username: string;
    rank: string | null;
  }>(
    env,
    `SELECT matchup_id,frame_time_seconds,username,rank FROM public_matchups
    WHERE vod_id=? AND matchup_id<=? ${state.after.length ? "AND (frame_time_seconds,matchup_id)>(?,?)" : ""}
    ORDER BY frame_time_seconds,matchup_id LIMIT ?`,
    id,
    state.clips,
    ...state.after,
    limit + 1,
  );
  const resultPage = await page(env, state, result, limit, (row) => [
    row.frame_time_seconds,
    row.matchup_id,
  ]);
  return {
    ...resultPage,
    items: resultPage.items.map((row) => ({
      id: row.matchup_id,
      timestampSeconds: row.frame_time_seconds,
      username: row.username,
      rank: row.rank,
    })),
  };
}
async function playback(env: Env, url: URL, id: number): Promise<Playback> {
  parameters(url, []);
  const row = await getVideo(env, id);
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
  const timelineURL = new URL(`${prefix}/videos/${id}/timeline?limit=100`, url);
  return {
    video: video(row),
    player: player(row),
    chapters,
    processing: {
      status: row.status,
      eligibleRanges,
      completedRanges,
      remainingRanges: normalizeRanges(
        missingChunks(eligibleRanges, completedRanges).flat(),
        row.duration_seconds,
      ),
    },
    timeline: await timeline(env, timelineURL, id),
  };
}
async function detail(env: Env, url: URL, id: number): Promise<MatchupDetail> {
  parameters(url, []);
  const row = await one<MatchupRow>(
    env,
    "SELECT *,1.0 AS score,0 AS exact FROM public_matchups WHERE matchup_id=?",
    id,
  );
  if (!row) throw new HttpError(404, "Matchup not available");
  const group = await one<{ matchup_id: string }>(
    env,
    "SELECT matchup_id FROM clip_appearances WHERE clip_id=?",
    id,
  );
  const appearances = group
    ? await rows<MatchupRow>(
        env,
        `SELECT m.*,1.0 AS score,0 AS exact FROM public_matchups m JOIN clip_appearances a ON a.clip_id=m.matchup_id
    WHERE a.matchup_id=? ORDER BY m.matchup_id LIMIT 50`,
        group.matchup_id,
      )
    : [row];
  return {
    matchup: matchup(row),
    groupId: group?.matchup_id ?? null,
    appearances: appearances.map(matchup),
  };
}
/** Recognize only explicit public contracts; social/auth routes keep their private behavior. */
export function nativePath(path: string) {
  return /^\/api\/v1\/(search|creators(?:\/(?:resolve|quality))?|videos(?:\/resolve|\/[1-9]\d*\/(?:playback|timeline))?|matchups\/[1-9]\d*|stats|platforms|streamers(?:\/[1-9]\d{0,15})?)$/.test(
    path,
  );
}
/** Dispatch the native public API without allowing arbitrary table/column access. */
async function nativeLoad(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET")
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: "GET" } },
    );
  const url = new URL(req.url),
    path = url.pathname.slice(prefix.length);
  let result: unknown;
  if (path === "/search") result = await search(env, url);
  else if (path === "/platforms") {
    parameters(url, []);
    result = {
      items: listPlatforms().map(({ id, name, mark, capabilities, embed }) => ({ id, name, mark, capabilities, embed })),
      nextCursor: null,
    };
  } else if (path === "/streamers") {
    const limit = parameters(url, ["cursor", "limit"]),
      state = await boundary(env, url);
    const found = await listStreamers(env, { after: Number(state.after[0] ?? 0), limit: limit + 1 });
    result = await page(env, state, found, limit, (row) => [row.id]);
    result = { ...(result as object), items: (result as { items: Streamer[] }).items.map(publicStreamer) };
  } else if (/^\/streamers\/[1-9]\d{0,15}$/.test(path)) {
    parameters(url, []);
    result = publicStreamer(await resolveStreamer(env, Number(path.split("/")[2])));
  } else if (path === "/creators") result = await creators(env, url);
  else if (path === "/videos") result = await videos(env, url);
  else if (path === "/videos/resolve") {
    parameters(url, ["source", "sourceId"]);
    filters(url, "v");
    requireValue(
      url.searchParams.has("source") &&
        (url.searchParams.get("sourceId")?.length ?? 0) <= 200 &&
        !!url.searchParams.get("sourceId"),
      "Source and sourceId required",
    );
    const row = await one<VideoRow>(
      env,
      `SELECT v.*,${videoCount} FROM public_videos v WHERE source=? AND source_id=?`,
      url.searchParams.get("source"),
      url.searchParams.get("sourceId"),
    );
    if (!row) throw new HttpError(404, "Video not found");
    result = video(row);
  } else if (path === "/creators/resolve") {
    parameters(url, ["source", "name"]);
    requireValue(
      url.searchParams.get("source") === "twitch",
      "Legacy creator resolution only supports Twitch",
    );
    const name = url.searchParams.get("name") ?? "";
    requireValue(name.length > 0 && name.length <= 200, "Invalid creator name");
    const found = await rows<VideoRow>(
      env,
      `SELECT DISTINCT creator_id,source,creator_source_id,creator_name,creator_login,creator_avatar FROM public_videos
      WHERE source='twitch' AND (creator_login=? COLLATE NOCASE OR creator_name=? COLLATE NOCASE) LIMIT 2`,
      name,
      name,
    );
    if (!found.length) throw new HttpError(404, "Creator not found");
    if (found.length > 1)
      throw new HttpError(409, "Ambiguous creator; use its ID");
    result = creator(found[0]);
  } else if (path === "/creators/quality") {
    const limit = parameters(url, ["cursor", "limit"]),
      state = await boundary(env, url);
    const found = await rows<{
      login: string;
      displayName: string;
      averageConfidence: number;
    }>(
      env,
      `SELECT login,display_name AS displayName,avg_confidence AS averageConfidence FROM streamer_detection_stats
      WHERE avg_confidence<0.5 ${state.after.length ? "AND login>?" : ""} ORDER BY login LIMIT ?`,
      ...state.after,
      limit + 1,
    );
    result = await page(env, state, found, limit, (row) => [row.login]);
  } else if (path === "/stats") {
    parameters(url, []);
    result = await one<Stats>(
      env,
      "SELECT count(*) AS matchups,count(DISTINCT vod_id) AS videos,count(DISTINCT creator_id) AS creators FROM public_matchups",
    );
  } else {
    const match = path.match(
      /^\/(videos|matchups)\/(\d+)(?:\/(playback|timeline))?$/,
    )!;
    const id = idValue(match[2]);
    result =
      match[1] === "matchups"
        ? await detail(env, url, id)
        : match[3] === "playback"
          ? await playback(env, url, id)
          : (await getVideo(env, id), await timeline(env, url, id));
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
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
  cacheUrl.searchParams.set(
    "native-revision",
    `${state.revision}:${state.clips}:${state.videos}`,
  );
  const response = await publicCache(
    new Request(cacheUrl, req),
    env,
    async () => {
      const result = await nativeLoad(req, env);
      await unchanged(env, state);
      return result;
    },
  );
  await unchanged(env, state);
  return response;
}
