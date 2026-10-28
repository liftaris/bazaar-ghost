import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpsChunkDetail, OpsOverview, OpsRecording, OpsRecordingDetail, OpsReprocessResponse, RunInputs } from "../../contracts/operator-api";
import type { Page } from "../../contracts/public-api";
import worker from "../index";
import { one, rows, statement } from "../http";
import { automaticRun, claim, dispatch, dispatchAutomatic, manualRun, operatorRun, queue, recover, resolveInputs, runDefaults, workflow, type RunRequest } from "../processing";
import { authEnv, login, mockProviders, ORIGIN } from "./auth-fixture";

const RUNTIME = "ghcr.io/liftaris/bazaar-ghost/sfde-next@sha256:" + "c".repeat(64);
const LEGACY: RunInputs = { mode: "legacy", quality: "480p", runtime_image: RUNTIME };
const hosted = () => ({ ...authEnv(), GITHUB_TOKEN: "test-only", SFDE_RUNTIME_IMAGE: RUNTIME, BUILD_COMMIT: "d".repeat(40) });
const github = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://api.github.com/"));
const sent = (index = 0) => JSON.parse(String(github()[index][1]!.body));
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function stubGitHub(...statuses: number[]) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("https://api.github.com/")) return new Response(null, { status: statuses[call++] ?? statuses.at(-1) ?? 204 });
    throw new Error("Unexpected outbound request: " + String(input));
  }));
}
const run = (chunkId: string) => one(env, "SELECT * FROM chunk_runs WHERE chunk_id=? ORDER BY queued_at DESC LIMIT 1", chunkId);
const chunkRow = (chunkId: string) =>
  one(env, "SELECT status,attempt_count,max_attempts,queued_at,last_error,frames_processed,detections_count,processing_duration_ms FROM chunks WHERE id=?", chunkId);
async function call(path: string, method: string, data: unknown, key: string, token?: string) {
  return worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(token ? { "X-Claim-Token": token } : {}) },
    body: JSON.stringify(data),
  }), hosted());
}
const processor = (path: string, method: string, data: unknown, token?: string) => call(path, method, data, env.PROCESSOR_KEY, token);
async function queued(vodId = 10, request: RunRequest = manualRun(hosted())) {
  stubGitHub();
  const chunkIds = await dispatch(hosted(), vodId, request);
  return (await one<{ id: string; queued_at: string }>(env, "SELECT id,queued_at FROM chunks WHERE id=?", chunkIds[0]))!;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("queues one run per chunk, stamps the GitHub run at prepare and claim, and completes it", async () => {
  const chunk = await queued();
  expect(await run(chunk.id)).toMatchObject({
    vod_id: 10, origin: "manual", requested_by: null, status: "queued", queued_at: chunk.queued_at, claim_token: null, prior_status: "pending", prior_max_attempts: 3,
  });
  expect(JSON.parse((await run(chunk.id))!.inputs)).toEqual(LEGACY);
  expect(sent().inputs).toMatchObject({ quality: "480p", runtime_image: RUNTIME, sfde_profile: expect.any(String) });

  const prepared = await processor("/api/processor/github-run", "POST", { ids: [chunk.id], queued_at: chunk.queued_at, github_run_id: 18000000001, github_run_attempt: 1 });
  expect(await prepared.json()).toEqual({ updated: 1 });
  expect(await run(chunk.id)).toMatchObject({ status: "queued", github_run_id: 18000000001, github_run_attempt: 1 });

  const claimed = await processor(`/api/processor/chunks/${chunk.id}/claim`, "POST", {
    queued_at: chunk.queued_at, processor_mode: "next", expected_old_templates: false, github_run_attempt: 2,
  });
  const { claim_token: token } = await claimed.json<{ claim_token: string }>();
  expect(await run(chunk.id)).toMatchObject({ status: "processing", claim_token: token, github_run_id: 18000000001, github_run_attempt: 2 });

  const done = await processor(`/api/processor/chunks/${chunk.id}`, "PATCH", { status: "completed", frames_processed: 900, detections_count: 4 }, token);
  expect(done.status).toBe(200);
  const finished = await run(chunk.id);
  expect(finished).toMatchObject({ status: "completed", frames_processed: 900, detections_count: 4, error: null });
  expect(finished!.finished_at).toBe((await one(env, "SELECT updated_at FROM chunks WHERE id=?", chunk.id))!.updated_at);
});

it("records failure, unclaimed dispatch failure with its GitHub run, and lease expiry", async () => {
  const failing = await queued();
  const token = (await claim(env, failing.id, failing.queued_at)).claim_token!;
  await processor(`/api/processor/chunks/${failing.id}`, "PATCH", { status: "failed", error: "decoder crashed" }, token);
  expect(await run(failing.id)).toMatchObject({ status: "failed", error: "decoder crashed", github_run_id: null });

  const unclaimed = await queued(11);
  const response = await processor("/api/processor/fail-queued", "POST", {
    ids: [unclaimed.id], queued_at: unclaimed.queued_at, error: "Workflow preparation failed", github_run_id: 77, github_run_attempt: 1,
  });
  expect(await response.json()).toEqual({ updated: 1 });
  expect(await run(unclaimed.id)).toMatchObject({ status: "failed", error: "Workflow preparation failed", github_run_id: 77 });

  await statement(env, "UPDATE chunks SET status='pending' WHERE id=?", unclaimed.id).run();
  const leased = await queued(11);
  await claim(env, leased.id, leased.queued_at);
  await statement(env, "UPDATE chunks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", leased.id).run();
  await recover(env);
  expect(await run(leased.id)).toMatchObject({ status: "expired", error: "Lease expired" });
  expect(await chunkRow(leased.id)).toMatchObject({ status: "pending", attempt_count: 2 });
  expect((await rows(env, "SELECT status FROM chunk_runs WHERE chunk_id=? ORDER BY queued_at", leased.id)).map((r) => r.status)).toEqual(["failed", "expired"]);
});

it("restores the chunk, records the refusal on it, and keeps no run when GitHub refuses the dispatch", async () => {
  stubGitHub(500);
  await expect(dispatch(hosted(), 10, manualRun(hosted()))).rejects.toThrow("500");
  const [chunk] = await rows(env, "SELECT id FROM chunks WHERE vod_id=10");
  expect(await chunkRow(chunk.id)).toMatchObject({
    status: "pending", queued_at: null, max_attempts: 3, attempt_count: 0, last_error: "Dispatch refused: Upstream api.github.com returned 500",
  });
  expect(await rows(env, "SELECT * FROM chunk_runs")).toEqual([]);
});
it("rejects malformed GitHub run identities on claim", async () => {
  const chunk = await queued();
  for (const github_run_id of [0, -1, "x", 1.5]) {
    const response = await processor(`/api/processor/chunks/${chunk.id}/claim`, "POST", { queued_at: chunk.queued_at, github_run_id });
    expect(response.status).toBe(400);
  }
  expect((await processor("/api/processor/github-run", "POST", { ids: [chunk.id], queued_at: chunk.queued_at, github_run_attempt: 0 })).status).toBe(400);
});

it("supersedes the dispatched run on an untracked claim of a queued chunk, and records manual runs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
  const chunk = await queued();
  const dispatched = (await run(chunk.id))!;
  const untracked = await claim(env, chunk.id, null, undefined, { runId: 7, runAttempt: 1 });
  expect(untracked.claimed).toBe(true);
  vi.useRealTimers();
  expect(await one(env, "SELECT status,error,claim_token FROM chunk_runs WHERE id=?", dispatched.id))
    .toEqual({ status: "expired", error: "Superseded by an untracked claim", claim_token: null });
  expect(await one(env, "SELECT origin,requested_by,inputs,status,claim_token,github_run_id,github_run_attempt FROM chunk_runs WHERE id<>? AND chunk_id=?", dispatched.id, chunk.id)).toEqual({
    origin: "manual", requested_by: null, inputs: null, status: "processing", claim_token: untracked.claim_token, github_run_id: 7, github_run_attempt: 1,
  });

  const [pending] = await rows(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,11,0,600,0) RETURNING id", crypto.randomUUID());
  const claimed = await claim(env, pending.id, null, undefined, { runId: 8, runAttempt: 1 });
  expect(await rows(env, "SELECT origin,inputs,status,claim_token,github_run_id FROM chunk_runs WHERE chunk_id=?", pending.id)).toEqual([
    { origin: "manual", inputs: null, status: "processing", claim_token: claimed.claim_token, github_run_id: 8 },
  ]);
});
it("clears the previous run's counts when a new run claims the chunk", async () => {
  const chunk = await queued();
  await statement(env, "UPDATE chunks SET frames_processed=50,detections_count=2,processing_duration_ms=999 WHERE id=?", chunk.id).run();
  const token = (await claim(env, chunk.id, chunk.queued_at)).claim_token!;
  expect(await chunkRow(chunk.id)).toMatchObject({ frames_processed: 0, detections_count: 0, processing_duration_ms: null });
  await processor(`/api/processor/chunks/${chunk.id}`, "PATCH", { status: "failed", error: "decoder crashed" }, token);
  expect(await run(chunk.id)).toMatchObject({ status: "failed", frames_processed: 0, detections_count: 0 });
});

it("expires a queue only after 24 hours, without consuming an attempt, and stops operator chunks", async () => {
  const automatic = await queued(10, automaticRun(hosted()));
  const [operatorChunk] = await rows(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index,status,attempt_count) VALUES(?,11,0,600,0,'failed',2) RETURNING id", crypto.randomUUID());
  stubGitHub();
  await queue(hosted(), await workflow(hosted(), 11, operatorRun("user", LEGACY)), [operatorChunk.id]);
  const backlog = ago(23 * 60), stale = ago(24 * 60 + 1);
  for (const [id, at] of [[automatic.id, stale], [operatorChunk.id, stale]] as const)
    await env.DB.batch([
      statement(env, "UPDATE chunks SET queued_at=? WHERE id=?", at, id),
      statement(env, "UPDATE chunk_runs SET queued_at=? WHERE chunk_id=?", at, id),
    ]);
  await statement(env, "UPDATE vods SET duration_seconds=1200,bazaar_chapters='[0,1200]' WHERE id=10").run();
  const delayed = await queued(10);
  await env.DB.batch([
    statement(env, "UPDATE chunks SET queued_at=? WHERE id=?", backlog, delayed.id),
    statement(env, "UPDATE chunk_runs SET queued_at=? WHERE chunk_id=?", backlog, delayed.id),
  ]);
  await recover(env);
  expect(await chunkRow(automatic.id)).toMatchObject({ status: "pending", attempt_count: 0, max_attempts: 3 });
  expect(await run(automatic.id)).toMatchObject({ status: "expired", error: "Queued run never started" });
  expect(await chunkRow(operatorChunk.id)).toMatchObject({ status: "failed", attempt_count: 2, max_attempts: 2, last_error: "Queued run never started" });
  expect(await run(operatorChunk.id)).toMatchObject({ origin: "operator", status: "expired" });
  expect(await chunkRow(delayed.id)).toMatchObject({ status: "queued" });
  expect(await run(delayed.id)).toMatchObject({ status: "queued" });
  await statement(env, "UPDATE chunks SET updated_at=? WHERE id=?", ago(6), operatorChunk.id).run();
  await recover(env);
  expect(await chunkRow(operatorChunk.id)).toMatchObject({ status: "failed" });
});

it("queues only due pending chunks for automatic and manual runs, even when they change after planning", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await env.DB.batch(ids.map((id, i) => statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,10,?,?,?)", id, i * 200, (i + 1) * 200, i)));
  stubGitHub();
  let changed = false;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!changed) {
        changed = true;
        await target.batch([
          statement(env, "UPDATE chunks SET status='failed',attempt_count=1 WHERE id=?", ids[0]),
          statement(env, "UPDATE chunks SET scheduled_for=? WHERE id=?", new Date(Date.now() + 3_600_000).toISOString(), ids[1]),
        ]);
      }
      return target.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(await dispatch({ ...hosted(), DB }, 10, automaticRun(hosted()))).toEqual([ids[2]]);
  expect(await chunkRow(ids[0])).toMatchObject({ status: "failed", attempt_count: 1 });
  expect(await chunkRow(ids[1])).toMatchObject({ status: "pending" });
  expect((await rows(env, "SELECT chunk_id FROM chunk_runs")).map((r) => r.chunk_id)).toEqual([ids[2]]);
  await statement(env, "UPDATE chunks SET status='completed' WHERE id=?", ids[2]).run();
  expect(await dispatch(hosted(), 10, manualRun(hosted()))).toEqual([]);
});
it("retries automatic failures up to max_attempts", async () => {
  const chunk = await queued(10, automaticRun(hosted()));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { queued_at } = (await chunkRow(chunk.id))!;
    if (attempt > 1) {
      stubGitHub();
      await dispatch(hosted(), 10, automaticRun(hosted()));
    }
    const current = (await chunkRow(chunk.id))!;
    expect(current.status).toBe("queued");
    const token = (await claim(env, chunk.id, attempt === 1 ? queued_at : current.queued_at)).claim_token!;
    await processor(`/api/processor/chunks/${chunk.id}`, "PATCH", { status: "failed", error: "decoder crashed" }, token);
    await statement(env, "UPDATE chunks SET updated_at=? WHERE id=?", ago(6), chunk.id).run();
    await recover(env);
    expect(await chunkRow(chunk.id)).toMatchObject({ status: attempt < 3 ? "pending" : "failed", attempt_count: attempt, max_attempts: 3 });
  }
  expect((await rows(env, "SELECT origin,status FROM chunk_runs WHERE chunk_id=?", chunk.id))).toEqual(Array(3).fill({ origin: "automatic", status: "failed" }));
});

it("resolves run inputs at the boundary from environment rules", () => {
  expect(resolveInputs(hosted(), {}, true)).toEqual({ mode: "next", quality: "480p", runtime_image: RUNTIME });
  expect(resolveInputs(hosted(), { quality: "1080p60" })).toEqual({ mode: "legacy", quality: "1080p60", runtime_image: RUNTIME });
  const production = { ...hosted(), ENVIRONMENT: "production" };
  expect(resolveInputs(production, {}, true)).toEqual({ mode: "legacy", quality: "480p", runtime_image: null });
  for (const [environment, inputs] of [
    [production, { mode: "next" }],
    [hosted(), { runtime_image: RUNTIME }],
    [hosted(), { runtime_image: null }],
    [hosted(), { quality: "best" }],
    [hosted(), { quality: "720p48" }],
    [hosted(), { mode: "fast" }],
    [hosted(), []],
    [hosted(), null],
  ] as const) expect(() => resolveInputs(environment, inputs)).toThrow();
});

it("records who started each run: cron and platform sweep are automatic, the admin key is manual", async () => {
  stubGitHub();
  const [automatic] = await dispatchAutomatic(hosted(), 10);
  expect(await run(automatic)).toMatchObject({ origin: "automatic", requested_by: null });
  expect(JSON.parse((await run(automatic))!.inputs).mode).toBe("next");

  const admin = await call("/functions/v1/process-vod", "POST", { vod_id: 11 }, env.ADMIN_KEY);
  expect(admin.status, await admin.clone().text()).toBe(200);
  const [manual] = (await admin.json<{ chunk_uuids: string[] }>()).chunk_uuids;
  expect(await run(manual)).toMatchObject({ origin: "manual", requested_by: null });
  expect(JSON.parse((await run(manual))!.inputs).mode).toBe("legacy");

  const account = crypto.randomUUID();
  await env.DB.batch([
    statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name,processing_enabled) VALUES(?,'youtube','UCexample','Example YT',1)", account),
    statement(env, `INSERT INTO vods(id,source,source_id,platform_account_id,title,duration_seconds,published_at,bazaar_chapters,ready_for_processing)
      VALUES(12,'youtube','abcdefg0012',?,'Upload',600,'2026-10-03T00:00:00.000Z','[0,600]',1)`, account),
  ]);
  const sweep = await call("/api/catalog/dispatch", "POST", { expected_environment: "validation", limit: 1 }, env.CATALOG_KEY);
  expect(await sweep.json()).toEqual({ dispatched: 1 });
  const [swept] = await rows(env, "SELECT id FROM chunks WHERE vod_id=12");
  expect(await run(swept.id)).toMatchObject({ origin: "automatic", requested_by: null });
  expect(JSON.parse((await run(swept.id))!.inputs).mode).toBe("next");
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
function reprocess(data: unknown, user: { cookie: string; identity: { csrfToken: string } } | null, csrf = user?.identity.csrfToken ?? "", target = hosted()) {
  return worker.fetch(new Request(ORIGIN + "/api/v1/ops/reprocess", {
    method: "POST",
    headers: { Cookie: user?.cookie ?? "", Origin: ORIGIN, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(data),
  }), target);
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

it("requires an operator session and a CSRF token, only accepts POST, and takes no runtime image", async () => {
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
  expect((await reprocess({ chunk_ids: [id], inputs: { runtime_image: RUNTIME } }, signed)).status).toBe(400);
  expect((await reprocess({ chunk_ids: [] }, signed)).status).toBe(400);
  expect((await reprocess({ chunk_ids: Array.from({ length: 51 }, () => crypto.randomUUID()) }, signed)).status).toBe(400);
  expect(github()).toHaveLength(0);
});

it("reports on a dry run what would queue, the exact payload, and every fence-rejected chunk, writing nothing", async () => {
  const [id, other] = await failedChunks();
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=11").run();
  const signed = await operator();
  const before = await rows(env, "SELECT * FROM chunks ORDER BY id");
  const response = await reprocess({ chunk_ids: [id.toUpperCase(), other], inputs: { quality: "720p" }, dry_run: true }, signed);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json<OpsReprocessResponse>()).toEqual({
    dispatched: false,
    recordings: [{
      recordingId: 10,
      chunkIds: [id],
      runIds: [],
      skipped: [],
      payload: {
        ref: "migration/cloudflare",
        inputs: {
          vod_id: "1001", source: "twitch", chunk_uuids: JSON.stringify([id]), old_templates: "false", quality: "720p",
          sfde_profile: expect.any(String), runtime_image: RUNTIME, processor_revision: "d".repeat(40), environment: "validation",
        },
      },
    }, { recordingId: 11, chunkIds: [], runIds: [], payload: null, skipped: [{ chunkId: other, reason: "Recording is unavailable" }] }],
  });
  expect(await rows(env, "SELECT * FROM chunks ORDER BY id")).toEqual(before);
  expect(await rows(env, "SELECT * FROM chunk_runs")).toEqual([]);
  expect(github()).toHaveLength(0);
});

it("refuses unknown, queued, processing and archived chunks, and reports ineligible recordings", async () => {
  const [failed, other] = await failedChunks();
  const signed = await operator();
  const unknown = crypto.randomUUID();
  const notFound = await reprocess({ chunk_ids: [failed, unknown] }, signed);
  expect(notFound.status).toBe(404);
  expect((await notFound.json<{ error: string }>()).error).toContain(unknown);
  for (const status of ["queued", "processing", "archived"]) {
    await statement(env, "UPDATE chunks SET status=? WHERE id=?", status, other).run();
    const refused = await reprocess({ chunk_ids: [failed, other] }, signed);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: `Chunks cannot be reprocessed: ${other} is ${status}` });
  }
  await statement(env, "UPDATE vods SET ready_for_processing=0 WHERE id=10").run();
  const ineligible = await reprocess({ chunk_ids: [failed] }, signed);
  expect(ineligible.status).toBe(409);
  expect(await ineligible.json()).toEqual({
    dispatched: true,
    error: "No chunk was queued",
    recordings: [{ recordingId: 10, chunkIds: [], runIds: [], payload: null, skipped: [{ chunkId: failed, reason: "Recording is not ready for processing" }] }],
  });
  expect(await chunkRow(failed)).toMatchObject({ status: "failed", attempt_count: 3, max_attempts: 3 });
  expect(await rows(env, "SELECT * FROM chunk_runs")).toEqual([]);
  expect(github()).toHaveLength(0);
});

it("queues each recording's chunks straight from failed in their own workflow, giving the operator run one attempt", async () => {
  const ids = await failedChunks();
  const signed = await operator();
  const response = await reprocess({ chunk_ids: ids, inputs: { mode: "legacy", quality: "360p" } }, signed);
  expect(response.status, await response.clone().text()).toBe(200);
  const value = await response.json<OpsReprocessResponse>();
  expect(value.dispatched).toBe(true);
  expect(value.recordings.map((r) => [r.recordingId, r.chunkIds, r.skipped])).toEqual([[10, [ids[0]], []], [11, [ids[1]], []]]);
  expect(github()).toHaveLength(2);
  for (const [index, recording] of value.recordings.entries()) {
    const payload = sent(index);
    expect(payload).toEqual(recording.payload);
    expect(JSON.parse(payload.inputs.chunk_uuids)).toEqual(recording.chunkIds);
    expect(payload.inputs).toMatchObject({ quality: "360p", sfde_profile: expect.any(String) });
    expect(payload.inputs.sfde_next).toBeUndefined();
    expect(JSON.parse(payload.inputs.sfde_profile).id).toBe(1);
    const stored = await rows(env, "SELECT id,origin,requested_by,status,queued_at,prior_status FROM chunk_runs WHERE chunk_id=?", recording.chunkIds[0]);
    expect(stored).toEqual([{ id: recording.runIds[0], origin: "operator", requested_by: signed.identity.userId, status: "queued", queued_at: payload.inputs.queued_at, prior_status: "failed" }]);
    expect(await chunkRow(recording.chunkIds[0])).toMatchObject({ status: "queued", attempt_count: 3, max_attempts: 4, queued_at: payload.inputs.queued_at });
  }
  expect(await rows(env, "SELECT id FROM chunks")).toHaveLength(2);

  const token = (await claim(env, ids[0], sent(0).inputs.queued_at)).claim_token!;
  await processor(`/api/processor/chunks/${ids[0]}`, "PATCH", { status: "failed", error: "decoder crashed again" }, token);
  await statement(env, "UPDATE chunks SET updated_at=? WHERE id=?", ago(6), ids[0]).run();
  await recover(env);
  expect(await chunkRow(ids[0])).toMatchObject({ status: "failed", attempt_count: 4, max_attempts: 4 });
});

it("keeps the operator's run when the scheduler dispatches the same recording mid-request", async () => {
  const [chunkId] = await failedChunks();
  await statement(env, "UPDATE vods SET duration_seconds=1200,bazaar_chapters='[0,1200]' WHERE id=10").run();
  const signed = await operator();
  let interleaved: string[] | null = null;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      interleaved ??= await dispatchAutomatic(hosted(), 10);
      return target.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await reprocess({ chunk_ids: [chunkId], inputs: { quality: "720p" } }, signed, signed.identity.csrfToken, { ...hosted(), DB });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(interleaved).toHaveLength(1);
  expect(interleaved).not.toContain(chunkId);
  const runs = await rows(env, "SELECT origin,inputs,queued_at FROM chunk_runs WHERE chunk_id=?", chunkId);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ origin: "operator" });
  expect(JSON.parse(runs[0].inputs).quality).toBe("720p");
  expect(await chunkRow(chunkId)).toMatchObject({ status: "queued", queued_at: runs[0].queued_at, attempt_count: 3, max_attempts: 4 });
});

it("reports a refused GitHub dispatch per recording and restores that recording's chunks", async () => {
  const ids = await failedChunks();
  const signed = await operator();
  stubGitHub(204, 500);
  const response = await reprocess({ chunk_ids: ids }, signed);
  expect(response.status, await response.clone().text()).toBe(200);
  const value = await response.json<OpsReprocessResponse>();
  expect(value.recordings[0]).toMatchObject({ recordingId: 10, chunkIds: [ids[0]], skipped: [] });
  expect(value.recordings[1]).toEqual({
    recordingId: 11, chunkIds: [], runIds: [], payload: null,
    error: "Upstream api.github.com returned 500", skipped: [{ chunkId: ids[1], reason: "Upstream api.github.com returned 500" }],
  });
  expect(await chunkRow(ids[0])).toMatchObject({ status: "queued" });
  expect(await chunkRow(ids[1])).toMatchObject({
    status: "failed", attempt_count: 3, max_attempts: 3, queued_at: null, last_error: "Dispatch refused: Upstream api.github.com returned 500",
  });
  expect(await rows(env, "SELECT * FROM chunk_runs WHERE chunk_id=?", ids[1])).toEqual([]);

  await statement(env, "UPDATE chunks SET updated_at=? WHERE id=?", ago(6), ids[1]).run();
  await recover(env);
  expect(await chunkRow(ids[1])).toMatchObject({ status: "failed" });

  stubGitHub(500);
  const refused = await reprocess({ chunk_ids: [ids[1]] }, signed);
  expect(refused.status).toBe(502);
  expect(await refused.json()).toMatchObject({ error: "No chunk was queued", recordings: [{ recordingId: 11, error: "Upstream api.github.com returned 500" }] });
});

it("reports an internal failure on one recording without losing the recordings before it", async () => {
  const ids = await failedChunks();
  const signed = await operator();
  let queues = 0;
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql.includes("INSERT INTO chunk_runs") && ++queues === 2) throw new Error("D1_ERROR: storage unavailable");
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await reprocess({ chunk_ids: ids }, signed, signed.identity.csrfToken, { ...hosted(), DB });
  expect(response.status, await response.clone().text()).toBe(200);
  const value = await response.json<OpsReprocessResponse>();
  expect(value.recordings[0]).toMatchObject({ recordingId: 10, chunkIds: [ids[0]], skipped: [] });
  expect(value.recordings[1]).toMatchObject({
    recordingId: 11, chunkIds: [], error: "D1_ERROR: storage unavailable", skipped: [{ chunkId: ids[1], reason: "D1_ERROR: storage unavailable" }],
  });
  expect(await chunkRow(ids[1])).toMatchObject({ status: "failed", max_attempts: 3 });

  const failing = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql.includes("INSERT INTO chunk_runs")) throw new Error("D1_ERROR: storage unavailable");
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const none = await reprocess({ chunk_ids: [ids[1]] }, signed, signed.identity.csrfToken, { ...hosted(), DB: failing });
  expect(none.status).toBe(500);
});

it("builds run defaults without throwing when configuration or stored inputs are no longer valid", async () => {
  const [id] = await failedChunks();
  const signed = await operator();
  const broken = { ...hosted(), SFDE_RUNTIME_IMAGE: "ghcr.io/other/image:latest" };
  const response = await worker.fetch(new Request(ORIGIN + `/api/v1/ops/chunks/${id}`, { headers: { Cookie: signed.cookie, Origin: ORIGIN } }), broken);
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json<OpsChunkDetail>()).runDefaults).toEqual({
    inputs: { mode: "legacy", quality: "480p", runtime_image: null }, allowedModes: ["next", "legacy"], configError: "Invalid SFDE runtime image",
  });
  expect(runDefaults({ ...hosted(), BUILD_COMMIT: "unreleased" }, null).configError).toBe("Invalid SFDE runtime revision");
  const production = { ...hosted(), ENVIRONMENT: "production" };
  expect(runDefaults(production, { mode: "next", quality: "720p", runtime_image: RUNTIME })).toEqual({
    inputs: { mode: "legacy", quality: "720p", runtime_image: null }, allowedModes: ["legacy"], configError: null,
  });
  const refused = await reprocess({ chunk_ids: [id] }, signed, signed.identity.csrfToken, broken);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "Invalid SFDE runtime image" });
});

it("dispatches NEXT on request and lists runs newest first with the defaults for the next run", async () => {
  const [id] = await failedChunks();
  const signed = await operator();
  const first = await reprocess({ chunk_ids: [id], inputs: { mode: "next", quality: "720p60" } }, signed);
  expect(first.status, await first.clone().text()).toBe(200);
  expect(sent().inputs).toMatchObject({ sfde_next: "true", quality: "720p60" });
  expect(sent().inputs.sfde_profile).toBeUndefined();
  const token = (await claim(env, id, sent().inputs.queued_at, undefined, { runId: 42, runAttempt: null })).claim_token!;
  await processor(`/api/processor/chunks/${id}`, "PATCH", { status: "completed", frames_processed: 10, detections_count: 0 }, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reprocess({ chunk_ids: [id] }, signed);

  const detail = await read<OpsChunkDetail>(`/api/v1/ops/chunks/${id}`, signed.cookie);
  expect(detail.runs.map((r) => [r.status, r.inputs?.mode, r.inputs?.quality])).toEqual([["queued", "legacy", "480p"], ["completed", "next", "720p60"]]);
  expect(detail.runs[1]).toMatchObject({
    origin: "operator", requestedBy: signed.identity.userId, framesProcessed: 10, detections: 0,
    githubRunUrl: "https://github.com/liftaris/bazaar-ghost/actions/runs/42", claimedAt: expect.any(String), finishedAt: expect.any(String),
  });
  expect(detail.runDefaults).toEqual({ inputs: { mode: "legacy", quality: "480p", runtime_image: RUNTIME }, allowedModes: ["next", "legacy"], configError: null });
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
