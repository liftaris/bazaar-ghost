import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpsChunkDetail, OpsOverview, OpsRecording, OpsRecordingDetail, OpsReprocessResponse } from "../../contracts/operator-api";
import type { Page } from "../../contracts/public-api";
import worker from "../index";
import { one, rows, statement } from "../http";
import { claim, dispatch, recover, resolveInputs } from "../processing";
import { authEnv, login, mockProviders, ORIGIN } from "./auth-fixture";

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

async function operator() {
  mockProviders();
  const signed = await login("discord");
  const grant = await worker.fetch(new Request(ORIGIN + `/api/admin/operators/${signed.identity.userId}`, {
    method: "PUT", headers: { Authorization: `Bearer ${env.ADMIN_KEY}` },
  }), authEnv());
  expect(grant.status).toBe(200);
  stubGitHub();
  return signed;
}
function reprocess(data: unknown, user: { cookie: string; identity: { csrfToken: string } } | null, csrf = user?.identity.csrfToken ?? "") {
  return worker.fetch(new Request(ORIGIN + "/api/v1/ops/reprocess", {
    method: "POST",
    headers: { Cookie: user?.cookie ?? "", Origin: ORIGIN, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(data),
  }), hosted());
}
async function read<T>(path: string, cookie: string) {
  const response = await worker.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie, Origin: ORIGIN } }), hosted());
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<T>();
}
async function failedChunks() {
  const ids: string[] = [];
  for (const vodId of [10, 11]) {
    const id = crypto.randomUUID();
    await statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,status,attempt_count,last_error,queued_at) VALUES(?,?,0,600,0,'failed',3,'decoder crashed','2026-10-20T00:00:00.000Z')",
      id, vodId).run();
    ids.push(id);
  }
  return ids;
}

it("requires an operator session and a CSRF token, and only accepts POST", async () => {
  const [id] = await failedChunks();
  expect((await reprocess({ chunk_ids: [id] }, null)).status).toBe(401);
  mockProviders();
  const user = await login("twitch");
  const forbidden = await reprocess({ chunk_ids: [id] }, user);
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({ error: "Operator access required" });
  const signed = await operator();
  const missing = await reprocess({ chunk_ids: [id] }, signed, "");
  expect(missing.status).toBe(403);
  expect(await missing.json()).toEqual({ error: "Invalid CSRF token" });
  expect((await worker.fetch(new Request(ORIGIN + "/api/v1/ops/reprocess", { headers: { Cookie: signed.cookie, Origin: ORIGIN } }), hosted())).status).toBe(405);
  expect((await reprocess({ chunk_ids: [id], extra: true }, signed)).status).toBe(400);
  expect((await reprocess({ chunk_ids: [] }, signed)).status).toBe(400);
  expect((await reprocess({ chunk_ids: Array.from({ length: 51 }, () => crypto.randomUUID()) }, signed)).status).toBe(400);
  expect(github()).toHaveLength(0);
});

it("returns the exact workflow payload on a dry run and writes nothing", async () => {
  const [id] = await failedChunks();
  const signed = await operator();
  const before = await rows(env, "SELECT * FROM chunks ORDER BY id");
  const response = await reprocess({ chunk_ids: [id.toUpperCase()], inputs: { quality: "720p" }, dry_run: true }, signed);
  expect(response.status, await response.clone().text()).toBe(200);
  const value = await response.json<OpsReprocessResponse>();
  expect(value).toEqual({
    dispatched: false,
    recordings: [{
      recordingId: 10,
      chunkIds: [id],
      runIds: [],
      payload: {
        ref: "migration/cloudflare",
        inputs: {
          vod_id: "1001", source: "twitch", chunk_uuids: JSON.stringify([id]), old_templates: "false", quality: "720p",
          sfde_profile: expect.any(String), runtime_image: RUNTIME, processor_revision: "d".repeat(40), environment: "validation",
        },
      },
    }],
  });
  expect(await rows(env, "SELECT * FROM chunks ORDER BY id")).toEqual(before);
  expect(await rows(env, "SELECT * FROM chunk_runs")).toEqual([]);
  expect(github()).toHaveLength(0);
});

it("refuses unknown and active chunks and ineligible recordings without writing", async () => {
  const [failed, other] = await failedChunks();
  const signed = await operator();
  const unknown = crypto.randomUUID();
  const notFound = await reprocess({ chunk_ids: [failed, unknown] }, signed);
  expect(notFound.status).toBe(404);
  expect((await notFound.json<{ error: string }>()).error).toContain(unknown);
  await statement(env, "UPDATE chunks SET status='queued' WHERE id=?", other).run();
  const active = await reprocess({ chunk_ids: [failed, other] }, signed);
  expect(active.status).toBe(409);
  expect(await active.json()).toEqual({ error: `Chunks already queued or processing: ${other}` });
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=10").run();
  const ineligible = await reprocess({ chunk_ids: [failed] }, signed);
  expect(ineligible.status).toBe(409);
  expect(await ineligible.json()).toEqual({ error: "Recording 10 is unavailable" });
  expect((await one(env, "SELECT status,attempt_count FROM chunks WHERE id=?", failed))).toEqual({ status: "failed", attempt_count: 3 });
  expect(github()).toHaveLength(0);
});

it("resets and dispatches each recording's chunks in its own workflow, recording the operator", async () => {
  const ids = await failedChunks();
  await statement(env, "UPDATE vods SET duration_seconds=1200,bazaar_chapters='[0,1200]' WHERE id=10").run();
  const signed = await operator();
  const response = await reprocess({ chunk_ids: ids, inputs: { mode: "legacy", quality: "360p" } }, signed);
  expect(response.status, await response.clone().text()).toBe(200);
  const value = await response.json<OpsReprocessResponse>();
  expect(value.dispatched).toBe(true);
  expect(value.recordings.map((r) => [r.recordingId, r.chunkIds])).toEqual([[10, [ids[0]]], [11, [ids[1]]]]);
  expect(github()).toHaveLength(2);
  for (const [index, recording] of value.recordings.entries()) {
    const payload = sent(index);
    expect(payload).toEqual(recording.payload);
    expect(JSON.parse(payload.inputs.chunk_uuids)).toEqual(recording.chunkIds);
    expect(payload.inputs).toMatchObject({ quality: "360p", sfde_profile: expect.any(String) });
    expect(payload.inputs.sfde_next).toBeUndefined();
    expect(JSON.parse(payload.inputs.sfde_profile).id).toBe(1);
    const stored = await rows(env, "SELECT id,origin,requested_by,status,queued_at FROM chunk_runs WHERE chunk_id=?", recording.chunkIds[0]);
    expect(stored).toEqual([{ id: recording.runIds[0], origin: "operator", requested_by: signed.identity.userId, status: "queued", queued_at: payload.inputs.queued_at }]);
  }
  expect(await rows(env, "SELECT status,attempt_count,last_error FROM chunks WHERE id IN(?,?)", ...ids))
    .toEqual([{ status: "queued", attempt_count: 0, last_error: null }, { status: "queued", attempt_count: 0, last_error: null }]);
  expect((await one(env, "SELECT status FROM chunks WHERE vod_id=10 AND id<>?", ids[0]))!.status).toBe("pending");
});

it("dispatches NEXT on request and lists runs newest first with the defaults for the next run", async () => {
  const [id] = await failedChunks();
  const signed = await operator();
  const first = await reprocess({ chunk_ids: [id], inputs: { mode: "next", quality: "720p60" } }, signed);
  expect(first.status, await first.clone().text()).toBe(200);
  expect(sent().inputs).toMatchObject({ sfde_next: "true", quality: "720p60" });
  expect(sent().inputs.sfde_profile).toBeUndefined();
  const token = (await claim(env, id, sent().inputs.queued_at, undefined, { runId: 42 })).claim_token!;
  await processor(`/api/processor/chunks/${id}`, "PATCH", { status: "completed", frames_processed: 10, detections_count: 0 }, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reprocess({ chunk_ids: [id] }, signed);

  const detail = await read<OpsChunkDetail>(`/api/v1/ops/chunks/${id}`, signed.cookie);
  expect(detail.runs.map((r) => [r.status, r.inputs.mode, r.inputs.quality])).toEqual([["queued", "legacy", "480p"], ["completed", "next", "720p60"]]);
  expect(detail.runs[1]).toMatchObject({
    origin: "operator", requestedBy: signed.identity.userId, framesProcessed: 10, detections: 0,
    githubRunUrl: "https://github.com/liftaris/bazaar-ghost/actions/runs/42", claimedAt: expect.any(String), finishedAt: expect.any(String),
  });
  expect(detail.runDefaults).toEqual({
    inputs: { mode: "legacy", quality: "480p", runtime_image: RUNTIME }, allowedModes: ["next", "legacy"], runtimeImageEditable: true,
  });
  const recording = await read<OpsRecordingDetail>("/api/v1/ops/recordings/10", signed.cookie);
  expect(recording.runs.map((r) => r.id)).toEqual(detail.runs.map((r) => r.id));
});

it("filters recordings by chunk status, matches source IDs, and targets every attention sample", async () => {
  const [failed] = await failedChunks();
  await statement(env, "UPDATE chunks SET status='completed' WHERE vod_id=11").run();
  const signed = await operator();
  const byChunk = await read<Page<OpsRecording>>("/api/v1/ops/recordings?chunkStatus=failed", signed.cookie);
  expect(byChunk.items.map((r) => r.id)).toEqual([10]);
  expect((await worker.fetch(new Request(ORIGIN + "/api/v1/ops/recordings?chunkStatus=done", { headers: { Cookie: signed.cookie, Origin: ORIGIN } }), hosted())).status).toBe(400);
  const bySource = await read<Page<OpsRecording>>("/api/v1/ops/recordings?q=1002", signed.cookie);
  expect(bySource.items.map((r) => r.id)).toEqual([11]);

  await env.DB.batch([
    statement(env, "INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,status,attempts,last_error,state) VALUES('job-fail','youtube','discovery','UCx','pending',4,'quota','{}')"),
    statement(env, "INSERT INTO twitch_catalog_work(streamer_id,state,due_at,attempt_count,last_error,updated_at) VALUES(1,'failed',0,5,'Helix 500',0)"),
    statement(env, "INSERT INTO platform_ingestion_dispatch(id,ticket_id,state,next_attempt_at,last_attempt_at,run_id,outcome) VALUES(1,'ticket','idle','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','42','failure')"),
  ]);
  const overview = await read<OpsOverview>("/api/v1/ops/overview", signed.cookie);
  const targets = Object.fromEntries(overview.attention.map((group) => [group.kind, group.samples.map((s) => s.target)]));
  expect(targets).toEqual({
    exhausted_chunk: [{ kind: "chunk", id: failed }],
    expired_lease: [],
    stale_queued: [],
    failing_ingestion: [{ kind: "ingestion_job", id: "job-fail" }],
    catalog_failed: [{ kind: "streamer", id: "1" }],
    dispatch_unconfirmed: [{ kind: "dispatch", id: "1" }],
  });
});
