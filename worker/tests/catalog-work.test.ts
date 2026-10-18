import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { dispatchCatalog, requestCatalog, runCatalogBatch, type CatalogBatch } from "../catalog-work";
import { enqueueCatalog, processPending, handleJob } from "../jobs";
import { one, rows } from "../http";
import { Twitch } from "../twitch";

afterEach(() => vi.restoreAllMocks());
function runtime() {
  const messages: CatalogBatch[] = [];
  const send = vi.fn(async (job: CatalogBatch) => { messages.push(job); });
  return { testEnv: { ...env, JOBS: { send } as unknown as Queue }, messages, send };
}
const work = (id = 1) => one(env, "SELECT * FROM twitch_catalog_work WHERE streamer_id=?", id);
async function expire(id = 1) {
  await env.DB.prepare("UPDATE twitch_catalog_work SET lease_expires_at=0 WHERE streamer_id=?").bind(id).run();
}
async function due(id = 1) {
  await env.DB.prepare("UPDATE twitch_catalog_work SET due_at=0 WHERE streamer_id=?").bind(id).run();
}

it("groups 25 streamers into three messages while preserving all requests", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, Array.from({ length: 25 }, (_, i) => ({ id: i + 1 })));
  expect(await dispatchCatalog(testEnv)).toBe(25);
  expect(messages.map(m => m.ids.length)).toEqual([10, 10, 5]);
  const check = vi.fn().mockResolvedValue(undefined);
  for (const message of messages) await runCatalogBatch(testEnv, message, check);
  expect(check).toHaveBeenCalledTimes(25);
  expect(await rows(env, "SELECT streamer_id FROM twitch_catalog_work WHERE state!='idle'")).toEqual([]);
});

it("coalesces concurrent producers and dispatchers before queue writes", async () => {
  const { testEnv, messages } = runtime();
  await Promise.all(Array.from({ length: 8 }, () => requestCatalog(testEnv, [{ id: 1 }])));
  await Promise.all([dispatchCatalog(testEnv), dispatchCatalog(testEnv)]);
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  expect(messages).toHaveLength(1);
  expect((await work())!.requested_version).toBe(1);
});

it("honors reconciliation delay but an urgent request advances pending work", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1, dueAt: Date.now() + 3600_000 }]);
  expect(await dispatchCatalog(testEnv)).toBe(0);
  await requestCatalog(testEnv, [{ id: 1 }], true);
  expect(await dispatchCatalog(testEnv)).toBe(1);
  expect(messages[0].ids).toEqual([1]);
});

it("reserves only bounded work and recovers requests persisted before a send", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, Array.from({ length: 205 }, (_, i) => ({ id: i + 1 })));
  await processPending(testEnv);
  expect(messages).toHaveLength(20);
  expect(await dispatchCatalog(testEnv)).toBe(5);
});

it("recovers a send failure without losing the rest of a reserved group", async () => {
  const { testEnv, messages, send } = runtime();
  await requestCatalog(testEnv, Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })));
  send.mockRejectedValueOnce(new Error("Queue unavailable"));
  await expect(dispatchCatalog(testEnv)).rejects.toThrow("Queue unavailable");
  await env.DB.prepare("UPDATE twitch_catalog_work SET lease_expires_at=0").run();
  expect(await dispatchCatalog(testEnv)).toBe(12);
  expect(messages.flatMap(m => m.ids)).toHaveLength(12);
});

it("ignores ambiguous-send duplicates after a new dispatch takes ownership", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  const old = messages[0];
  await expire();
  await dispatchCatalog(testEnv);
  const check = vi.fn().mockResolvedValue(undefined);
  await runCatalogBatch(testEnv, old, check);
  await runCatalogBatch(testEnv, messages[1], check);
  await runCatalogBatch(testEnv, messages[1], check);
  expect(check).toHaveBeenCalledTimes(1);
});

it("coalesces routine requests during execution but preserves a new event for an immediate follow-up", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  await runCatalogBatch(testEnv, messages[0], async () => {
    await requestCatalog(testEnv, [{ id: 1 }]);
    expect((await work())!.requested_version).toBe(1);
    await requestCatalog(testEnv, [{ id: 1 }], true);
    expect(await dispatchCatalog(testEnv)).toBe(0);
  });
  expect(messages).toHaveLength(2);
  expect(await work()).toMatchObject({ state: "queued", completed_version: 1, requested_version: 2 });
  await runCatalogBatch(testEnv, messages[1], async () => {});
  expect(await work()).toMatchObject({ state: "idle", completed_version: 2 });
});

it("counts an event received before execution in the same pass", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  await requestCatalog(testEnv, [{ id: 1 }], true);
  await runCatalogBatch(testEnv, messages[0], async () => {});
  expect(messages).toHaveLength(1);
  expect(await work()).toMatchObject({ state: "idle", requested_version: 1, completed_version: 1 });
});

it("retries only the failed streamer with backoff, preserving successful work", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  await dispatchCatalog(testEnv);
  const check = vi.fn(async (id: number) => { if (id === 2) throw new Error("Twitch unavailable"); });
  await runCatalogBatch(testEnv, messages[0], check);
  expect(await work(1)).toMatchObject({ state: "idle" });
  expect(await work(3)).toMatchObject({ state: "idle" });
  expect(await work(2)).toMatchObject({ state: "pending", attempt_count: 1, last_error: "Error: Twitch unavailable" });
  expect((await work(2))!.due_at).toBeGreaterThan(Date.now());
  expect(await dispatchCatalog(testEnv)).toBe(0);
  await due(2);
  await dispatchCatalog(testEnv);
  expect(messages[1].ids).toEqual([2]);
  await runCatalogBatch(testEnv, messages[1], async () => {});
  expect(await work(2)).toMatchObject({ state: "idle", attempt_count: 0, last_error: null });
});

it("bounds retries and lets a later reconciliation restart failed cataloging", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }]);
  for (let i = 0; i < 6; i++) {
    await due();
    await dispatchCatalog(testEnv);
    await runCatalogBatch(testEnv, messages[i], async () => { throw new Error("Still down"); });
  }
  expect(await work()).toMatchObject({ state: "failed", attempt_count: 6 });
  expect(await dispatchCatalog(testEnv)).toBe(0);
  await requestCatalog(testEnv, [{ id: 1 }]);
  expect(await work()).toMatchObject({ state: "pending", attempt_count: 0 });
});

it("recovers an interrupted execution and fences the old consumer's completion", async () => {
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  await runCatalogBatch(testEnv, messages[0], async () => {
    await requestCatalog(testEnv, [{ id: 1 }], true);
    await expire();
    await dispatchCatalog(testEnv);
  });
  expect(await work()).toMatchObject({ state: "queued", completed_version: 0, requested_version: 2 });
  await runCatalogBatch(testEnv, messages[1], async () => {});
  expect(await work()).toMatchObject({ state: "idle", completed_version: 2 });
});

it("checks ownership before continuing a catalog after expiry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { testEnv, messages } = runtime();
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  await runCatalogBatch(testEnv, messages[0], async (_id, checkpoint) => {
    await checkpoint();
    await expire();
    await dispatchCatalog(testEnv);
    await expect(checkpoint()).rejects.toThrow("lease lost");
    throw new Error("Old consumer failed");
  });
  expect(await work()).toMatchObject({ state: "queued", lease_token: messages[1].token, last_error: "Catalog lease expired" });
});

it("keeps hourly coverage and staggered due times without one queue message per streamer", async () => {
  const { testEnv, messages } = runtime();
  await env.DB.prepare("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')").run();
  await env.DB.prepare("INSERT INTO streamers(id,login) VALUES(10,'one'),(20,'two')").run();
  await enqueueCatalog(testEnv);
  expect(messages).toEqual([]);
  const requested = await rows(env, "SELECT * FROM twitch_catalog_work ORDER BY streamer_id");
  expect(requested).toHaveLength(2);
  expect(requested[1].due_at - requested[0].due_at).toBeGreaterThanOrEqual(10_000);
});

it("adapts old first-page queue messages into grouped work and drains old cursor messages", async () => {
  const { testEnv, messages } = runtime();
  const catalog = vi.spyOn(Twitch.prototype, "catalog").mockResolvedValue({ streamerId: 1 });
  await handleJob(testEnv, { type: "catalog", id: 1 });
  expect(messages[0].ids).toEqual([1]);
  expect(catalog).not.toHaveBeenCalled();
  await handleJob(testEnv, { type: "catalog", id: 1, cursor: "old", page: 1 });
  expect(catalog).toHaveBeenCalledWith(1, "old", false, undefined, 1);
});

it("does not recatalog the same creator on another discovery page even after its first check finishes", async () => {
  await env.DB.prepare("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')").run();
  const { testEnv, messages } = runtime();
  const twitch = new Twitch(testEnv);
  vi.spyOn(twitch, "gameId").mockResolvedValue("bazaar");
  const helix = vi.spyOn(twitch, "helix").mockImplementation(async endpoint => {
    if (endpoint === "videos") return { data: [{ user_id: "1" }], pagination: {} };
    return { data: [{ id: "1", login: "creator" }] };
  });
  await twitch.discover();
  await runCatalogBatch(testEnv, messages[0], async () => {});
  helix.mockClear();
  await twitch.discover("second-page", 1, [1]);
  expect(helix).toHaveBeenCalledTimes(1);
  expect(messages).toHaveLength(1);
});

it("persists pagination and retains an event received between archive pages for a fresh pass", async () => {
  const { testEnv, messages } = runtime();
  const cursor = { cursor: "next", stats: { total: 20, bazaar: 1, oldest: null }, page: 1 };
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  await runCatalogBatch(testEnv, messages[0], async () => cursor);
  expect(await work()).toMatchObject({ state: "queued", completed_version: 0, cycle_version: 1 });
  await requestCatalog(testEnv, [{ id: 1 }], true);
  await runCatalogBatch(testEnv, messages[1], async (_id, _checkpoint, continuation) => {
    expect(continuation).toEqual(cursor);
  });
  expect(await work()).toMatchObject({ state: "queued", completed_version: 1, continuation: null });
  await runCatalogBatch(testEnv, messages[2], async (_id, _checkpoint, continuation) => {
    expect(continuation).toBeUndefined();
  });
  expect(await work()).toMatchObject({ state: "idle", completed_version: 2, cycle_version: null });
});

it("retries a failed continuation at the same page without advancing completion", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { testEnv, messages } = runtime();
  const cursor = { cursor: "next", stats: { total: 20, bazaar: 1, oldest: null }, page: 1 };
  await requestCatalog(testEnv, [{ id: 1 }]);
  await dispatchCatalog(testEnv);
  await runCatalogBatch(testEnv, messages[0], async () => cursor);
  await runCatalogBatch(testEnv, messages[1], async () => { throw new Error("Page unavailable"); });
  expect(await work()).toMatchObject({ state: "pending", completed_version: 0, continuation: JSON.stringify(cursor) });
  await due();
  await dispatchCatalog(testEnv);
  await runCatalogBatch(testEnv, messages[2], async (_id, _checkpoint, continuation) => {
    expect(continuation).toEqual(cursor);
  });
  expect(await work()).toMatchObject({ state: "idle", completed_version: 1 });
});

it("finishes ten full archive pages below D1's per-invocation query limit", async () => {
  await env.DB.prepare("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')").run();
  const { testEnv, messages, send } = runtime();
  vi.spyOn(Twitch.prototype, "gameId").mockResolvedValue("bazaar");
  vi.spyOn(Twitch.prototype, "ensureSubscription").mockResolvedValue(undefined);
  vi.spyOn(Twitch.prototype, "helix").mockImplementation(async (endpoint, input) => {
    const params = input as Record<string, string>;
    if (endpoint === "users") return { data: [{ id: params.id, login: `creator${params.id}` }] };
    if (endpoint === "streams") return { data: [] };
    return { data: Array.from({ length: 20 }, (_, i) => ({ id: `${params.user_id}${i.toString().padStart(2, '0')}` })), pagination: {} };
  });
  vi.spyOn(Twitch.prototype, "gql").mockImplementation(async (_query, vars) => ({ video: {
    id: vars.id, title: "Bazaar", lengthSeconds: 3600, publishedAt: "2026-10-17T00:00:00Z",
    game: { id: "bazaar" }, moments: { edges: [] },
  } }));
  await requestCatalog(testEnv, Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })));
  await dispatchCatalog(testEnv);
  let queries = 0;
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await handleJob({ ...testEnv, DB: db }, messages[0]);
  expect(queries).toBeLessThan(800); // Headroom below the paid D1 limit of 1,000.
  expect(send.mock.calls.filter(([job]) => (job as { type: string }).type === "plan")).toHaveLength(200);
  expect(await rows(env, "SELECT streamer_id FROM twitch_catalog_work WHERE state='idle'")).toHaveLength(10);
});
