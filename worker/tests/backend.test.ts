import { env, SELF } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  missingChunks,
  normalizeRanges,
  claim,
  plan,
  recover,
  dispatch,
} from "../processing";
import { trigrams } from "../search";
import { one, rows, statement } from "../http";
import { clearDevStorage, handleJob } from "../jobs";
import { Twitch } from "../twitch";

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected outbound request");
    }),
  );
  await env.DB.prepare(
    "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO streamers(id,login,display_name) VALUES(1,'example','Example')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO vods(id,streamer_id,source_id,title,duration_seconds,published_at,bazaar_chapters,ready_for_processing) VALUES(1,1,'123','Example VOD',3661,'2026-09-01T12:00:00Z','[0,3661]',1)",
  ).run();
});
afterEach(() => vi.unstubAllGlobals());
async function api(
  path: string,
  method = "GET",
  data?: unknown,
  token?: string,
  role = "processor",
) {
  return SELF.fetch(`http://local${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${role === "processor" ? env.PROCESSOR_KEY : env.ADMIN_KEY}`,
      "Content-Type": "application/json",
      ...(token ? { "X-Claim-Token": token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function planned() {
  return plan(env, 1);
}
async function screenshot(id: string, token: string, time = 12) {
  const response = await SELF.fetch(
    `http://local/api/processor/chunks/${id}/images?timestamp=${time}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.PROCESSOR_KEY}`,
        "X-Claim-Token": token,
        "Content-Type": "image/jpeg",
      },
      body: new Uint8Array([255, 216, 255, 217]),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json<any>()).storage_path;
}
async function detection(
  id: string,
  token: string,
  time = 12,
  name = "Opponent",
) {
  return {
    id: crypto.randomUUID(),
    frame_time_seconds: time,
    username: name,
    confidence: 0.95,
    rank: "gold",
    igd: 9,
    storage_path: await screenshot(id, token, time),
  };
}
it("merges chapters, preserves short tails, and subtracts existing intervals", () => {
  expect(normalizeRanges([20, 40, 0, 20, 35, 60], 50)).toEqual([[0, 50]]);
  expect(missingChunks([[0, 3661]], [[100, 200]])).toEqual([
    [0, 100],
    [200, 2000],
    [2000, 3661],
  ]);
  expect(missingChunks([], [])).toEqual([]);
});
it("concurrent planners cover each second once", async () => {
  await Promise.all([planned(), planned(), planned()]);
  const chunks = await rows(env, "SELECT * FROM chunks ORDER BY start_seconds");
  expect(chunks.map((c) => [c.start_seconds, c.end_seconds])).toEqual([
    [0, 1800],
    [1800, 3600],
    [3600, 3661],
  ]);
});
it("only one runner acquires a claim and stale runners cannot mutate", async () => {
  const [chunk] = await planned();
  const results = await Promise.all([
    claim(env, chunk.id),
    claim(env, chunk.id),
  ]);
  expect(results.filter((r) => r.claimed)).toHaveLength(1);
  const old = results.find((r) => r.claimed)!.claim_token!;
  await statement(
    env,
    "UPDATE chunks SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?",
    chunk.id,
  ).run();
  await recover(env);
  const fresh = await claim(env, chunk.id);
  expect(fresh.claimed).toBe(true);
  expect(
    (
      await api(
        `/api/processor/chunks/${chunk.id}`,
        "PATCH",
        { status: "completed" },
        old,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await api(
        `/api/processor/chunks/${chunk.id}/detections`,
        "DELETE",
        undefined,
        old,
      )
    ).status,
  ).toBe(409);
});
it("publishes images before idempotent detections, includes IGD and aggregates a complete VOD", async () => {
  const chunks = await planned();
  for (const chunk of chunks) {
    const token = (await claim(env, chunk.id)).claim_token!;
    const record = await detection(chunk.id, token, chunk.start_seconds + 12);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await api(
            `/api/processor/chunks/${chunk.id}/detections`,
            "POST",
            { detections: [record] },
            token,
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await api(
          `/api/processor/chunks/${chunk.id}`,
          "PATCH",
          {
            status: "completed",
            frames_processed: 20,
            detections_count: 1,
            processing_duration_ms: 500,
          },
          token,
        )
      ).status,
    ).toBe(200);
  }
  expect((await one(env, "SELECT status FROM vods"))!.status).toBe("completed");
  expect((await one(env, "SELECT count(*) AS n FROM detections"))!.n).toBe(3);
  expect(
    (await one(env, "SELECT count(*) AS n FROM notification_outbox_v2"))!.n,
  ).toBe(3);
  const results = (await (await SELF.fetch("http://local/api/v1/search?q=oponent")).json<any>()).items;
  expect(results).toHaveLength(3);
  expect(results[0].opponent.igd).toBe(9);
});
it("rejects missing screenshots and frames outside the claimed chunk", async () => {
  const [chunk] = await planned(),
    token = (await claim(env, chunk.id)).claim_token!;
  const record = {
    id: crypto.randomUUID(),
    username: "Oops",
    confidence: 0.9,
    frame_time_seconds: 12,
    storage_path: "/detections/missing.jpg",
  };
  expect(
    (
      await api(
        `/api/processor/chunks/${chunk.id}/detections`,
        "POST",
        { detections: [record] },
        token,
      )
    ).status,
  ).toBe(400);
  expect((await one(env, "SELECT count(*) AS n FROM detections"))!.n).toBe(0);
});
it("does not claim disabled, unavailable or unready VODs", async () => {
  const [chunk] = await planned();
  await env.DB.prepare("UPDATE streamers SET processing_enabled=0").run();
  expect((await claim(env, chunk.id)).claimed).toBe(false);
  await env.DB.prepare("UPDATE streamers SET processing_enabled=1").run();
  await env.DB.prepare("UPDATE vods SET availability='unavailable'").run();
  expect((await claim(env, chunk.id)).claimed).toBe(false);
  await env.DB.prepare(
    "UPDATE vods SET availability='available',ready_for_processing=0",
  ).run();
  expect((await claim(env, chunk.id)).claimed).toBe(false);
});
it("keeps failed siblings separate from completed work", async () => {
  const chunks = await planned();
  for (let i = 0; i < chunks.length; i++) {
    const token = (await claim(env, chunks[i].id)).claim_token!;
    await api(
      `/api/processor/chunks/${chunks[i].id}`,
      "PATCH",
      { status: i ? "failed" : "completed" },
      token,
    );
  }
  expect((await one(env, "SELECT status FROM vods"))!.status).toBe("partial");
  expect(
    (await one(
      env,
      "SELECT count(*) AS n FROM chunks WHERE status='completed'",
    ))!.n,
  ).toBe(1);
});
it("rejects unauthenticated private routes and the removed PostgREST compatibility surface", async () => {
  expect((await SELF.fetch("http://local/rest/v1/streamers")).status).toBe(401);
  expect((await SELF.fetch("http://local/api/processor/chunks")).status).toBe(
    401,
  );
  expect(
    (
      await api("/functions/v1/process-vod", "POST", {
        vod_id: 1,
        dry_run: true,
      })
    ).status,
  ).toBe(401);
});
it("pads distinct word trigrams like pg_trgm and handles punctuation", () => {
  expect(trigrams("CAT")).toEqual(["  c", " ca", "at ", "cat"]);
  expect(trigrams("cat-cat")).toEqual(trigrams("cat"));
  expect(trigrams("é")).toEqual(["  é", " é "]);
});
it("dev notifications make no outbound calls and production cannot clear storage", async () => {
  const [chunk] = await planned(),
    token = (await claim(env, chunk.id)).claim_token!,
    record = await detection(chunk.id, token);
  await api(
    `/api/processor/chunks/${chunk.id}/detections`,
    "POST",
    { detections: [record] },
    token,
  );
  await env.DB.prepare("UPDATE notification_outbox_v2 SET eligible_at='2000-01-01T00:00:00.000Z'").run();
  const matchup = (await one(env, "SELECT matchup_id FROM notification_outbox_v2"))!.matchup_id;
  await handleJob(
    { ...env, ENVIRONMENT: "dev" },
    { type: "notify", id: matchup },
  );
  expect(
    (await one(env, "SELECT sent_at FROM notification_outbox_v2"))!.sent_at,
  ).toBeTruthy();
  await expect(
    clearDevStorage({ ...env, ENVIRONMENT: "production" }),
  ).rejects.toThrow("restricted to dev");
  await clearDevStorage({ ...env, ENVIRONMENT: "dev" });
  expect((await env.DETECTIONS.list()).objects).toHaveLength(0);
});
it("Twitch failure never marks archives unavailable", async () => {
  const live = { ...env, OUTBOUND_ENABLED: "true" };
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({ access_token: "test" }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await expect(new Twitch(live).availability()).rejects.toThrow("503");
  expect((await one(env, "SELECT availability FROM vods"))!.availability).toBe(
    "available",
  );
});
it("failed GitHub dispatch releases only its queued chunks", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 500 }));
  await expect(
    dispatch(
      {
        ...env,
        ENVIRONMENT: "dev",
        OUTBOUND_ENABLED: "true",
        GITHUB_TOKEN: "test",
      },
      1,
      { origin: "manual", inputs: { mode: "legacy", quality: "480p", runtime_image: null } },
    ),
  ).rejects.toThrow("500");
  expect(
    (await rows(env, "SELECT status FROM chunks")).map((c) => c.status),
  ).toEqual(["pending", "pending", "pending"]);
});
it("rejects unsigned Discord and EventSub requests", async () => {
  expect(
    (
      await SELF.fetch("http://local/functions/v1/ghost-bot", {
        method: "POST",
        body: '{"type":1}',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await SELF.fetch("http://local/functions/v1/process-vod", {
        method: "POST",
        headers: { "Twitch-Eventsub-Message-Type": "notification" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});
it("searches with a zero threshold, filters confidence, and returns stable pagination totals", async () => {
  const [chunk] = await planned(),
    token = (await claim(env, chunk.id)).claim_token!;
  const records = [
    await detection(chunk.id, token, 10, "Opponent"),
    await detection(chunk.id, token, 20, "Other"),
    await detection(chunk.id, token, 30, "Hidden"),
  ];
  records[2].confidence = 0.5;
  await api(
    `/api/processor/chunks/${chunk.id}/detections`,
    "POST",
    { detections: records },
    token,
  );
  expect((await (await SELF.fetch("http://local/api/v1/streamers/quality")).json<any>()).items).toEqual([]);
});
it("concurrent GitHub dispatches submit all chunks exactly once regardless of the old slot limit", async () => {
  await statement(
    env,
    "INSERT INTO processing_config(key,value) VALUES('max_concurrent_chunks','2')",
  ).run();
  const pending = await planned();
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
  await Promise.all([
    dispatch(
      {
        ...env,
        ENVIRONMENT: "dev",
        OUTBOUND_ENABLED: "true",
        GITHUB_TOKEN: "test",
      },
      1,
      { origin: "manual", inputs: { mode: "legacy", quality: "480p", runtime_image: null } },
    ),
    dispatch(
      {
        ...env,
        ENVIRONMENT: "dev",
        OUTBOUND_ENABLED: "true",
        GITHUB_TOKEN: "test",
      },
      1,
      { origin: "manual", inputs: { mode: "legacy", quality: "480p", runtime_image: null } },
    ),
  ]);
  expect(
    (await one(env, "SELECT count(*) AS n FROM chunks WHERE status='queued'"))!
      .n,
  ).toBe(pending.length);
  const dispatched = vi.mocked(fetch).mock.calls.flatMap(([, init]) =>
    JSON.parse(JSON.parse(String(init!.body)).inputs.chunk_uuids));
  expect(dispatched.sort()).toEqual(pending.map(chunk => chunk.id).sort());
  for (const [, init] of vi.mocked(fetch).mock.calls) {
    const data = JSON.parse(String(init!.body));
    expect(data.ref).toBe("dev");
    expect(data.inputs.environment).toBe("dev");
  }
});
it("catalog updates can add a tail after a previously completed range", async () => {
  await env.DB.prepare("UPDATE vods SET bazaar_chapters='[0,12]'").run();
  const [chunk] = await planned(),
    token = (await claim(env, chunk.id)).claim_token!;
  await api(
    `/api/processor/chunks/${chunk.id}`,
    "PATCH",
    { status: "completed" },
    token,
  );
  await env.DB.prepare("UPDATE vods SET bazaar_chapters='[0,14]'").run();
  const tail = await planned();
  expect(tail.map((c) => [c.start_seconds, c.end_seconds])).toEqual([[12, 14]]);
  expect((await one(env, "SELECT status FROM vods"))!.status).toBe("partial");
});
it("retry refuses active workers and preserves successful siblings by default", async () => {
  const [chunk] = await planned(),
    token = (await claim(env, chunk.id)).claim_token!;
  expect(
    (
      await api(
        "/api/admin/retry-vod",
        "POST",
        { vod_id: 1 },
        undefined,
        "admin",
      )
    ).status,
  ).toBe(409);
  await api(
    `/api/processor/chunks/${chunk.id}`,
    "PATCH",
    { status: "failed" },
    token,
  );
  const response = await api(
    "/api/admin/retry-vod",
    "POST",
    { vod_id: 1 },
    undefined,
    "admin",
  );
  expect(response.status).toBe(200);
  expect((await response.json<any>()).reset).toBe(1);
});
it("does not invent work from empty chapter evidence or a disabled streamer", async () => {
  await env.DB.prepare("UPDATE vods SET bazaar_chapters='[]'").run();
  expect(await planned()).toEqual([]);
  await env.DB.prepare("UPDATE vods SET bazaar_chapters='[0,12]'").run();
  await env.DB.prepare("UPDATE streamers SET processing_enabled=0").run();
  expect(await planned()).toEqual([]);
});
it("a replaced claim cannot overwrite screenshots from the new runner", async () => {
  const [chunk] = await planned(),
    old = (await claim(env, chunk.id)).claim_token!;
  const prior = await detection(chunk.id, old);
  await api(
    `/api/processor/chunks/${chunk.id}/detections`,
    "POST",
    { detections: [prior] },
    old,
  );
  await statement(
    env,
    "UPDATE chunks SET lease_expires_at='2000-01-01' WHERE id=?",
    chunk.id,
  ).run();
  await recover(env);
  const current = (await claim(env, chunk.id)).claim_token!;
  expect(
    (
      await api(
        `/api/processor/chunks/${chunk.id}/detections`,
        "DELETE",
        undefined,
        current,
      )
    ).status,
  ).toBe(200);
  const fresh = await detection(chunk.id, current);
  expect(fresh.storage_path).not.toBe(prior.storage_path);
  expect(
    (
      await api(
        `/api/processor/chunks/${chunk.id}/detections`,
        "POST",
        { detections: [prior] },
        old,
      )
    ).status,
  ).toBe(409);
});
it("a delayed GitHub attempt cannot claim or fail a newer dispatch", async () => {
  const [chunk] = await planned();
  const old = "2026-09-01T00:00:00.000Z",
    fresh = "2026-09-01T01:00:00.000Z";
  await statement(
    env,
    "UPDATE chunks SET status='queued',queued_at=? WHERE id=?",
    fresh,
    chunk.id,
  ).run();
  expect((await claim(env, chunk.id, old)).claimed).toBe(false);
  const fail = await api("/api/processor/fail-queued", "POST", {
    ids: [chunk.id],
    queued_at: old,
  });
  expect((await fail.json<any>()).updated).toBe(0);
  expect(
    (await one(env, "SELECT status FROM chunks WHERE id=?", chunk.id))!.status,
  ).toBe("queued");
  expect((await claim(env, chunk.id, fresh)).claimed).toBe(true);
});

it('retries failed processing after backoff, fences the old owner, and stops at three attempts', async () => {
  const [chunk, sibling] = await planned();
  const { updateChunk } = await import('../processing');
  const siblingToken = (await claim(env, sibling.id)).claim_token!;
  await updateChunk(env, sibling.id, siblingToken, { status: 'completed' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = (await claim(env, chunk.id)).claim_token!;
    expect(token).toBeTruthy();
    await updateChunk(env, chunk.id, token, { status: 'failed', error: 'Transient decoder failure' });
    await recover(env);
    expect((await one(env, 'SELECT status FROM chunks WHERE id=?', chunk.id))!.status).toBe('failed');
    await statement(env, "UPDATE chunks SET updated_at='2000-01-01T00:00:00Z' WHERE id=?", chunk.id).run();
    await recover(env);
    expect((await one(env, 'SELECT status FROM chunks WHERE id=?', chunk.id))!.status).toBe(attempt < 3 ? 'pending' : 'failed');
    await expect(updateChunk(env, chunk.id, token, { status: 'completed' })).rejects.toMatchObject({ status: 409 });
  }
  expect((await one(env, 'SELECT status FROM chunks WHERE id=?', sibling.id))!.status).toBe('completed');
  expect((await one(env, 'SELECT attempt_count FROM chunks WHERE id=?', chunk.id))!.attempt_count).toBe(3);
});

it('leaves GitHub-queued chunks alone until a runner claims them or they go stale', async () => {
  const [chunk] = await planned();
  const queuedAt = new Date(Date.now() - 59 * 60_000).toISOString();
  await statement(env, "UPDATE chunks SET status='queued',queued_at=? WHERE id=?", queuedAt, chunk.id).run();
  for (let sweep = 0; sweep < 3; sweep++) {
    await recover(env);
    expect(await one(env, 'SELECT status,attempt_count,lease_expires_at FROM chunks WHERE id=?', chunk.id))
      .toEqual({ status: 'queued', attempt_count: 0, lease_expires_at: null });
  }
  expect((await claim(env, chunk.id, queuedAt)).claimed).toBe(true);
  const started = await one(env, 'SELECT attempt_count,lease_expires_at FROM chunks WHERE id=?', chunk.id);
  expect(started!.attempt_count).toBe(1);
  expect(Date.parse(started!.lease_expires_at)).toBeGreaterThan(Date.now());
});

it('counts reported pre-claim failures toward the retry budget', async () => {
  const [chunk] = await planned();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const queuedAt = `2026-10-23T00:0${attempt}:00Z`;
    await statement(env, "UPDATE chunks SET status='queued',queued_at=? WHERE id=?", queuedAt, chunk.id).run();
    const failed = await api('/api/processor/fail-queued', 'POST', { ids: [chunk.id], queued_at: queuedAt });
    expect((await failed.json<any>()).updated).toBe(1);
    await statement(env, "UPDATE chunks SET updated_at='2000-01-01T00:00:00Z' WHERE id=?", chunk.id).run();
    await recover(env);
    expect(await one(env, 'SELECT status,attempt_count FROM chunks WHERE id=?', chunk.id))
      .toEqual({ status: attempt < 3 ? 'pending' : 'failed', attempt_count: attempt });
  }
});
