import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../index";
import { one, rows, statement } from "../http";
import { claim, dispatch, recover, resolveInputs } from "../processing";
import { authEnv, ORIGIN } from "./auth-fixture";

const RUNTIME = "ghcr.io/liftaris/bazaar-ghost/sfde-next@sha256:" + "c".repeat(64);
const hosted = () => ({ ...authEnv(), GITHUB_TOKEN: "test-only", SFDE_RUNTIME_IMAGE: RUNTIME, BUILD_COMMIT: "d".repeat(40) });
const github = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://api.github.com/"));
const sent = (index = 0) => JSON.parse(String(github()[index][1]!.body));

function stubGitHub(status = 204) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("https://api.github.com/")) return new Response(null, { status });
    throw new Error("Unexpected outbound request: " + String(input));
  }));
}
async function run(chunkId: string) {
  return one(env, "SELECT * FROM chunk_runs WHERE chunk_id=? ORDER BY queued_at DESC LIMIT 1", chunkId);
}
async function processor(path: string, method: string, data: unknown, token?: string) {
  return worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: { Authorization: `Bearer ${env.PROCESSOR_KEY}`, "Content-Type": "application/json", ...(token ? { "X-Claim-Token": token } : {}) },
    body: JSON.stringify(data),
  }), hosted());
}
async function queued(vodId = 10) {
  stubGitHub();
  const { chunkIds } = await dispatch(hosted(), vodId);
  const chunk = await one<{ id: string; queued_at: string }>(env, "SELECT id,queued_at FROM chunks WHERE id=?", chunkIds[0]);
  return chunk!;
}

beforeEach(async () => {
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'default','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'example','Example')"),
    statement(env, `INSERT INTO vods(id,streamer_id,source,source_id,title,duration_seconds,published_at,bazaar_chapters,ready_for_processing)
      VALUES(10,1,'twitch','1001','First',600,'2026-10-01T00:00:00.000Z','[0,600]',1)`),
    statement(env, `INSERT INTO vods(id,streamer_id,source,source_id,title,duration_seconds,published_at,bazaar_chapters,ready_for_processing)
      VALUES(11,1,'twitch','1002','Second',600,'2026-10-02T00:00:00.000Z','[0,600]',1)`),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("queues one run per chunk in the dispatch transaction and completes it from the claimed runner", async () => {
  const chunk = await queued();
  expect(await run(chunk.id)).toMatchObject({
    vod_id: 10, origin: "operator", requested_by: null, status: "queued", queued_at: chunk.queued_at, claim_token: null,
  });
  expect(JSON.parse((await run(chunk.id))!.inputs)).toEqual({ mode: "legacy", quality: "480p", runtime_image: RUNTIME });
  expect(sent().inputs).toMatchObject({ quality: "480p", runtime_image: RUNTIME, sfde_profile: expect.any(String) });

  const claimed = await processor(`/api/processor/chunks/${chunk.id}/claim`, "POST", {
    queued_at: chunk.queued_at, processor_mode: "next", expected_old_templates: false, github_run_id: 18000000001, github_run_attempt: 2,
  });
  const { claim_token: token } = await claimed.json<{ claim_token: string }>();
  expect(await run(chunk.id)).toMatchObject({ status: "processing", claim_token: token, github_run_id: 18000000001, github_run_attempt: 2 });

  const done = await processor(`/api/processor/chunks/${chunk.id}`, "PATCH", { status: "completed", frames_processed: 900, detections_count: 4 }, token);
  expect(done.status).toBe(200);
  const finished = await run(chunk.id);
  expect(finished).toMatchObject({ status: "completed", frames_processed: 900, detections_count: 4, error: null });
  expect(finished!.finished_at).toBe((await one(env, "SELECT updated_at FROM chunks WHERE id=?", chunk.id))!.updated_at);
});

it("records failure, unclaimed dispatch failure and lease expiry on the run", async () => {
  const failing = await queued();
  const token = (await claim(env, failing.id, failing.queued_at)).claim_token!;
  await processor(`/api/processor/chunks/${failing.id}`, "PATCH", { status: "failed", error: "decoder crashed" }, token);
  expect(await run(failing.id)).toMatchObject({ status: "failed", error: "decoder crashed", github_run_id: null });

  const unclaimed = await queued(11);
  const response = await processor("/api/processor/fail-queued", "POST", { ids: [unclaimed.id], queued_at: unclaimed.queued_at, error: "Workflow preparation failed" });
  expect(await response.json()).toEqual({ updated: 1 });
  expect(await run(unclaimed.id)).toMatchObject({ status: "failed", error: "Workflow preparation failed" });

  await statement(env, "UPDATE chunks SET status='pending',attempt_count=0 WHERE id=?", unclaimed.id).run();
  const leased = await queued(11);
  await claim(env, leased.id, leased.queued_at);
  await statement(env, "UPDATE chunks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", leased.id).run();
  await recover(env);
  expect(await run(leased.id)).toMatchObject({ status: "expired", error: "Lease expired" });
  expect((await one(env, "SELECT status FROM chunks WHERE id=?", leased.id))!.status).toBe("pending");
  expect((await rows(env, "SELECT status FROM chunk_runs WHERE chunk_id=? ORDER BY queued_at", leased.id)).map((r) => r.status)).toEqual(["failed", "expired"]);
});

it("marks runs dispatch_failed in the batch that releases their chunks", async () => {
  stubGitHub(500);
  await expect(dispatch(hosted(), 10)).rejects.toThrow("500");
  const [chunk] = await rows(env, "SELECT id,status,queued_at FROM chunks WHERE vod_id=10");
  expect(chunk).toMatchObject({ status: "pending", queued_at: null });
  expect(await run(chunk.id)).toMatchObject({ status: "dispatch_failed", error: expect.stringContaining("500"), finished_at: expect.any(String) });
});

it("rejects malformed GitHub run identities on claim and leaves a claim without a dispatch time unrecorded", async () => {
  const chunk = await queued();
  for (const github_run_id of [0, -1, "x", 1.5]) {
    const response = await processor(`/api/processor/chunks/${chunk.id}/claim`, "POST", { queued_at: chunk.queued_at, github_run_id });
    expect(response.status).toBe(400);
  }
  expect((await claim(env, chunk.id, null, undefined, { runId: 7 })).claimed).toBe(true);
  expect(await run(chunk.id)).toMatchObject({ status: "queued", github_run_id: null });
});

it("resolves run inputs from one table of environment rules", () => {
  expect(resolveInputs(hosted(), {}, true)).toEqual({ mode: "next", quality: "480p", runtime_image: RUNTIME });
  expect(resolveInputs(hosted(), { quality: "1080p60", runtime_image: null })).toEqual({ mode: "legacy", quality: "1080p60", runtime_image: null });
  const production = { ...hosted(), ENVIRONMENT: "production" };
  expect(resolveInputs(production, {}, true)).toEqual({ mode: "legacy", quality: "480p", runtime_image: null });
  expect(resolveInputs(production, { runtime_image: null })).toEqual({ mode: "legacy", quality: "480p", runtime_image: null });
  for (const [environment, inputs] of [
    [production, { mode: "next" }],
    [production, { runtime_image: RUNTIME }],
    [hosted(), { quality: "best" }],
    [hosted(), { quality: "720p48" }],
    [hosted(), { runtime_image: "ghcr.io/other/image:latest" }],
    [hosted(), { profile: 2 }],
    [hosted(), []],
  ] as const) expect(() => resolveInputs(environment, inputs)).toThrow();
});
