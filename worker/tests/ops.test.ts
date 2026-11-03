import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpsChunkDetail, OpsDetection, OpsIngestion, OpsInventory, OpsOverview, OpsRecording, OpsRecordingDetail, OpsStreamer } from "../../contracts/operator-api";
import type { Page } from "../../contracts/public-api";
import worker from "../index";
import { statement } from "../http";
import { Twitch } from "../twitch";
import { authEnv, login, mockProviders, ORIGIN } from "./auth-fixture";

const YT = "00000000-0000-4000-8000-0000000000a1";
const CHUNK = {
  done: "00000000-0000-4000-8000-000000000001",
  failed: "00000000-0000-4000-8000-000000000002",
  leased: "00000000-0000-4000-8000-000000000003",
  queued: "00000000-0000-4000-8000-000000000004",
};
const DETECTION = "00000000-0000-4000-8000-0000000000d1";
const CLOCK = `1001/${CHUNK.done}/token/evidence_120000_clock.jpg`;
const FRAME = `1001/${CHUNK.done}/token/detection_120.jpg`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const observation = (image: string) => ({
  at_ms: 120_000, method: "template", confidence: 0.9, image_path: image, frame_sha256: "a".repeat(64), source_width: 1920,
  source_height: 1080, region: [0, 0, 1, 1], phase: "pre_fight", selection_reason: "best",
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'default','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'example','Example')"),
    statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES(?,'youtube','UCexample','Example YT')", YT),
    statement(env, "INSERT INTO channel_ownership(channel_id,streamer_id,method,actor) VALUES(?,1,'operator','test')", YT),
    statement(env, `INSERT INTO vods(id,streamer_id,source,source_id,title,duration_seconds,published_at,status,bazaar_chapters)
      VALUES(10,1,'twitch','1001','Twitch archive',3600,'2026-10-01T00:00:00.000Z','partial','[0,3600]')`),
    statement(env, `INSERT INTO vods(id,source,source_id,platform_account_id,title,duration_seconds,published_at,updated_at)
      VALUES(11,'youtube','abcdefg0011',?,'YouTube upload',1800,'2026-10-03T00:00:00.000Z',?)`, YT, ago(60)),
    statement(env, `INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,status,queued_at,started_at,completed_at,updated_at)
      VALUES(?,10,0,600,0,'completed',?,?,?,?)`, CHUNK.done, ago(30), ago(20), ago(10), ago(10)),
    statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,status,attempt_count,last_error,updated_at) VALUES(?,10,600,1200,1,'failed',3,'decoder crashed',?)",
      CHUNK.failed, ago(5)),
    statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,status,lease_expires_at,updated_at) VALUES(?,10,1200,1800,2,'processing',?,?)",
      CHUNK.leased, ago(1), ago(40)),
    statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,status,queued_at,updated_at) VALUES(?,10,1800,2400,3,'queued',?,?)",
      CHUNK.queued, ago(45), ago(45)),
    statement(env, `INSERT INTO detections(id,chunk_id,vod_id,frame_time_seconds,name_state,encounter_confidence,igd,storage_path,field_evidence)
      VALUES(?,?,10,120,'masked',0.8,7,?,?)`, DETECTION, CHUNK.done, FRAME, JSON.stringify({ encounter: observation(FRAME), igd: observation(CLOCK) })),
    statement(env, `INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,account_id,status,attempts,last_error,state,created_at) VALUES
      ('job-skip','youtube','video','abcdefg0099',?,'skipped',0,NULL,'{"reason":"No Bazaar title/tag evidence"}','2026-10-02T00:00:00.000Z'),
      ('job-done','youtube','video','abcdefg0011',?,'completed',0,NULL,'{}','2026-10-03T00:00:00.000Z'),
      ('job-fail','youtube','account','UCexample',?,'pending',4,'quota exceeded','{}','2026-10-04T00:00:00.000Z')`, YT, YT, YT),
    statement(env, "INSERT INTO twitch_catalog_work(streamer_id,state,due_at,attempt_count,last_error,updated_at) VALUES(1,'failed',1767225600000,5,'Helix 500',1767225600000)"),
    statement(env, `INSERT INTO platform_ingestion_dispatch(id,ticket_id,state,next_attempt_at,run_id,last_attempt_at,outcome)
      VALUES(1,'ticket','idle',?,'42',?,'delivery_unconfirmed')`, ago(0), ago(2)),
  ]);
  await statement(env, "UPDATE matchups SET status='hidden'").run();
  await env.DETECTIONS.put(CLOCK, new Uint8Array([255, 216, 255, 217]), { httpMetadata: { contentType: "image/jpeg" } });
});

const get = (path: string, cookie = "") =>
  worker.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie, Origin: ORIGIN } }), authEnv());
const admin = (method: string, path: string, data?: unknown) =>
  worker.fetch(new Request(ORIGIN + path, {
    method, headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), authEnv());
async function operator() {
  mockProviders();
  const signed = await login("discord");
  expect((await admin("PUT", `/api/admin/operators/${signed.identity.userId}`, { granted_by: "test" })).status).toBe(200);
  return signed.cookie;
}
async function read<T>(path: string, cookie: string): Promise<T> {
  const response = await get(path, cookie);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json();
}

it("requires a session, then an operator grant that the admin key controls", async () => {
  expect((await get("/api/v1/ops/overview")).status).toBe(401);
  mockProviders();
  const user = await login("twitch");
  const forbidden = await get("/api/v1/ops/overview", user.cookie);
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({ error: "Operator access required" });
  expect((await admin("PUT", "/api/admin/operators/missing-user")).status).toBe(404);
  const grant = await admin("PUT", `/api/admin/operators/${user.identity.userId}`);
  expect(await grant.json()).toMatchObject({ user_id: user.identity.userId, granted_by: "admin" });
  expect(await (await admin("GET", "/api/admin/operators")).json()).toEqual([expect.objectContaining({ user_id: user.identity.userId, name: "Fixture Twitch" })]);
  expect(await read("/api/v1/ops/me", user.cookie)).toEqual({ operator: true, userId: user.identity.userId });
  expect(await (await admin("DELETE", `/api/admin/operators/${user.identity.userId}`)).json()).toEqual({ user_id: user.identity.userId, revoked: true });
  expect((await get("/api/v1/ops/me", user.cookie)).status).toBe(403);
  expect((await worker.fetch(new Request(ORIGIN + "/api/admin/operators"), authEnv())).status).toBe(401);
});

it("rejects unknown query parameters, unknown routes and writes", async () => {
  const cookie = await operator();
  expect((await get("/api/v1/ops/recordings?bogus=1", cookie)).status).toBe(400);
  expect((await get("/api/v1/ops/overview?limit=5&x=1", cookie)).status).toBe(400);
  expect((await get("/api/v1/ops/recordings?status=nope", cookie)).status).toBe(400);
  expect((await get("/api/v1/ops/nothing", cookie)).status).toBe(404);
  const post = await worker.fetch(new Request(ORIGIN + "/api/v1/ops/overview", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } }), authEnv());
  expect(post.status).toBe(405);
});

it("summarizes every status, attention group, hourly throughput and timing", async () => {
  const value = await read<OpsOverview>("/api/v1/ops/overview", await operator());
  expect(value.chunks).toEqual({ pending: 0, queued: 1, processing: 1, completed: 1, failed: 1, archived: 0 });
  expect(value.recordings).toEqual({ pending: 1, processing: 0, completed: 0, partial: 1, failed: 0 });
  expect(value.ingestion).toEqual({ pending: 1, waiting: 0, processing: 0, completed: 1, skipped: 1 });
  const groups = Object.fromEntries(value.attention.map((group) => [group.kind, group]));
  expect(Object.keys(groups).sort()).toEqual(["catalog_failed", "dispatch_unconfirmed", "exhausted_chunk", "expired_lease", "failing_ingestion", "stale_queued"]);
  expect(groups.exhausted_chunk).toMatchObject({ count: 1, samples: [{ id: CHUNK.failed, recordingId: 10, error: "decoder crashed" }] });
  expect(groups.expired_lease.samples.map((s) => s.id)).toEqual([CHUNK.leased]);
  expect(groups.stale_queued.samples.map((s) => s.id)).toEqual([CHUNK.queued]);
  expect(groups.failing_ingestion).toMatchObject({ count: 1, samples: [{ id: "job-fail", recordingId: null, error: "quota exceeded" }] });
  expect(groups.catalog_failed).toMatchObject({ count: 1, samples: [{ id: "1", label: "Example", error: "Helix 500", at: "2026-01-01T00:00:00.000Z" }] });
  expect(groups.dispatch_unconfirmed).toMatchObject({ count: 1, samples: [{ label: "run 42", error: "delivery_unconfirmed" }] });
  expect(value.throughput).toHaveLength(24);
  expect(value.throughput.every((bucket) => bucket.hour.endsWith(":00:00.000Z"))).toBe(true);
  expect(value.throughput.reduce((sum, b) => sum + b.completed, 0)).toBe(1);
  expect(value.throughput.reduce((sum, b) => sum + b.failed, 0)).toBe(1);
  expect(value.timings.queueToClaimSeconds).toBeCloseTo(600, 0);
  expect(value.timings.claimToDoneSeconds).toBeCloseTo(600, 0);
});

it("pages recordings by latest activity without repeats and filters them", async () => {
  const cookie = await operator();
  const first = await read<Page<OpsRecording>>("/api/v1/ops/recordings?limit=1", cookie);
  expect(first.items.map((r) => r.id)).toEqual([10]);
  expect(first.items[0]).toMatchObject({
    platform: "twitch", url: "https://www.twitch.tv/videos/1001", status: "partial", profile: { id: 1, name: "default" },
    streamer: { id: 1, displayName: "Example" }, channel: { platform: "twitch", sourceId: "1" }, detections: 1,
    chunkCounts: { pending: 0, queued: 1, processing: 1, completed: 1, failed: 1, archived: 0 }, bazaarChapters: [0, 3600],
  });
  const second = await read<Page<OpsRecording>>(`/api/v1/ops/recordings?limit=1&cursor=${first.nextCursor}`, cookie);
  expect(second.items.map((r) => r.id)).toEqual([11]);
  expect(second.nextCursor).toBeNull();
  expect((await get(`/api/v1/ops/recordings?limit=1&platform=youtube&cursor=${first.nextCursor}`, cookie)).status).toBe(400);
  const ids = async (query: string) => (await read<Page<OpsRecording>>(`/api/v1/ops/recordings?${query}`, cookie)).items.map((r) => r.id);
  expect(await ids("status=attention")).toEqual([10]);
  expect(await ids("platform=youtube")).toEqual([11]);
  expect(await ids("q=0011")).toEqual([11]);
  expect(await ids("q=twitch%20ARCHIVE")).toEqual([10]);
  expect(await ids("streamerId=1")).toEqual([10, 11]);
  expect(await ids("status=pending")).toEqual([11]);
});

it("reads a recording and a chunk with their ordered chunks and detections", async () => {
  const cookie = await operator();
  const recording = await read<OpsRecordingDetail>("/api/v1/ops/recordings/10", cookie);
  const anchor = await env.DB.prepare("SELECT matchup_id FROM matchup_anchors WHERE current_detection_id=?").bind(DETECTION).first<{ matchup_id: number }>();
  expect(recording.chunks.map((c) => [c.index, c.id, c.status])).toEqual([
    [0, CHUNK.done, "completed"], [1, CHUNK.failed, "failed"], [2, CHUNK.leased, "processing"], [3, CHUNK.queued, "queued"],
  ]);
  expect(recording.chunks[1]).toMatchObject({ attempts: 3, lastError: "decoder crashed", recordingId: 10, startSeconds: 600, endSeconds: 1200 });
  expect(recording.detections).toEqual([{ id: DETECTION, chunkId: CHUNK.done, at: 120, username: null, nameState: "masked", rank: null,
    igd: 7, winsRemaining: null, ghostHero: null, streamerHero: null, matchupId: anchor!.matchup_id }]);
  const chunk = await read<OpsChunkDetail>(`/api/v1/ops/chunks/${CHUNK.done}`, cookie);
  expect(chunk.chunk.id).toBe(CHUNK.done);
  expect(chunk.recording.id).toBe(10);
  expect(chunk.detections.map((d) => d.id)).toEqual([DETECTION]);
  expect((await get(`/api/v1/ops/chunks/${CHUNK.failed}`, cookie)).status).toBe(200);
  expect((await get("/api/v1/ops/recordings/999", cookie)).status).toBe(404);
  expect((await get("/api/v1/ops/chunks/not-a-uuid", cookie)).status).toBe(400);
});

it("exposes every detection field and streams its hidden evidence images privately", async () => {
  const cookie = await operator();
  const value = await read<OpsDetection>(`/api/v1/ops/detections/${DETECTION}`, cookie);
  expect(value).toMatchObject({ id: DETECTION, recordingId: 10, encounterConfidence: 0.8, truncated: false, noRightEdge: false,
    screenshotUrl: `/api/v1/ops/images/${FRAME}`, sourceUrlAt: "https://www.twitch.tv/videos/1001?t=120s", igdCorrection: null });
  expect(value.fieldEvidence.igd).toMatchObject({ detectionId: DETECTION, method: "template", screenshotUrl: `/api/v1/ops/images/${CLOCK}` });
  expect(value.fieldEvidence.encounter?.screenshotUrl).toBe(`/api/v1/ops/images/${FRAME}`);
  expect((await get(`/detections/${CLOCK}`)).status).toBe(404);
  const image = await get(value.fieldEvidence.igd!.screenshotUrl!, cookie);
  expect(image.status).toBe(200);
  expect(image.headers.get("Content-Type")).toBe("image/jpeg");
  expect(image.headers.get("Cache-Control")).toBe("private, max-age=3600");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]));
  expect((await get(`/api/v1/ops/images/${CLOCK}`)).status).toBe(401);
  expect((await get(`/api/v1/ops/images/${FRAME}`, cookie)).status).toBe(404);
  expect((await get("/api/v1/ops/images/a%2F..%2Fb.jpg", cookie)).status).toBe(400);
  expect((await get("/api/v1/ops/images/%2Fabs.jpg", cookie)).status).toBe(400);
});

it("lists streamers with their channels and recording counts", async () => {
  const page = await read<Page<OpsStreamer>>("/api/v1/ops/streamers?q=exam", await operator());
  expect(page.items).toEqual([{
    id: 1, displayName: "Example", avatarUrl: null,
    channels: [{ id: expect.any(String), platform: "twitch", sourceId: "1", displayName: "Example" }, { id: YT, platform: "youtube", sourceId: "UCexample", displayName: "Example YT" }],
    recordings: 2, recordingCounts: { pending: 1, processing: 0, completed: 0, partial: 1, failed: 0 },
  }]);
});

it("joins live Twitch archives and YouTube ingestion jobs with our recordings", async () => {
  const cookie = await operator();
  const helix = vi.spyOn(Twitch.prototype, "helix").mockResolvedValue({ data: [
    { id: "1001", title: "Twitch archive", created_at: "2026-10-01T00:00:00Z", published_at: "2026-10-01T00:00:00Z", duration: "1h0m0s" },
    { id: "1002", title: "Not cataloged", created_at: "2026-10-05T00:00:00Z", published_at: "2026-10-05T00:00:00Z", duration: "2h3m4s" },
  ] });
  const value = await read<OpsInventory>("/api/v1/ops/streamers/1/inventory", cookie);
  expect(helix).toHaveBeenCalledWith("videos", { user_id: "1", type: "archive", first: "100" });
  const [twitch, youtube] = value.channels;
  expect(twitch).toMatchObject({ origin: "live", error: null });
  expect(twitch.items.map((i) => [i.sourceId, i.state, i.recordingId])).toEqual([["1002", "not_seen", null], ["1001", "partial", 10]]);
  expect(twitch.items[0]).toMatchObject({ url: "https://www.twitch.tv/videos/1002", durationSeconds: 7384, chunkCounts: null });
  expect(youtube).toMatchObject({ origin: "jobs", error: null });
  expect(youtube.items.map((i) => [i.sourceId, i.state, i.reason, i.recordingId])).toEqual([
    ["abcdefg0011", "cataloged", null, 11], ["abcdefg0099", "skipped", "No Bazaar title/tag evidence", null],
  ]);
  helix.mockRejectedValue(new Error("Upstream api.twitch.tv returned 500"));
  const failed = await read<OpsInventory>("/api/v1/ops/streamers/1/inventory", cookie);
  expect(failed.channels[0]).toMatchObject({ origin: "error", error: "Upstream api.twitch.tv returned 500" });
  expect(failed.channels[0].items.map((i) => [i.sourceId, i.state])).toEqual([["1001", "partial"]]);
  expect((await get("/api/v1/ops/streamers/999/inventory", cookie)).status).toBe(404);
});

it("reports platform switches, dispatch, catalog work and filtered ingestion jobs", async () => {
  const cookie = await operator();
  await statement(env, "UPDATE platform_settings SET notifications_enabled=0 WHERE source='bilibili'").run();
  const value = await read<OpsIngestion>("/api/v1/ops/ingestion?status=pending", cookie);
  expect(value.platforms.find((p) => p.platform === "bilibili")).toMatchObject({ ingestionEnabled: true, notificationsEnabled: false });
  expect(value.dispatch).toMatchObject({ state: "idle", outcome: "delivery_unconfirmed", runUrl: "https://github.com/liftaris/bazaar-ghost/actions/runs/42" });
  expect(value.catalog).toEqual([{ streamer: { id: 1, displayName: "Example", avatarUrl: null }, state: "failed", attempts: 5, lastError: "Helix 500", dueAt: "2026-01-01T00:00:00.000Z" }]);
  expect(value.jobs.items.map((j) => [j.id, j.status])).toEqual([["job-fail", "pending"]]);
  const all = await read<OpsIngestion>("/api/v1/ops/ingestion?platform=youtube&kind=video&limit=1", cookie);
  expect(all.jobs.items.map((j) => j.id)).toEqual(["job-done"]);
  const next = await read<OpsIngestion>(`/api/v1/ops/ingestion?platform=youtube&kind=video&limit=1&cursor=${all.jobs.nextCursor}`, cookie);
  expect(next.jobs.items.map((j) => [j.id, j.reason])).toEqual([["job-skip", "No Bazaar title/tag evidence"]]);
  expect(next.jobs.nextCursor).toBeNull();
  expect((await get("/api/v1/ops/ingestion?kind=nope", cookie)).status).toBe(400);
});
