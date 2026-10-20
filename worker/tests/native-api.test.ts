import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Evidence,
  MatchupDetail,
  MatchupResult,
  Page,
  Playback,
  Recording,
  RecordingSource,
  Session,
  SessionCard,
  Streamer,
  StreamerCard,
  ChannelLookup,
} from "../../contracts/public-api";
import { mergeMatchups } from "../coalesce";
import { one, rows, statement } from "../http";
import { trigrams } from "../search";
import { linkDetections } from "./link-fixture";
import { boundary } from "../native-cursor";
import { discord } from "../discord";
import { nativeRoute } from "../native-api";
import { registerPlatformsForTest, type PlatformEntry } from "../platform-registry";
import { mergeSessions, moveRecording } from "../sessions";
import { createStreamer, linkChannel } from "../streamers";
import { publicRevision } from "../visibility";

const how = { actor: "tester", evidence: "Reviewed the same fight in both recordings" };
const operator = { method: "operator", actor: "tester" };
const CH = { yt1: "00000000-0000-4000-8000-0000000000a1", yt2: "00000000-0000-4000-8000-0000000000a2", bb1: "00000000-0000-4000-8000-0000000000b1", kick1: "00000000-0000-4000-8000-0000000000c1", d1: "00000000-0000-4000-8000-0000000000d1", d2: "00000000-0000-4000-8000-0000000000d2" };
const UC = (c: string) => "UC" + c.repeat(22);

afterEach(() => {
  vi.restoreAllMocks();
  registerPlatformsForTest([]);
});

beforeEach(async () => {
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'example','Example')"),
    statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name,login) VALUES(?,'youtube',?,'Example YT','exampleyt'),(?,'youtube',?,'Reuploader','reup'),(?,'bilibili','12345','Example BB',NULL)", CH.yt1, UC("a"), CH.yt2, UC("b"), CH.bb1),
  ]);
  for (const id of [1, 2]) await vod({ id, source: "twitch" });
});

let counter = 100;
interface VodOptions {
  id?: number;
  source: "twitch" | "youtube" | "bilibili" | string;
  account?: string;
  availability?: string;
  recordedAt?: string;
  part?: { video: string; part: string; index: number };
}
async function vod(options: VodOptions) {
  const id = options.id ?? ++counter;
  const { source } = options;
  const sourceId = options.part
    ? `${options.part.video}:${options.part.part}`
    : source === "youtube"
      ? `abcdefg${String(id).padStart(4, "0")}`
      : String(id + 1000);
  await statement(
    env,
    `INSERT INTO vods(id,streamer_id,source,source_id,platform_account_id,title,duration_seconds,bazaar_chapters,availability,recorded_at,
      source_video_id,source_part_id,source_part_index)
    VALUES(?,?,?,?,?,?,10000,'[0,10000]',?,?,?,?,?)`,
    id,
    source === "twitch" ? 1 : null,
    source,
    sourceId,
    options.account ?? null,
    `Video ${id}`,
    options.availability ?? "available",
    options.recordedAt ?? null,
    options.part?.video ?? null,
    options.part?.part ?? null,
    options.part?.index ?? null,
  ).run();
  await statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,?,0,10000,0)", `chunk${id}`, id).run();
  return id;
}
async function evidence(time: number, name = "Opponent", vodId = 1, confidence = 0.95, created = "2026-10-01T00:00:00Z") {
  const normalized = name.toLowerCase(),
    grams = trigrams(name),
    id = crypto.randomUUID();
  await statement(env, "INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,?)", normalized, grams.length).run();
  await env.DB.batch(grams.map((gram) => statement(env, "INSERT OR IGNORE INTO search_grams(gram,name) VALUES(?,?)", gram, normalized)));
  await statement(
    env,
    "INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,rank,storage_path,created_at) VALUES(?,?,?,?,?,?,?,'gold','/detections/x.jpg',?)",
    id,
    `chunk${vodId}`,
    vodId,
    name,
    normalized,
    confidence,
    time,
    created,
  ).run();
  return id;
}
const sessionOf = async (vodId: number) => (await one<{ session_id: string }>(env, "SELECT session_id FROM vods WHERE id=?", vodId))!.session_id;
const together = async (a: number, b: number) => moveRecording(env, b, await sessionOf(a), 0, how);
async function get<T>(path: string): Promise<T> {
  const response = await SELF.fetch(`https://local/api/v1${path}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<T>();
}
const status = async (path: string) => (await SELF.fetch(`https://local/api/v1${path}`)).status;
async function ownedPair() {
  await linkChannel(env, 1, CH.yt1, operator);
  await linkChannel(env, 1, CH.bb1, operator);
}

it("returns one ranked row per Matchup with exact-first ordering, OCR confidence and the best-supported opponent", async () => {
  await evidence(1, "Opponentx");
  await evidence(2);
  const result = await get<Page<MatchupResult>>("/search?q=Opponent");
  expect(result.items.map((item) => item.opponent.username)).toEqual(["Opponent", "Opponentx"]);
  expect(result.items[0].relevance).toEqual({ score: 1, exact: true });
  expect(result.items[0].opponent).toMatchObject({ confidence: 0.95, rank: "gold" });
  expect(result.items[0].streamer).toMatchObject({ id: 1, displayName: "Example" });
  expect(result.items[0].sources).toHaveLength(1);
  expect(result.nextCursor).toBeNull();
});
it("lists a Matchup recorded in two platforms once, with both Sources", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(100, "Opponent", 1);
  await evidence(103, "Opponent", yt);
  await together(1, yt);
  const result = await get<Page<MatchupResult>>("/search");
  expect(result.items).toHaveLength(1);
  expect(result.items[0].sources.map((s) => [s.kind, s.platform, s.available])).toEqual([
    ["recording", "twitch", true],
    ["recording", "youtube", true],
  ]);
  const tw = result.items[0].sources[0];
  expect(tw).toMatchObject({ at: 100, isReupload: false, channel: { platform: "twitch", streamerId: 1 }, recording: { id: 1 } });
  expect(tw).toMatchObject({ kind: "recording", watchUrl: "https://www.twitch.tv/videos/1001?t=100s" });
  expect(result.items[0].sources[1]).toMatchObject({
    at: 103, watchUrl: `https://www.youtube.com/watch?v=abcdefg0${yt}&t=103s`, embedUrl: expect.stringContaining("start=103"),
  });
});
it("matches a Matchup through any of its contributing detections", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  const a = await evidence(100, "Alphaname", 1, 0.95);
  await evidence(100, "Betaname", yt, 0.9);
  const anchors = await rows<{ id: number }>(env, "SELECT id FROM matchup_anchors ORDER BY id");
  const { linkAnchors } = await import("../coalesce");
  await linkAnchors(env, anchors.map((r) => r.id), how);
  for (const q of ["alphaname", "betaname", "betan"]) {
    const found = await get<Page<MatchupResult>>(`/search?q=${q}`);
    expect(found.items, q).toHaveLength(1);
    expect(found.items[0].opponent.username).toBe("Alphaname");
    expect(found.items[0].sources).toHaveLength(2);
  }
  expect((await get<Page<MatchupResult>>("/search?q=betaname")).items[0].relevance.exact).toBe(true);
  expect(a).toBeTruthy();
});
it("orders Sources: available first, own before reuploads, confidence, then recording time", async () => {
  await ownedPair();
  const own = 1; // Twitch, owned
  const earlier = await vod({ source: "youtube", account: CH.yt1, recordedAt: "2026-01-01T00:00:00.000Z" });
  const bili = await vod({ source: "bilibili", account: CH.bb1, part: { video: "BV1abcdefghi", part: "555", index: 2 }, recordedAt: "2026-01-01T00:00:00.000Z" });
  const reupload = await vod({ source: "youtube", account: CH.yt2 });
  const gone = await vod({ source: "youtube", account: CH.yt1, availability: "unavailable" });
  await statement(env, "UPDATE vods SET recorded_at='2026-01-02T00:00:00.000Z' WHERE id=1").run();
  for (const [id, confidence] of [[own, 0.9], [earlier, 0.9], [bili, 0.8], [reupload, 0.99], [gone, 0.99]] as const)
    await evidence(100, "Opponent", id, confidence);
  for (const id of [earlier, bili, reupload, gone]) await together(own, id);
  const [row] = (await get<Page<MatchupResult>>("/search")).items;
  expect(row.sources.map((s) => (s.kind === "recording" ? s.recording.id : 0))).toEqual([earlier, own, bili, reupload, gone]);
  expect((row.sources as RecordingSource[]).map((s) => [s.isReupload, s.available])).toEqual([
    [false, true], [false, true], [false, true], [true, true], [false, false],
  ]);
  expect(row.opponent.confidence).toBe(0.99);
  const detail = await get<MatchupDetail>(`/matchups/${row.id}`);
  expect(detail.sources.map((s) => s.available)).toEqual([true, true, true, true, false]);
  expect(detail.detections).toHaveLength(5);
});
it("keeps the Bilibili part identity and part-relative timestamp", async () => {
  const part = await vod({ source: "bilibili", account: CH.bb1, part: { video: "BV1abcdefghi", part: "777", index: 3 } });
  await evidence(42, "Opponent", part);
  const [row] = (await get<Page<MatchupResult>>("/search?platform=bilibili")).items;
  expect(row.sources[0]).toMatchObject({
    platform: "bilibili", at: 42, recording: { id: part, sourceId: "BV1abcdefghi:777", partId: "777" },
    watchUrl: "https://www.bilibili.com/video/BV1abcdefghi/?p=3&t=42",
    embedUrl: "https://player.bilibili.com/player.html?bvid=BV1abcdefghi&cid=777&t=42",
  });
  expect((await get<Recording>("/recordings/lookup?platform=bilibili&sourceId=BV1abcdefghi%3A777")).partId).toBe("777");
});
it("filters by Streamer across Channels and reuploads attributed through the Session", async () => {
  await ownedPair();
  const mine = await vod({ source: "youtube", account: CH.yt1 });
  const bili = await vod({ source: "bilibili", account: CH.bb1, part: { video: "BV1abcdefghi", part: "555", index: 1 } });
  const reupload = await vod({ source: "youtube", account: CH.yt2 });
  const stranger = await vod({ source: "youtube", account: CH.yt2 });
  await together(1, reupload);
  await evidence(10, "Twitchfight", 1);
  await evidence(20, "Youtubefight", mine);
  await evidence(30, "Bilifight", bili);
  await evidence(40, "Reuploadfight", reupload);
  await evidence(50, "Strangerfight", stranger);
  const other = await createStreamer(env, { display_name: "Other" });
  const names = async (query: string) => (await get<Page<MatchupResult>>(`/search?${query}`)).items.map((i) => i.opponent.username).sort();
  expect(await names("streamerId=1")).toEqual(["Bilifight", "Reuploadfight", "Twitchfight", "Youtubefight"]);
  expect(await names(`streamerId=${other.id}`)).toEqual([]);
  const reuploaded = (await get<Page<MatchupResult>>("/search?q=reuploadfight")).items[0];
  expect(reuploaded.sources[0]).toMatchObject({ isReupload: true, channel: { id: CH.yt2, streamerId: null } });
  expect(reuploaded.streamer?.id).toBe(1);
});
it("filters by Channel, Recording and registry-validated platform, including a platform added without code changes", async () => {
  await ownedPair();
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(10, "Twitchfight", 1);
  await evidence(20, "Youtubefight", yt);
  const names = async (query: string) => (await get<Page<MatchupResult>>(`/search?${query}`)).items.map((i) => i.opponent.username);
  expect(await names(`channelId=${CH.yt1}`)).toEqual(["Youtubefight"]);
  expect(await names(`recordingId=${yt}`)).toEqual(["Youtubefight"]);
  expect(await names("platform=twitch")).toEqual(["Twitchfight"]);
  expect(await status("/search?platform=nope")).toBe(400);
  expect(await status("/search?channelId=not-a-channel")).toBe(400);
  expect(await status("/search?streamerId=0")).toBe(400);
  const kick: PlatformEntry = {
    id: "kick", name: "Kick", mark: "kick",
    recording: { idPattern: "^[0-9]{6}$", submissionPattern: "^[0-9]{6}$", parts: false, urlPatterns: [], watchUrl: "https://kick.example/vod/{id}",
      watchUrlAt: "https://kick.example/vod/{id}?t={t}", embedUrl: null, embedUrlAt: null, resolveUrl: "https://kick.example/vod/{id}",
      resolveUrlAt: "https://kick.example/vod/{id}?t={t}", timestampFormat: "seconds" },
    channel: { idPattern: "^[a-z]{3,10}$", urlPatterns: [], profileUrl: "https://kick.example/{id}" },
    clip: { idPattern: null, urlPatterns: [], watchUrl: null, embedUrl: null },
    capabilities: { seek: true, timeEvents: false, mute: true, fullscreen: true, swap: false, clips: false, createClip: false, clipParentRange: false, qualitySelectable: false },
    embed: { kind: "iframe", requires: [] },
    adapters: { catalog: null, ingestion: "kick", discovery: null, media: null, push: null },
  };
  registerPlatformsForTest([kick]);
  await env.DB.exec("INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('" + CH.kick1 + "','kick','someone','Someone')");
  const k = await vod({ source: "kick", account: CH.kick1 });
  await statement(env, "UPDATE vods SET source_id='123456' WHERE id=?", k).run();
  await evidence(5, "Kickfight", k);
  expect(await names("platform=kick")).toEqual(["Kickfight"]);
  expect((await get<Page<MatchupResult>>("/search?platform=kick")).items[0].sources[0]).toMatchObject({ platform: "kick", watchUrl: "https://kick.example/vod/123456?t=5" });
});
it("hides a Matchup while none of its Sources is available and restores it on recovery", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(100, "Opponent", 1);
  await evidence(100, "Opponent", yt);
  await together(1, yt);
  const id = (await get<Page<MatchupResult>>("/search")).items[0].id;
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=?", yt).run();
  let [row] = (await get<Page<MatchupResult>>("/search")).items;
  expect(row.sources.map((s) => s.available)).toEqual([true, false]);
  await statement(env, "UPDATE vods SET availability='expired' WHERE id=1").run();
  expect((await get<Page<MatchupResult>>("/search")).items).toEqual([]);
  expect(await status(`/matchups/${id}`)).toBe(404);
  expect((await get<{ matchups: number }>("/stats")).matchups).toBe(0);
  await statement(env, "UPDATE vods SET availability='available' WHERE id=?", yt).run();
  [row] = (await get<Page<MatchupResult>>("/search")).items;
  expect(row.sources.map((s) => [s.platform, s.available])).toEqual([["youtube", true], ["twitch", false]]);
  expect(row.id).toBe(id);
  expect((await get<{ matchups: number; recordings: number }>("/stats"))).toMatchObject({ matchups: 1, recordings: 1 });
});
it("resolves a retired Matchup ID to the canonical Matchup with redirectedFrom", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  const x = await evidence(100, "Opponent", 1);
  const y = await evidence(100, "Opponent", yt);
  expect([x, y]).toHaveLength(2);
  await together(1, yt);
  const anchors = await rows<{ id: number }>(env, "SELECT id FROM matchup_anchors ORDER BY id");
  const [low, high] = [anchors[0].id, anchors[1].id];
  const canonical = await get<MatchupDetail>(`/matchups/${low}`);
  expect(canonical.id).toBe(low);
  expect("redirectedFrom" in canonical).toBe(false);
  const retired = await get<MatchupDetail>(`/matchups/${high}`);
  expect(retired.id).toBe(low);
  expect(retired.redirectedFrom).toBe(high);
  expect(retired.detections.map((d) => d.id).sort()).toEqual([x, y].sort());
  expect(await status("/matchups/999999")).toBe(404);
});
it("serves evidence screenshots only for available Recordings", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(100, "Opponent", 1);
  await evidence(100, "Opponent", yt);
  await together(1, yt);
  await env.DETECTIONS.put("x.jpg", "jpeg");
  const id = (await get<Page<MatchupResult>>("/search")).items[0].id;
  let detail = await get<MatchupDetail>(`/matchups/${id}`);
  expect(detail.detections.map((d) => d.screenshotUrl)).toEqual(["/detections/x.jpg", "/detections/x.jpg"]);
  expect((await SELF.fetch("https://local/detections/x.jpg")).status).toBe(200);
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=?", yt).run();
  detail = await get<MatchupDetail>(`/matchups/${id}`);
  expect(detail.detections.map((d) => [d.recordingId, d.screenshotUrl === null])).toEqual([[1, false], [yt, true]]);
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=1").run();
  expect((await SELF.fetch("https://local/detections/x.jpg")).status).toBe(404);
});
it("restarts cursors after a merge or an availability change and bumps the cache revision on availability", async () => {
  for (let i = 0; i < 3; i++) await evidence(i * 100, `Fighter${i}`);
  const first = await get<Page<MatchupResult>>("/search?limit=1");
  const ids = (await rows<{ id: number }>(env, "SELECT id FROM matchups ORDER BY id")).map((r) => r.id);
  await mergeMatchups(env, ids[0], ids[1], how);
  expect(await status(`/search?limit=1&cursor=${first.nextCursor}`)).toBe(409);
  const before = await publicRevision(env);
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=2").run();
  expect(await publicRevision(env)).not.toBe(before);
});
it("uses deterministic cursors with no duplicates while new detections arrive", async () => {
  for (let i = 0; i < 5; i++) await evidence(i);
  const first = await get<Page<MatchupResult>>("/search?limit=2");
  await evidence(9);
  const second = await get<Page<MatchupResult>>(`/search?limit=2&cursor=${first.nextCursor}`);
  const last = await get<Page<MatchupResult>>(`/search?limit=2&cursor=${second.nextCursor}`);
  expect(new Set([...first.items, ...second.items, ...last.items].map((row) => row.id)).size).toBe(5);
  expect(last.nextCursor).toBeNull();
});
it("rejects tampered and cross-query cursors", async () => {
  await evidence(1);
  await evidence(2);
  const first = await get<Page<MatchupResult>>("/search?limit=1");
  for (const path of [`/search?cursor=${first.nextCursor}x`, `/search?q=other&cursor=${first.nextCursor}`, "/search?cursor=garbage"])
    expect(await status(path)).toBe(400);
});
it("expires signed result boundaries after fifteen minutes", async () => {
  await evidence(1);
  await evidence(2);
  const first = await get<Page<MatchupResult>>("/search?limit=1");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 901_000);
  await expect(boundary(env, new URL(`https://local/api/v1/search?cursor=${first.nextCursor}`))).rejects.toMatchObject({ status: 409 });
});
it("uses normalized Unicode names rather than SQLite's ASCII-only lower()", async () => {
  await evidence(1, "ÉNDÉR");
  const result = await get<Page<MatchupResult>>("/search?q=%C3%A9nd%C3%A9r");
  expect(result.items[0].relevance).toEqual({ exact: true, score: 1 });
});
it("checks moderation and availability even after warming the public payload cache", async () => {
  await evidence(1);
  const visible = (await get<Page<MatchupResult>>("/search")).items[0];
  const request = new Request(`https://cache-test.local/api/v1/matchups/${visible.id}`);
  const hosted = { ...env, ENVIRONMENT: "validation" };
  expect((await nativeRoute(request, hosted)).status).toBe(200);
  expect((await nativeRoute(request, hosted)).status).toBe(200);
  await statement(env, "UPDATE matchups SET status='hidden' WHERE id=?", visible.id).run();
  await expect(nativeRoute(request, hosted)).rejects.toMatchObject({ status: 404 });
  await statement(env, "UPDATE matchups SET status='visible' WHERE id=?", visible.id).run();
  expect((await nativeRoute(request, hosted)).status).toBe(200);
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=1").run();
  await expect(nativeRoute(request, hosted)).rejects.toMatchObject({ status: 404 });
});
it("returns platform-neutral Recordings, lookups and player capabilities for a YouTube upload", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt2 });
  await evidence(20, "Opponent", yt);
  const playback = await get<Playback>(`/recordings/${yt}/playback`);
  expect(playback.player).toMatchObject({ platform: "youtube", embedUrl: expect.stringContaining("/embed/"), available: true });
  expect(playback.recording).toMatchObject({ id: yt, platform: "youtube", channel: { id: CH.yt2, displayName: "Reuploader", login: "reup", streamerId: null }, matchupCount: 1 });
  const found = (await get<Page<MatchupResult>>("/search?platform=youtube")).items;
  expect(playback.timeline.items[0].id).toBe(found[0].id);
  const detections = await get<Page<Evidence>>(`/recordings/${yt}/detections`);
  expect(detections.items).toEqual([expect.objectContaining({ recordingId: yt, at: 20, username: "Opponent", rank: "gold", screenshotUrl: "/detections/x.jpg" })]);
  expect(await status("/recordings/999/detections")).toBe(404);
  const looked = await get<Recording>(`/recordings/lookup?platform=youtube&sourceId=${playback.recording.sourceId}`);
  expect(looked.id).toBe(yt);
  expect(await status("/recordings/lookup?platform=youtube&sourceId=missing")).toBe(404);
  expect(await status("/recordings/lookup?platform=nope&sourceId=x")).toBe(400);
});
it("resolves a Channel from a platform login to its Streamer", async () => {
  expect(await get<ChannelLookup>("/channels/lookup?platform=twitch&login=EXAMPLE")).toMatchObject({
    channel: { platform: "twitch", login: "example", streamerId: 1 }, streamer: { id: 1, displayName: "Example" },
  });
  expect(await get<ChannelLookup>("/channels/lookup?platform=youtube&login=reup")).toMatchObject({ channel: { id: CH.yt2 }, streamer: null });
  expect(await get<ChannelLookup>(`/channels/lookup?platform=youtube&sourceId=${UC("a")}`)).toMatchObject({ channel: { id: CH.yt1 } });
  await statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name,login) VALUES(?,'youtube',?,'Dup','dup'),(?,'youtube',?,'Dup','DUP')", CH.d1, UC("c"), CH.d2, UC("d")).run();
  expect(await status("/channels/lookup?platform=youtube&login=dup")).toBe(409);
  expect(await status("/channels/lookup?platform=youtube&login=missing")).toBe(404);
  expect(await status("/channels/lookup?platform=youtube")).toBe(400);
});
it("builds Channel URLs from the registry and serves a Channel by ID", async () => {
  expect(await get<ChannelLookup>("/channels/lookup?platform=twitch&login=example")).toMatchObject({ channel: { url: "https://www.twitch.tv/example" } });
  expect(await get<ChannelLookup>(`/channels/${CH.yt1}`)).toMatchObject({
    channel: { id: CH.yt1, url: `https://www.youtube.com/channel/${UC("a")}`, streamerId: null }, streamer: null,
  });
  expect((await get<ChannelLookup>(`/channels/${CH.bb1}`)).channel.url).toBe("https://space.bilibili.com/12345");
  expect(await status("/channels/00000000-0000-4000-8000-0000000000ff")).toBe(404);
  expect(await status("/channels/nope")).toBe(404);
});
it("filters by platform lists, excluded platforms and recorded time", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1, recordedAt: "2026-03-02T00:00:00Z" });
  const tw = await vod({ source: "twitch", recordedAt: "2026-03-10T00:00:00Z" });
  const yt2 = await vod({ source: "youtube", account: CH.yt1, recordedAt: "2026-03-10T00:00:00Z" });
  const bb = await vod({ source: "bilibili", account: CH.bb1, part: { video: "BV1abcdefghi", part: "555", index: 1 } });
  await evidence(10, "Twitchfight", tw);
  await evidence(20, "Youtubefight", yt);
  await evidence(30, "Bilifight", bb);
  await evidence(40, "Bothfight", tw);
  await evidence(43, "Bothfight", yt2);
  await together(tw, yt2);
  const names = async (query: string) => (await get<Page<MatchupResult>>(`/search?${query}`)).items.map((i) => i.opponent.username).sort();
  expect(await names("platform=youtube,bilibili")).toEqual(["Bilifight", "Bothfight", "Youtubefight"]);
  expect(await names("excludePlatform=twitch")).toEqual(["Bilifight", "Bothfight", "Youtubefight"]);
  expect(await names("excludePlatform=twitch,youtube")).toEqual(["Bilifight"]);
  expect(await names("platform=twitch&excludePlatform=youtube")).toEqual(["Bothfight", "Twitchfight"]);
  const both = (await get<Page<MatchupResult>>("/search?q=Bothfight&excludePlatform=twitch")).items[0];
  expect(both.sources.map((x) => x.platform)).toEqual(["twitch", "youtube"]);
  expect(await names("from=2026-03-05T00:00:00Z")).toEqual(["Bothfight", "Twitchfight"]);
  expect(await names("to=2026-03-05T00:00:00.000Z")).toEqual(["Youtubefight"]);
  expect(await names("from=2026-03-01&to=2026-03-31T23:59:59%2B00:00")).toEqual(["Bothfight", "Twitchfight", "Youtubefight"]);
  expect(await names("from=2026-03-01&to=2026-03-02")).toEqual([]);
  for (const bad of ["platform=nope", "platform=twitch,nope", "platform=", "excludePlatform=nope", "from=yesterday", "to=2026-13-45", "from=2026-03-01T00:00:00", "sort=time", "sort=asc&sessionId=" + "0".repeat(32), "sessionId=abc"])
    expect(await status(`/search?${bad}`), bad).toBe(400);
});
it("lists a Session's Matchups in session-time order in one long page", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(300, "Third", 1);
  await evidence(100, "First", 1);
  await evidence(200, "Second", yt);
  await evidence(250, "Other", 2);
  await moveRecording(env, yt, await sessionOf(1), 50, how);
  const id = await sessionOf(1);
  const order = async (query = "") => (await get<Page<MatchupResult>>(`/search?sessionId=${id}&sort=time${query}`)).items.map((i) => i.opponent.username);
  expect(await order()).toEqual(["First", "Second", "Third"]);
  expect(await order("&limit=500")).toEqual(["First", "Second", "Third"]);
  expect((await get<Page<MatchupResult>>(`/search?sessionId=${id}`)).items.map((i) => i.opponent.username).sort()).toEqual(["First", "Second", "Third"]);
  const first = await get<Page<MatchupResult>>(`/search?sessionId=${id}&sort=time&limit=2`);
  expect(first.items.map((i) => i.opponent.username)).toEqual(["First", "Second"]);
  const rest = await get<Page<MatchupResult>>(`/search?sessionId=${id}&sort=time&limit=2&cursor=${first.nextCursor}`);
  expect(rest.items.map((i) => i.opponent.username)).toEqual(["Third"]);
  expect(rest.nextCursor).toBeNull();
  expect(await status(`/search?sessionId=${id}&sort=time&limit=501`)).toBe(400);
  expect(await status("/search?limit=101")).toBe(400);
  expect((await get<Page<MatchupResult>>(`/search?sessionId=${"0".repeat(32)}&sort=time`)).items).toEqual([]);
});
it("lists Sessions as lean cards: searchable, filterable, newest first, pageable", async () => {
  await ownedPair();
  const mine = await vod({ source: "youtube", account: CH.yt1, recordedAt: "2026-03-02T00:00:00Z" });
  const reupload = await vod({ source: "youtube", account: CH.yt2, recordedAt: "2026-03-03T00:00:00Z" });
  const stranger = await vod({ source: "youtube", account: CH.yt2, recordedAt: "2026-02-01T00:00:00Z" });
  await statement(env, "UPDATE vods SET title='Unrelated stream' WHERE id=?", stranger).run();
  await statement(env, "UPDATE vods SET recorded_at='2026-03-01T00:00:00.000Z',title='Morning ladder' WHERE id=1").run();
  await evidence(100, "Opponent", 1);
  await evidence(200, "Opponent2", stranger);
  await together(1, reupload);
  await together(1, mine);
  const empty = await vod({ source: "youtube", account: CH.yt2, availability: "unavailable" });
  const home = await sessionOf(1);
  const list = await get<Page<SessionCard>>("/sessions");
  expect(list.items.map((s) => s.id)).toEqual([home, await sessionOf(stranger), await sessionOf(2)]);
  expect(list.items.map((s) => s.id)).not.toContain(await sessionOf(empty));
  expect(list.items[0]).toEqual({
    id: home,
    title: "Morning ladder",
    streamer: { id: 1, displayName: "Example", avatarUrl: null },
    channel: expect.objectContaining({ platform: "twitch", streamerId: 1 }),
    startedAt: "2026-03-01T00:00:00.000Z",
    durationSeconds: 10000,
    matchupCount: 1,
    platforms: ["twitch", "youtube"],
    defaultRecording: { id: 1, platform: "twitch" },
  });
  expect(list.items[1]).toMatchObject({ streamer: null, channel: { id: CH.yt2, streamerId: null }, title: "Unrelated stream", platforms: ["youtube"] });
  const ids = async (query: string) => (await get<Page<SessionCard>>(`/sessions?${query}`)).items.map((s) => s.id);
  expect(await ids("streamerId=1")).toEqual([home, await sessionOf(2)]);
  expect(await ids("streamerId=999")).toEqual([]);
  expect(await ids("platform=youtube")).toEqual([home, await sessionOf(stranger)]);
  expect(await ids("excludePlatform=youtube")).toEqual([home, await sessionOf(2)]);
  expect(await ids("platform=twitch&excludePlatform=twitch")).toEqual([home]);
  expect(await ids("platform=twitch&excludePlatform=twitch,youtube")).toEqual([]);
  expect((await get<Page<SessionCard>>("/sessions?platform=youtube")).items[0].defaultRecording).toEqual({ id: expect.any(Number), platform: "youtube" });
  expect(await ids("from=2026-02-15T00:00:00Z")).toEqual([home]);
  expect(await ids("to=2026-02-15T00:00:00Z")).toEqual([await sessionOf(stranger)]);
  expect(await ids("q=morning")).toEqual([home]);
  expect(await ids("q=EXAMPLE")).toEqual([home, await sessionOf(2)]);
  expect(await ids("q=reuploader")).toEqual([home, await sessionOf(stranger)]);
  expect(await ids("q=zzz")).toEqual([]);
  const one = await get<Page<SessionCard>>("/sessions?limit=1");
  expect(one.items.map((s) => s.id)).toEqual([home]);
  expect((await get<Page<SessionCard>>(`/sessions?limit=1&cursor=${one.nextCursor}`)).items[0].id).toBe(await sessionOf(stranger));
  expect(await status("/sessions?streamerId=abc")).toBe(400);
  expect(await status("/sessions?platform=nope")).toBe(400);
  expect(await status("/sessions?from=nope")).toBe(400);
  expect(await status("/sessions?recordingId=1")).toBe(400);
  expect((await get<Session>(`/sessions/${home}`)).recordings.map((r) => r.recording.id)).toEqual([1, mine, reupload]);
});
it("ranks Sessions and Streamers by exact, then prefix, then contains matches", async () => {
  const exact = await createStreamer(env, { display_name: "Kripp" });
  const prefix = await createStreamer(env, { display_name: "Kripparrian" });
  const inner = await createStreamer(env, { display_name: "Not Kripp Really" });
  for (const [streamer, matchups] of [[exact.id, 1], [prefix.id, 3], [inner.id, 5]] as const) {
    const account = crypto.randomUUID();
    await statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name,login) VALUES(?,'youtube',?,?,?)", account, UC(String(streamer).slice(-1).padEnd(1, "z")) + streamer, `chan${streamer}`, `login${streamer}`).run();
    await linkChannel(env, streamer, account, operator);
    const v = await vod({ source: "youtube", account, recordedAt: `2026-04-0${matchups}T00:00:00Z` });
    for (let i = 0; i < matchups; i++) await evidence(10 + i * 100, `Foe${streamer}x${i}`, v);
  }
  const ids = async (path: string) => (await get<Page<StreamerCard>>(path)).items.map((s) => s.id);
  expect(await ids("/streamers?q=kripp")).toEqual([exact.id, prefix.id, inner.id]);
  expect(await ids("/streamers")).toEqual([inner.id, prefix.id, exact.id, 1].filter((id) => id !== 1));
  const paged = await get<Page<StreamerCard>>("/streamers?q=kripp&limit=2");
  expect(paged.items.map((s) => s.id)).toEqual([exact.id, prefix.id]);
  expect((await get<Page<StreamerCard>>(`/streamers?q=kripp&limit=2&cursor=${paged.nextCursor}`)).items.map((s) => s.id)).toEqual([inner.id]);
  const sessions = async (query: string) => (await get<Page<SessionCard>>(`/sessions?${query}`)).items.map((s) => s.streamer?.id);
  expect(await sessions("q=kripp")).toEqual([exact.id, prefix.id, inner.id]);
});
it("lists Streamers that have public Matchups with counts and platforms, searchable by any Channel", async () => {
  await ownedPair();
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(20, "Opponent", yt);
  await evidence(30, "Another", 1);
  await createStreamer(env, { display_name: "Nobody" });
  const list = await get<Page<StreamerCard>>("/streamers");
  expect(list.items.map((s) => s.id)).toEqual([1]);
  expect(list.items[0]).toMatchObject({ sessionCount: 3, matchupCount: 2, platforms: ["twitch", "youtube"] });
  expect(list.items[0].channels.map((c) => [c.platform, c.streamerId]).sort()).toEqual([["bilibili", 1], ["twitch", 1], ["youtube", 1]]);
  expect((await get<Page<StreamerCard>>("/streamers?q=exampleyt")).items.map((s) => s.id)).toEqual([1]);
  expect((await get<Page<StreamerCard>>("/streamers?q=zzz")).items).toEqual([]);
  expect((await get<Page<StreamerCard>>("/streamers?platform=youtube")).items.map((s) => s.id)).toEqual([1]);
  expect((await get<Page<StreamerCard>>("/streamers?platform=bilibili")).items).toEqual([]);
  expect((await get<Page<StreamerCard>>("/streamers?excludePlatform=twitch,youtube")).items).toEqual([]);
  expect((await get<Page<StreamerCard>>("/streamers?excludePlatform=bilibili")).items.map((s) => s.id)).toEqual([1]);
  expect(await status("/streamers?platform=nope")).toBe(400);
  expect((await get<Streamer>("/streamers/1")).displayName).toBe("Example");
  expect(await status("/streamers/999")).toBe(404);
});
it("returns a Session with its Recordings and time mappings, following a merge", async () => {
  const yt = await vod({ source: "youtube", account: CH.yt1 });
  await evidence(100, "Opponent", 1);
  await moveRecording(env, yt, await sessionOf(1), 30, how);
  const id = await sessionOf(1);
  const session = await get<Session>(`/sessions/${id}`);
  expect(session.recordings.map((r) => [r.recording.id, r.segments[0].offsetSeconds])).toEqual([[1, 0], [yt, 30]]);
  expect(session).toMatchObject({ matchupCount: 1, streamer: { id: 1 } });
  const loser = await sessionOf(2);
  await mergeSessions(env, id, loser, 0, how);
  const merged = await get<Session>(`/sessions/${loser}`);
  expect(merged).toMatchObject({ id, redirectedFrom: loser });
  expect(await status("/sessions/" + "0".repeat(32))).toBe(404);
});
it("retains linked Matchups through OCR replacement", async () => {
  const a = await evidence(1),
    b = await evidence(2, "Opponent", 2);
  await linkDetections(env, [a, b], "Verified the original footage and the board");
  const first = (await get<Page<MatchupResult>>("/search")).items[0];
  expect(first.sources).toHaveLength(2);
  await statement(env, "DELETE FROM detections WHERE id=?", a).run();
  const replacement = await evidence(1, "Corrected");
  const detail = await get<MatchupDetail>(`/matchups/${first.id}`);
  expect(detail.sources).toHaveLength(2);
  expect(detail.detections.map((d) => d.id)).toContain(replacement);
});
it("returns unique Recording cards and distinguishes unprocessed coverage from zero matches", async () => {
  await evidence(1);
  await evidence(2);
  const result = await get<Page<Recording>>("/recordings?hasMatchups=true");
  expect(result.items).toHaveLength(1);
  expect(result.items[0].matchupCount).toBe(2);
  const playback = await get<Playback>("/recordings/2/playback");
  expect(playback.timeline.items).toEqual([]);
  expect(playback.processing.completedRanges).toEqual([]);
  expect(playback.processing.remainingRanges).toEqual([[0, 10000]]);
  await statement(env, "UPDATE chunks SET status='completed' WHERE vod_id=2").run();
  expect((await get<Playback>("/recordings/2/playback")).processing.remainingRanges).toEqual([]);
});
it("hides moderated evidence", async () => {
  await evidence(1);
  const first = (await get<Page<MatchupResult>>("/search")).items[0];
  await statement(env, "UPDATE matchups SET status='hidden' WHERE id=?", first.id).run();
  expect((await get<Page<MatchupResult>>("/search")).items).toEqual([]);
  expect(await status(`/matchups/${first.id}`)).toBe(404);
  expect((await get<Playback>("/recordings/1/playback")).timeline.items).toEqual([]);
});
it("invalidates continuations on corrections and preserves the shared Matchup ID", async () => {
  const old = await evidence(1);
  await evidence(2);
  const first = await get<Page<MatchupResult>>("/search?limit=1");
  const before = (await get<MatchupDetail>(`/matchups/${(await rows<{ id: number }>(env, "SELECT id FROM matchups ORDER BY id"))[0].id}`));
  await statement(env, "DELETE FROM detections WHERE id=?", old).run();
  expect(await status(`/matchups/${before.id}`)).toBe(404);
  const replacement = await evidence(1, "Corrected");
  const after = await get<MatchupDetail>(`/matchups/${before.id}`);
  expect(after.detections.map((d) => d.id)).toEqual([replacement]);
  expect(after.opponent.username).toBe("Corrected");
  expect(await status(`/search?cursor=${first.nextCursor}`)).toBe(409);
});
it("paginates every timeline marker beyond the old 1000-row ceiling", async () => {
  await evidence(0);
  for (let start = 1; start < 1005; start += 200) {
    await env.DB.batch(
      Array.from({ length: Math.min(200, 1005 - start) }, (_, i) =>
        statement(
          env,
          "INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds) VALUES(?,'chunk1',1,'Opponent','opponent',0.95,?)",
          crypto.randomUUID(),
          start + i,
        ),
      ),
    );
  }
  const playback = await get<Playback>("/recordings/1/playback");
  let timeline = playback.timeline,
    total = timeline.items.length;
  const ids = new Set(timeline.items.map((item) => item.id));
  while (timeline.nextCursor) {
    timeline = await get<Playback["timeline"]>(`/recordings/1/timeline?limit=100&cursor=${timeline.nextCursor}`);
    total += timeline.items.length;
    timeline.items.forEach((item) => ids.add(item.id));
  }
  expect(total).toBe(1005);
  expect(ids.size).toBe(1005);
});
it("validates filters and no longer serves the removed compatibility routes", async () => {
  for (const path of [
    "/search?limit=1001",
    "/search?limit=1&limit=2",
    "/search?source=youtube",
    "/search?videoId=1",
    "/recordings?table=users",
    "/recordings?recordingId=1",
    "/search?recordingId=-1",
  ])
    expect(await status(path), path).toBe(400);
  for (const path of ["/videos", "/creators", "/creators/resolve", "/videos/resolve", "/clips"])
    expect(await status(path), path).not.toBe(200);
  expect((await SELF.fetch("https://local/rest/v1/streamers?select=login")).status).toBe(401);
  expect(await rows(env, "PRAGMA foreign_key_check")).toEqual([]);
});

it("answers the Discord /search command with the same Matchups as the public search", async () => {
  await evidence(1, "Opponentx");
  await evidence(2);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
  const discordEnv = { ...env, DISCORD_PUBLIC_KEY: hex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), PUBLIC_SITE_URL: "https://site.example/" } as Env;
  const ask = async (username: string) => {
    const raw = JSON.stringify({ type: 2, id: "1", user: { id: "9" }, data: { name: "search", options: [{ name: "username", value: username }, { name: "results", value: "5" }] } }),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hex(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(timestamp + raw)));
    const response = await discord(new Request("http://local/discord", { method: "POST", headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp }, body: raw }), discordEnv);
    return (await response.json<any>()).data.content as string;
  };
  const items = (await get<Page<MatchupResult>>("/search?q=Opponent")).items;
  const lines = (await ask("Opponent")).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines.map((line) => line.match(/matchups\/(\d+)$/)![1])).toEqual(items.map((item) => String(item.id)));
  expect(lines[0]).toContain("**Example** vs **Opponent**");
  expect(lines[0]).toContain(`https://site.example/matchups/${items[0].id}`);
  expect(await ask("zzzzzz")).toBe("No results found for **zzzzzz**");
});
