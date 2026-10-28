import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import worker from "../index";
import { now, one, rows } from "../http";
import { Twitch } from "../twitch";
import { scheduled, processPending } from "../jobs";

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  await env.DB.prepare(
    "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')",
  ).run();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
it("verifies signed Twitch challenges and rejects stale or modified bodies", async () => {
  const raw = JSON.stringify({ challenge: "challenge" }),
    id = "unique-event",
    timestamp = now();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TWITCH_EVENTSUB_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature =
    "sha256=" +
    hex(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(id + timestamp + raw),
      ),
    );
  const headers = {
    "Twitch-Eventsub-Message-Id": id,
    "Twitch-Eventsub-Message-Timestamp": timestamp,
    "Twitch-Eventsub-Message-Signature": signature,
    "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
  };
  const request = (body: string) =>
    new Request("http://local/functions/v1/process-vod", {
      method: "POST",
      headers,
      body,
    });
  const response = await worker.fetch(request(raw), env);
  expect(await response.text()).toBe("challenge");
  expect((await worker.fetch(request(raw + " "), env)).status).toBe(403);
  headers["Twitch-Eventsub-Message-Timestamp"] = "2000-01-01T00:00:00Z";
  expect((await worker.fetch(request(raw), env)).status).toBe(403);
});
it("validates Discord signatures and makes subscription retries idempotent", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = hex(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    ),
    testEnv = { ...env, DISCORD_PUBLIC_KEY: publicKey };
  async function call(payload: any) {
    const raw = JSON.stringify(payload),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hex(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(timestamp + raw),
      ),
    );
    return worker.fetch(
      new Request("http://local/functions/v1/ghost-bot", {
        method: "POST",
        headers: {
          "X-Signature-Ed25519": signature,
          "X-Signature-Timestamp": timestamp,
        },
        body: raw,
      }),
      testEnv,
    );
  }
  expect(await (await call({ type: 1 })).json()).toEqual({ type: 1 });
  const interaction = {
    type: 2,
    id: "123",
    user: { id: "456" },
    data: {
      name: "notify",
      options: [
        { name: "bazaar_username", value: "Opponent" },
        { name: "where", value: "dm" },
      ],
    },
  };
  expect((await call(interaction)).status).toBe(200);
  expect((await call(interaction)).status).toBe(200);
  expect(
    (await one(env, "SELECT enabled FROM notification_subscriptions"))!.enabled,
  ).toBe(1);
  interaction.id = "124";
  await call(interaction);
  expect(
    (await one(env, "SELECT enabled FROM notification_subscriptions"))!.enabled,
  ).toBe(0);
  const denied = await call({
    type: 2,
    id: "125",
    guild_id: "g",
    member: { user: { id: "456" }, permissions: "0" },
    data: { name: "setchannel" },
  });
  expect((await denied.json<any>()).data.content).toContain("Manage Server");
});
it("catalogs exact Bazaar ranges and keeps user-controlled processing configuration", async () => {
  const jobs = {
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue;
  const twitch = new Twitch({ ...env, JOBS: jobs, OUTBOUND_ENABLED: "true" });
  await env.DB.prepare(
    "INSERT INTO streamers(id,login,processing_enabled) VALUES(1,'old_login',0)",
  ).run();
  vi.spyOn(twitch, "helix").mockImplementation(async (endpoint) => {
    if (endpoint === "users")
      return {
        data: [{ id: "1", login: "new_login", display_name: "New Login" }],
      };
    if (endpoint === "videos") return { data: [{ id: "123" }], pagination: {} };
    if (endpoint === "streams") return { data: [] };
    if (endpoint === "search/categories")
      return {
        data: [
          { id: "wrong", name: "The Bazaar Extra" },
          { id: "bazaar", name: "The Bazaar" },
        ],
      };
    throw new Error("Unexpected endpoint");
  });
  const node = {
    id: "123",
    title: "Mixed games",
    lengthSeconds: 100,
    publishedAt: "2026-09-01T00:00:00Z",
    game: { id: "other" },
    moments: {
      edges: [
        {
          node: {
            positionMilliseconds: 0,
            details: { game: { id: "other", name: "Other" } },
          },
        },
        {
          node: {
            positionMilliseconds: 20000,
            details: { game: { id: "bazaar", name: "The Bazaar" } },
          },
        },
      ],
    },
  };
  vi.spyOn(twitch, "gql").mockResolvedValue({
    video: node,
  });
  await twitch.catalog(1);
  const streamer = await one(env, "SELECT * FROM streamers");
  expect(streamer!.login).toBe("new_login");
  expect(streamer!.processing_enabled).toBe(0);
  expect(
    JSON.parse(
      (await one(env, "SELECT bazaar_chapters FROM vods"))!.bazaar_chapters,
    ),
  ).toEqual([20, 100]);
  expect(await rows(env, "SELECT id FROM chunks")).toEqual([]);
  node.moments.edges = Array(25).fill(node.moments.edges[0]);
  await expect(twitch.catalog(1)).rejects.toThrow("25-chapter");
});
it("cron handlers enqueue bounded work and outbound-disabled installs remain idle", async () => {
  const send = vi.fn().mockResolvedValue(undefined),
    jobs = { send } as unknown as Queue;
  const controller = {
    cron: "0 2 * * *",
    scheduledTime: Date.now(),
    noRetry() {},
  };
  await scheduled(controller, {
    ...env,
    JOBS: jobs,
    OUTBOUND_ENABLED: "false",
  });
  expect(send).not.toHaveBeenCalled();
  await scheduled(controller, { ...env, JOBS: jobs, OUTBOUND_ENABLED: "true" });
  expect(send).toHaveBeenCalledWith({ type: "discover" });
});
it("empty imported chapter lists cannot starve eligible VODs in the scheduler", async () => {
  await env.DB.prepare(
    "INSERT INTO streamers(id,login) VALUES(1,'scheduler_test')",
  ).run();
  for (let id = 1; id <= 5; id++) {
    await env.DB.prepare(
      "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,published_at,bazaar_chapters,ready_for_processing) VALUES(?,1,?,12,?,?,1)",
    )
      .bind(
        id,
        String(id),
        id === 5 ? "2026-09-01T00:00:00Z" : "2026-09-02T00:00:00Z",
        id === 5 ? "[0,12]" : "[]",
      )
      .run();
  }
  const send = vi.fn().mockResolvedValue(undefined);
  await processPending({ ...env, JOBS: { send } as unknown as Queue });
  expect(send.mock.calls.map(([job]) => job)).toEqual([
    { type: "process", id: 5 },
  ]);
});

it('discovers offline creators from recent archives, preserves disables, and catalogs immediately', async () => {
  await env.DB.prepare("INSERT INTO streamers(id,login,processing_enabled) VALUES(2,'disabled',0)").run();
  const send = vi.fn().mockResolvedValue(undefined);
  const twitch = new Twitch({ ...env, JOBS: { send } as unknown as Queue });
  vi.spyOn(twitch, 'gameId').mockResolvedValue('bazaar');
  const helix = vi.spyOn(twitch, 'helix').mockImplementation(async (endpoint, params) => {
    if (endpoint === 'videos') {
      expect(params).toEqual({ game_id: 'bazaar', first: '100', type: 'archive', sort: 'time' });
      return { data: [{ user_id: '1' }, { user_id: '1' }, { user_id: '2' }], pagination: { cursor: 'next' } };
    }
    expect(endpoint).toBe('users');
    expect((params as URLSearchParams).getAll('id')).toEqual(['1', '2']);
    return { data: [{ id: '1', login: 'Offline', display_name: 'Offline', profile_image_url: '' },
      { id: '2', login: 'disabled', display_name: 'Disabled', profile_image_url: '' }] };
  });
  expect(await twitch.discover()).toEqual({ streamersChecked: 2 });
  expect(helix).toHaveBeenCalledTimes(2);
  expect(await rows(env, 'SELECT id,processing_enabled FROM streamers ORDER BY id')).toEqual([
    { id: 1, processing_enabled: 1 }, { id: 2, processing_enabled: 0 }]);
  expect(send.mock.calls.map(([job]) => job)).toEqual([
    { type: 'catalog-batch', ids: [1, 2], token: expect.any(String) }, { type: 'discover', cursor: 'next', page: 1, seenIds: [1, 2] }]);
});

it('bounds recent-archive discovery to five pages and rejects stuck pagination', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const twitch = new Twitch({ ...env, JOBS: { send } as unknown as Queue });
  vi.spyOn(twitch, 'gameId').mockResolvedValue('bazaar');
  vi.spyOn(twitch, 'helix').mockResolvedValue({ data: [], pagination: { cursor: 'same' } });
  await twitch.discover('previous', 4);
  expect(send).not.toHaveBeenCalled();
  await expect(twitch.discover('same', 2)).rejects.toThrow('did not advance');
});

it('limits validation discovery without changing the production default', async () => {
  await env.DB.prepare("INSERT INTO processing_config(key,value) VALUES('twitch_discovery_streamer_ids','[\"2\"]')").run();
  const send = vi.fn().mockResolvedValue(undefined);
  const twitch = new Twitch({ ...env, JOBS: { send } as unknown as Queue });
  vi.spyOn(twitch, 'gameId').mockResolvedValue('bazaar');
  vi.spyOn(twitch, 'helix').mockImplementation(async (endpoint, params) => {
    if (endpoint === 'videos') return { data: [{ user_id: '1' }, { user_id: '2' }], pagination: {} };
    expect((params as URLSearchParams).getAll('id')).toEqual(['2']);
    return { data: [{ id: '2', login: 'reviewed', display_name: 'Reviewed', profile_image_url: '' }] };
  });
  await twitch.discover();
  expect(await rows(env, 'SELECT id FROM streamers')).toEqual([{ id: 2 }]);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'catalog-batch', ids: [2], token: expect.any(String) });
});

it('limits automatic dispatch to reviewed VODs and keeps platform ingestion paused', async () => {
  await env.DB.prepare("INSERT INTO streamers(id,login) VALUES(1,'reviewed')").run();
  for (const id of ['111', '222']) await env.DB.prepare("INSERT INTO vods(streamer_id,source_id,duration_seconds,published_at,bazaar_chapters,ready_for_processing) VALUES(1,?,12,'2026-10-16T00:00:00Z','[0,12]',1)").bind(id).run();
  await env.DB.prepare("INSERT INTO processing_config(key,value) VALUES('automatic_vods','[\"twitch:111\"]')").run();
  await env.DB.prepare("UPDATE platform_settings SET ingestion_enabled=0,discovery_enabled=0 WHERE source IN('youtube','bilibili')").run();
  const { pendingVideos, dispatchAutomatic } = await import('../processing');
  const { hasDueIngestionDispatch, dispatchIngestion } = await import('../platform-ingestion-dispatch');
  const vods = await rows(env, 'SELECT id,source_id FROM vods ORDER BY id');
  expect(await pendingVideos(env)).toEqual([{ id: vods[0].id }]);
  expect((await dispatchAutomatic(env, vods[1].id)).chunkIds).toEqual([]);
  const runtime = { ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test' };
  expect(await hasDueIngestionDispatch(runtime)).toBe(false);
  expect(await dispatchIngestion(runtime)).toEqual({ dispatched: false });
});

it('uses one EventSub filter and matches both event type and this environment callback', async () => {
  await env.DB.prepare("INSERT INTO streamers(id,login) VALUES(1,'reviewed')").run();
  const twitch = new Twitch({ ...env, PUBLIC_URL: 'https://validation.example' });
  const helix = vi.spyOn(twitch, 'helix').mockImplementation(async (endpoint, params, method, body) => {
    expect(endpoint).toBe('eventsub/subscriptions');
    if (method === 'POST') {
      expect(body).toMatchObject({ type: 'stream.offline', transport: { callback: 'https://validation.example/functions/v1/process-vod' } });
      return { data: [{ id: 'new-validation-subscription' }] };
    }
    expect(params).toEqual({ user_id: '1' });
    return { data: [
      { id: 'production', type: 'stream.offline', condition: { broadcaster_user_id: '1' }, status: 'enabled', transport: { callback: 'https://production.example/functions/v1/process-vod' } },
      { id: 'other-event', type: 'stream.online', condition: { broadcaster_user_id: '1' }, status: 'enabled', transport: { callback: 'https://validation.example/functions/v1/process-vod' } },
    ], pagination: {} };
  });
  await twitch.ensureSubscription(1);
  expect(helix).toHaveBeenCalledTimes(2);
  expect((await one(env, 'SELECT eventsub_subscription_id FROM streamers WHERE id=1'))!.eventsub_subscription_id).toBe('new-validation-subscription');
});

it("paginates archives through Helix, reads chapters by ID and publishes totals only at the end", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const twitch = new Twitch({ ...env, JOBS: { send } as unknown as Queue });
  await env.DB.prepare("INSERT INTO streamers(id,login,processing_enabled) VALUES(1,'archives',0)").run();
  let after: string | undefined;
  const helix = vi.spyOn(twitch, "helix").mockImplementation(async (endpoint, params) => {
    if (endpoint === "users") return { data: [{ id: "1", login: "archives" }] };
    if (endpoint === "streams") return { data: [{ id: "live" }] };
    if (endpoint === "search/categories") return { data: [{ id: "bazaar", name: "The Bazaar" }] };
    if (endpoint === "videos") {
      after = (params as Record<string, string>).after;
      return after ? { data: [{ id: "3" }], pagination: {} } : {
        data: [{ id: "live-recording" }, { id: "2" }], pagination: { cursor: "helix-next" },
      };
    }
    throw new Error("Unexpected endpoint");
  });
  const gql = vi.spyOn(twitch, "gql").mockImplementation(async (_query, variables) => ({
    video: { id: variables.id, title: "Archive", lengthSeconds: 60,
      publishedAt: "2026-09-01T00:00:00Z", game: { id: "bazaar" }, moments: { edges: [] } },
  }));
  await twitch.catalog(1);
  expect(gql).toHaveBeenCalledTimes(1);
  expect(gql.mock.calls[0][1]).toEqual({ id: "2" }); // Do not inspect the growing live archive.
  const continuation = send.mock.calls.map(([job]) => job).find(job => job.type === "catalog");
  expect(continuation).toMatchObject({ id: 1, cursor: "helix-next", catalogStats: { total: 1, bazaar: 1 } });
  expect((await one(env, "SELECT num_vods FROM streamers WHERE id=1"))!.num_vods).toBe(0);
  await twitch.catalog(1, continuation.cursor, false, continuation.catalogStats);
  expect(after).toBe("helix-next");
  expect(await one(env, "SELECT num_vods,num_bazaar_vods,processing_enabled FROM streamers WHERE id=1"))
    .toEqual({ num_vods: 2, num_bazaar_vods: 2, processing_enabled: 0 });
  expect((await rows(env, "SELECT source_id FROM vods ORDER BY source_id")).map(v => v.source_id)).toEqual(["2", "3"]);
  expect(send.mock.calls.filter(([job]) => job.type === "plan")).toHaveLength(0);
  expect(await rows(env, "SELECT id FROM chunks")).toHaveLength(0);
  helix.mockImplementation(async endpoint => {
    if (endpoint === "users") return { data: [{ id: "1", login: "archives" }] };
    if (endpoint === "streams") return { data: [] };
    return { data: [{ id: "3" }], pagination: { cursor: "helix-next" } };
  });
  await expect(twitch.catalog(1, "helix-next")).rejects.toThrow("pagination did not advance");
  expect(gql).toHaveBeenCalledTimes(2);
});

it("bounds routine catalog reconciliation to five pages and retires older unbounded continuations", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const twitch = new Twitch({ ...env, JOBS: { send } as unknown as Queue });
  await env.DB.prepare("INSERT INTO streamers(id,login,processing_enabled) VALUES(1,'bounded',0)").run();
  const helix = vi.spyOn(twitch, "helix").mockImplementation(async endpoint => {
    if (endpoint === "users") return { data: [{ id: "1", login: "bounded" }] };
    if (endpoint === "streams") return { data: [] };
    if (endpoint === "search/categories") return { data: [{ id: "bazaar", name: "The Bazaar" }] };
    return { data: [{ id: "99" }], pagination: { cursor: "more-history" } };
  });
  vi.spyOn(twitch, "gql").mockResolvedValue({ video: { id: "99", title: "Other game", lengthSeconds: 60,
    publishedAt: "2026-09-01T00:00:00Z", game: { id: "other" }, moments: { edges: [] } } });
  await twitch.catalog(1, "fifth-page", false, { total: 80, bazaar: 50, oldest: null }, 4);
  expect(send).not.toHaveBeenCalled();
  expect(await one(env, "SELECT num_vods,num_bazaar_vods FROM streamers WHERE id=1"))
    .toEqual({ num_vods: 81, num_bazaar_vods: 50 });
  helix.mockClear();
  await twitch.catalog(1, "old-unbounded-page", false, { total: 120, bazaar: 60, oldest: null });
  expect(helix).not.toHaveBeenCalled();
});
