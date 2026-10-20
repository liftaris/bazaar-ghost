import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  MatchupDetail,
  Matchup,
  Page,
  Playback,
  Video,
} from "../../contracts/public-api";
import { rows, statement } from "../http";
import { trigrams } from "../search";
import { linkAppearances } from "../appearances";
import { boundary } from "../native-cursor";
import { nativeRoute } from "../native-api";

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await env.DB.exec(
    "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]'); INSERT INTO streamers(id,login,display_name) VALUES(1,'example','Example');",
  );
  for (const id of [1, 2]) {
    await statement(
      env,
      "INSERT INTO vods(id,streamer_id,source_id,title,duration_seconds,bazaar_chapters) VALUES(?,1,?,'Video',10000,'[0,10000]')",
      id,
      String(id + 100),
    ).run();
    await statement(
      env,
      "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,?,0,10000,0)",
      `chunk${id}`,
      id,
    ).run();
  }
});
async function evidence(time: number, name = "Opponent", vod = 1) {
  const normalized = name.toLowerCase(),
    grams = trigrams(name),
    id = crypto.randomUUID();
  await statement(
    env,
    "INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,?)",
    normalized,
    grams.length,
  ).run();
  await env.DB.batch(
    grams.map((gram) =>
      statement(
        env,
        "INSERT OR IGNORE INTO search_grams(gram,name) VALUES(?,?)",
        gram,
        normalized,
      ),
    ),
  );
  await statement(
    env,
    "INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,created_at) VALUES(?,?,?,?,?,0.95,?,'2026-10-01T00:00:00Z')",
    id,
    `chunk${vod}`,
    vod,
    name,
    normalized,
    time,
  ).run();
  return id;
}
async function get<T>(path: string): Promise<T> {
  const response = await SELF.fetch(`https://local/api/v1${path}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<T>();
}
it("returns domain cards with exact-first ranking, independent OCR confidence and creator identity", async () => {
  await evidence(1, "Opponentx");
  await evidence(2);
  const result = await get<Page<Matchup>>("/search?type=matchups&q=Opponent");
  expect(result.items.map((item) => item.detection.username)).toEqual([
    "Opponent",
    "Opponentx",
  ]);
  expect(result.items[0].relevance).toEqual({ score: 1, exact: true });
  expect(result.items[0].detection.confidence).toBe(0.95);
  expect(result.items[0].video.creator.id).toBe("twitch:1");
  expect(result.items[0].id).toBeGreaterThan(0);
  expect(result.nextCursor).toBeNull();
});
it("uses deterministic cursors with no duplicates while new detections arrive", async () => {
  for (let i = 0; i < 5; i++) await evidence(i);
  const first = await get<Page<Matchup>>("/search?limit=2");
  await evidence(9);
  const second = await get<Page<Matchup>>(
    `/search?limit=2&cursor=${first.nextCursor}`,
  );
  const last = await get<Page<Matchup>>(
    `/search?limit=2&cursor=${second.nextCursor}`,
  );
  expect(
    new Set(
      [...first.items, ...second.items, ...last.items].map((row) => row.id),
    ).size,
  ).toBe(5);
  expect(last.nextCursor).toBeNull();
});
it("rejects tampered and cross-query cursors", async () => {
  await evidence(1);
  await evidence(2);
  const first = await get<Page<Matchup>>("/search?limit=1");
  for (const path of [
    `/search?cursor=${first.nextCursor}x`,
    `/search?q=other&cursor=${first.nextCursor}`,
    "/search?cursor=garbage",
  ])
    expect((await SELF.fetch(`https://local/api/v1${path}`)).status).toBe(400);
});
it("expires signed result boundaries after fifteen minutes", async () => {
  await evidence(1);
  await evidence(2);
  const first = await get<Page<Matchup>>("/search?limit=1");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 901_000);
  await expect(
    boundary(
      env,
      new URL(`https://local/api/v1/search?cursor=${first.nextCursor}`),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("uses normalized Unicode names rather than SQLite's ASCII-only lower()", async () => {
  await evidence(1, "ÉNDÉR");
  const result = await get<Page<Matchup>>("/search?q=%C3%A9nd%C3%A9r");
  expect(result.items[0].relevance).toEqual({ exact: true, score: 1 });
});
it("checks moderation even after warming the public payload cache", async () => {
  await evidence(1);
  const visible = (await get<Page<Matchup>>("/search")).items[0];
  const request = new Request(
    `https://cache-test.local/api/v1/matchups/${visible.id}`,
  );
  const hosted = { ...env, ENVIRONMENT: "validation" };
  expect((await nativeRoute(request, hosted)).status).toBe(200);
  expect((await nativeRoute(request, hosted)).status).toBe(200);
  await statement(
    env,
    "UPDATE matchups SET status='hidden' WHERE id=?",
    visible.id,
  ).run();
  await expect(nativeRoute(request, hosted)).rejects.toMatchObject({
    status: 404,
  });
});
it("returns platform-neutral cards and player capabilities for a YouTube upload", async () => {
  const account = crypto.randomUUID();
  await statement(
    env,
    "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES(?,'youtube','UCfixture','Video creator')",
    account,
  ).run();
  await statement(
    env,
    "INSERT INTO vods(id,source,source_id,platform_account_id,title,duration_seconds,bazaar_chapters,content_kind) VALUES(3,'youtube','AbCdeF01234',?,'Upload',300,'[0,300]','upload')",
    account,
  ).run();
  await statement(
    env,
    "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('chunk3',3,0,300,0)",
  ).run();
  await evidence(20, "Opponent", 3);
  const found = await get<Page<Matchup>>(
    `/search?source=youtube&creatorId=youtube:${account}`,
  );
  expect(found.items).toHaveLength(1);
  expect(found.items[0].video.creator).toMatchObject({
    id: `youtube:${account}`,
    platform: "youtube",
    sourceId: "UCfixture",
  });
  const playback = await get<Playback>("/videos/3/playback");
  expect(playback.player).toMatchObject({
    platform: "youtube",
    sourceId: "AbCdeF01234",
    embedUrl: "https://www.youtube.com/embed/AbCdeF01234",
    available: true,
  });
  expect(playback.timeline.items[0].id).toBe(found.items[0].id);
  expect(
    (await get<Video>("/videos/resolve?source=youtube&sourceId=AbCdeF01234"))
      .id,
  ).toBe(3);
});
it("invalidates continuations on corrections and preserves the shared matchup ID", async () => {
  const old = await evidence(1);
  await evidence(2);
  const first = await get<Page<Matchup>>("/search?limit=1");
  const before = (await get<Page<Matchup>>("/search")).items.find(
    (row) => row.detection.id === old,
  )!;
  await statement(env, "DELETE FROM detections WHERE id=?", old).run();
  expect(
    (await SELF.fetch(`https://local/api/v1/matchups/${before.id}`)).status,
  ).toBe(404);
  const replacement = await evidence(1, "Corrected");
  const after = await get<MatchupDetail>(`/matchups/${before.id}`);
  expect(after.matchup.detection.id).toBe(replacement);
  expect(after.matchup.detection.username).toBe("Corrected");
  expect(
    (await SELF.fetch(`https://local/api/v1/search?cursor=${first.nextCursor}`))
      .status,
  ).toBe(409);
});
it("retains verified appearance links through OCR replacement", async () => {
  const a = await evidence(1),
    b = await evidence(2, "Opponent", 2);
  await linkAppearances(env, {
    detection_ids: [a, b],
    evidence: "Verified the original footage and the board",
  });
  const first = (await get<Page<Matchup>>("/search")).items[0];
  await statement(env, "DELETE FROM detections WHERE id=?", a).run();
  await evidence(1, "Corrected");
  expect(
    (await get<MatchupDetail>(`/matchups/${first.id}`)).appearances,
  ).toHaveLength(2);
});
it("hides moderated evidence and never returns personal state in public cards", async () => {
  await evidence(1);
  const first = (await get<Page<Matchup>>("/search")).items[0];
  await statement(
    env,
    "UPDATE matchups SET status='hidden' WHERE id=?",
    first.id,
  ).run();
  expect((await get<Page<Matchup>>("/search")).items).toEqual([]);
  expect(
    (await SELF.fetch(`https://local/api/v1/matchups/${first.id}`)).status,
  ).toBe(404);
  expect((await get<Playback>("/videos/1/playback")).timeline.items).toEqual(
    [],
  );
});
it("returns unique video cards and distinguishes unprocessed coverage from zero matches", async () => {
  await evidence(1);
  await evidence(2);
  const result = await get<Page<Video>>("/videos?hasMatchups=true");
  expect(result.items).toHaveLength(1);
  expect(result.items[0].matchupCount).toBe(2);
  const playback = await get<Playback>("/videos/2/playback");
  expect(playback.timeline.items).toEqual([]);
  expect(playback.processing.completedRanges).toEqual([]);
  expect(playback.processing.remainingRanges).toEqual([[0, 10000]]);
  await statement(
    env,
    "UPDATE chunks SET status='completed' WHERE vod_id=2",
  ).run();
  expect(
    (await get<Playback>("/videos/2/playback")).processing.remainingRanges,
  ).toEqual([]);
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
  const playback = await get<Playback>("/videos/1/playback");
  let timeline = playback.timeline,
    total = timeline.items.length;
  const ids = new Set(timeline.items.map((item) => item.id));
  while (timeline.nextCursor) {
    timeline = await get<Playback["timeline"]>(
      `/videos/1/timeline?limit=100&cursor=${timeline.nextCursor}`,
    );
    total += timeline.items.length;
    timeline.items.forEach((item) => ids.add(item.id));
  }
  expect(total).toBe(1005);
  expect(ids.size).toBe(1005);
});
it("validates filters and leaves compatibility routes usable", async () => {
  for (const path of [
    "/search?limit=1001",
    "/search?limit=1&limit=2",
    "/search?source=invalid",
    "/videos?table=users",
    "/search?videoId=-1",
  ])
    expect((await SELF.fetch(`https://local/api/v1${path}`)).status).toBe(400);
  expect(
    (await SELF.fetch("https://local/rest/v1/streamers?select=login")).status,
  ).toBe(200);
  expect(await rows(env, "PRAGMA foreign_key_check")).toEqual([]);
});
