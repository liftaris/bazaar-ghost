import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError, one, statement } from "../http";
import worker from "../index";
import { claim, plan } from "../processing";
import { infer } from "../sfde-inference";
import { heroOptions, inferencePrompt } from "../sfde-prompts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
let chunkId: string;
let token: string;
function heroResult() {
  return { model: "clef-flash", answers: { hero: { type: "choice", choice: "Dooley", confidence: 0,
    probabilities: Object.fromEntries(heroOptions.map(option => [option, 0.125])) } },
    usage: { input_tokens: 1000, output_tokens: 0 } };
}
function gateway(run: (model: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown> = vi.fn(async () => heroResult())) {
  // Real D1; only the AI binding is replaced. No live inference or fetch.
  const ai = { run } as Ai;
  return { ...env, AI: ai, SFDE_AI_ENABLED: "true", SFDE_AI_DAILY_BUDGET_USD: "1" };
}
function request(changes: Record<string, unknown> = {}, id = crypto.randomUUID(), claimToken: string | null = token) {
  return new Request("http://local/api/processor/chunks/" + chunkId + "/inference", {
    method: "POST", headers: { "Content-Type": "application/json", ...(claimToken ? { "X-Claim-Token": claimToken } : {}) },
    body: JSON.stringify({ request_id: id, task: "ghost_hero", at_ms: 12000, image_base64: png, ...changes }),
  });
}
beforeEach(async () => {
  await statement(env, "DELETE FROM sfde_inference").run();
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'inference','[0,0,1,1]')").run();
  await statement(env, "INSERT INTO streamers(id,login) VALUES(1,'inference')").run();
  await statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,bazaar_chapters,ready_for_processing) VALUES(1,1,'inference',1800,'[0,1800]',1)").run();
  [ { id: chunkId } ] = await plan(env, 1);
  token = (await claim(env, chunkId)).claim_token!;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected outbound request"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires outer processor authorization and exact owned, live claims", async () => {
  const run = vi.fn(async () => heroResult());
  const settings = gateway(run);
  expect((await worker.fetch(request(), settings)).status).toBe(401);
  const wrongKey = request();
  wrongKey.headers.set("Authorization", "Bearer wrong-processor-key");
  expect((await worker.fetch(wrongKey, settings)).status).toBe(401);
  await expect(infer(settings, request({}, undefined, null), chunkId)).rejects.toMatchObject({ status: 409 });
  await expect(infer(settings, request({}, undefined, "other-runner"), chunkId)).rejects.toMatchObject({ status: 409 });
  await statement(env, "UPDATE chunks SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?", chunkId).run();
  await expect(infer(settings, request(), chunkId)).rejects.toMatchObject({ status: 409 });
  expect(run).not.toHaveBeenCalled();
  expect((await one(env, "SELECT count(*) AS n FROM sfde_inference"))!.n).toBe(0);
});

it("routes authenticated inference through claim checks and returns the native result envelope", async () => {
  const run = vi.fn(async () => heroResult());
  const settings = gateway(run);
  const missingClaim = request({}, undefined, null);
  missingClaim.headers.set("Authorization", `Bearer ${env.PROCESSOR_KEY}`);
  expect((await worker.fetch(missingClaim, settings)).status).toBe(409);
  expect(run).not.toHaveBeenCalled();
  const valid = request();
  valid.headers.set("Authorization", `Bearer ${env.PROCESSOR_KEY}`);
  const response = await worker.fetch(valid, settings);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "completed", result: heroResult(), cached: false });
  expect(run).toHaveBeenCalledTimes(1);
});

it("defaults off and refuses other environments or enlarged/invalid budgets", async () => {
  const run = vi.fn(async () => heroResult());
  for (const overrides of [{ SFDE_AI_ENABLED: "false" }, { ENVIRONMENT: "production" }, { ENVIRONMENT: "dev" },
    { SFDE_AI_DAILY_BUDGET_USD: "2" }, { SFDE_AI_DAILY_BUDGET_USD: "NaN" }, { SFDE_AI_DAILY_BUDGET_USD: "0" }]) {
    expect((await infer({ ...gateway(run), ...overrides }, request(), chunkId)).status).toBe("disabled");
  }
  expect(run).not.toHaveBeenCalled();
});

it("validates exact tasks, UUID, times, base64 decoded size, magic, and body bounds before spending", async () => {
  const run = vi.fn(async () => heroResult());
  for (const input of [{ task: "custom" }, { request_id: "not-uuid" }, { at_ms: -1 }, { at_ms: 1800000 },
    { at_ms: 1.5 }, { model: "custom" }, { prompt: "custom" }, { image_base64: "https://example.com/image.png" },
    { image_base64: "data:image/png;base64," + png }, { image_base64: "AAAA" }, { image_base64: png + "!" },
    { image_base64: btoa("\x89PNG\r\n\x1a\n" + "a".repeat(1024 * 1024)) }]) {
    await expect(infer(gateway(run), request(input), chunkId)).rejects.toBeInstanceOf(HttpError);
  }
  const oversized = new Request("http://local", { method: "POST", headers: { "X-Claim-Token": token }, body: " ".repeat(1_400_000) });
  await expect(infer(gateway(run), oversized, chunkId)).rejects.toMatchObject({ status: 413 });
  expect(run).not.toHaveBeenCalled();
});

it("reserves before native binding invocation, settles valid usage, and stores no image", async () => {
  const run = vi.fn(async (model: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => {
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input).toEqual({ ...inferencePrompt("ghost_hero"), images: [{ content_type: "image/png", base64: png }] });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options).toMatchObject({ tags: ["sfde", "local", "ghost-hero"] });
    const ledger = await one(env, "SELECT * FROM sfde_inference");
    expect(ledger).toMatchObject({ status: "pending", reserved_nano_usd: 933888, charged_nano_usd: 933888 });
    return heroResult();
  });
  const response = await infer(gateway(run), request(), chunkId);
  expect(response).toMatchObject({ status: "completed", cached: false, usage: { input_tokens: 1000 } });
  expect(response.prompt_version).toMatch(/^hero-eight-v1:[0-9a-f]{64}$/);
  expect(run.mock.calls).toHaveLength(1);
  const ledger = await one(env, "SELECT * FROM sfde_inference");
  expect(ledger).toMatchObject({ actual_nano_usd: 38000, charged_nano_usd: 38000 });
  expect(JSON.stringify(ledger)).not.toContain(png);
  expect(JSON.stringify(ledger)).not.toContain(token);
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts JPEG and a full 1 MiB decoded PNG without fetching remote images", async () => {
  const run = vi.fn(async () => heroResult());
  const settings = gateway(run);
  const jpeg = btoa("\xff\xd8\xff\xd9");
  expect((await infer(settings, request({ image_base64: jpeg }), chunkId)).status).toBe("completed");
  const fullSize = btoa("\x89PNG\r\n\x1a\n" + "a".repeat(1024 * 1024 - 8));
  expect((await infer(settings, request({ image_base64: fullSize }), chunkId)).status).toBe("completed");
  expect(run).toHaveBeenCalledTimes(2);
});

it("persists bounded provider usage metadata once without overflowing the response ledger", async () => {
  const result = heroResult();
  const raw = { ...result, usage: { ...result.usage, diagnostics: Array(30).fill("x".repeat(1900)) } };
  const run = vi.fn(async () => raw);
  const settings = gateway(run);
  const id = crypto.randomUUID();
  const response = await infer(settings, request({}, id), chunkId);
  expect(response.status).toBe("completed");
  expect(response.usage).toEqual(result.usage);
  expect(response.result).toEqual(raw);
  const ledger = await one<{ response_json: string }>(env, "SELECT response_json FROM sfde_inference WHERE request_id=?", id);
  expect(ledger!.response_json.length).toBeLessThan(70000);
  expect(await infer(settings, request({}, id), chunkId)).toEqual({ ...response, cached: true });
  expect(run).toHaveBeenCalledTimes(1);
});

it("never resubmits pending, uncertain or completed request IDs and conflicts on changed bodies/prompts", async () => {
  let release!: (value: ReturnType<typeof heroResult>) => void;
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => { started = resolve; });
  const run = vi.fn(() => { started(); return new Promise<ReturnType<typeof heroResult>>(resolve => { release = resolve; }); });
  const settings = gateway(run);
  const id = crypto.randomUUID();
  const first = infer(settings, request({}, id), chunkId);
  await hasStarted;
  expect(await infer(settings, request({}, id), chunkId)).toMatchObject({ status: "pending", cached: true, result: null });
  await expect(infer(settings, request({ at_ms: 12001 }, id), chunkId)).rejects.toMatchObject({ status: 409 });
  await expect(infer(settings, request({ task: "streamer_hero" }, id), chunkId)).rejects.toMatchObject({ status: 409 });
  release(heroResult());
  const completed = await first;
  expect(await infer(settings, request({}, id), chunkId)).toEqual({ ...completed, cached: true });
  await statement(env, "UPDATE sfde_inference SET prompt_version='old-version' WHERE request_id=?", id).run();
  await expect(infer(settings, request({}, id), chunkId)).rejects.toMatchObject({ status: 409 });
  expect(run).toHaveBeenCalledTimes(1);
});

async function fill(n: number, day = new Date().toISOString().slice(0, 10), charge = 933888) {
  await env.DB.batch(Array.from({ length: n }, () => statement(env, `INSERT INTO sfde_inference
    (request_id,chunk_id,body_sha256,task,model,prompt_version,utc_day,status,reserved_nano_usd,charged_nano_usd,created_at,updated_at)
    VALUES(?,?,'hash','ghost_hero','model','version',?,'uncertain',?,?,?,?)`,
    crypto.randomUUID(), chunkId, day, charge, charge, new Date().toISOString(), new Date().toISOString())));
}

it("atomically enforces 64 attempts per chunk under races", async () => {
  await fill(63);
  const run = vi.fn(async () => heroResult());
  const responses = await Promise.all(Array.from({ length: 3 }, () => infer(gateway(run), request(), chunkId)));
  expect(responses.map(r => r.status).sort()).toEqual(["chunk_limit", "chunk_limit", "completed"]);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await one(env, "SELECT count(*) AS n FROM sfde_inference"))!.n).toBe(64);
});

it("shares atomic daily reservations across worker objects and tasks", async () => {
  const run = vi.fn(async () => ({ ...heroResult(), usage: undefined }));
  const responses = await Promise.all(Array.from({ length: 3 }, () =>
    infer({ ...gateway(run), SFDE_AI_DAILY_BUDGET_USD: "0.001" }, request(), chunkId)));
  expect(responses.map(r => r.status).sort()).toEqual(["budget_exhausted", "budget_exhausted", "uncertain"]);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await infer({ ...gateway(), SFDE_AI_DAILY_BUDGET_USD: "0.001" }, request({ task: "clock_day" }), chunkId)).status).toBe("budget_exhausted");
});

it("keeps failed/missing/invalid usage conservative and uncertain duplicates do not resubmit", async () => {
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 24577, output_tokens: 0 },
    { input_tokens: 1000, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 0 }]) {
    const run = vi.fn(async () => ({ ...heroResult(), usage }));
    const settings = gateway(run);
    const id = crypto.randomUUID();
    expect((await infer(settings, request({}, id), chunkId)).status).toBe("uncertain");
    expect(await infer(settings, request({}, id), chunkId)).toMatchObject({ status: "uncertain", cached: true, result: null });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await one(env, "SELECT charged_nano_usd,actual_nano_usd FROM sfde_inference WHERE request_id=?", id))
      .toEqual({ charged_nano_usd: 933888, actual_nano_usd: null });
  }
  const run = vi.fn(async () => { throw new Error("provider error data:image/png;base64," + png); });
  expect((await infer(gateway(run), request(), chunkId)).status).toBe("uncertain");
  expect(run).toHaveBeenCalledTimes(1);
});

it("times out once, signals cancellation, and retains the full reservation", async () => {
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => realSetTimeout(handler, ms === 60000 ? 0 : ms, ...args));
  let signal: AbortSignal | undefined;
  const run = vi.fn((_model: string, _input: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise<ReturnType<typeof heroResult>>(() => {});
  });
  const id = crypto.randomUUID();
  const settings = gateway(run);
  expect((await infer(settings, request({}, id), chunkId)).status).toBe("uncertain");
  expect(signal?.aborted).toBe(true);
  expect((await infer(settings, request({}, id), chunkId)).status).toBe("uncertain");
  expect(run).toHaveBeenCalledTimes(1);
  expect((await one(env, "SELECT charged_nano_usd FROM sfde_inference"))!.charged_nano_usd).toBe(933888);
});

it("resets only the UTC daily sum, retaining old reservations and chunk attempts", async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await fill(1, yesterday, 1_000_000_000);
  expect((await infer(gateway(), request(), chunkId)).status).toBe("completed");
  const today = new Date().toISOString().slice(0, 10);
  await fill(1, today, 1_000_000_000);
  expect((await infer(gateway(), request(), chunkId)).status).toBe("budget_exhausted");
});

it("rechecks claim ownership atomically before reserving and never leaks budget through stale claims", async () => {
  const settings = gateway();
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const original = target.prepare(sql);
      if (!sql.startsWith("INSERT INTO sfde_inference")) return original;
      return new Proxy(original, { get(s, method) {
        if (method === "bind") return (...args: unknown[]) => {
          const bound = s.bind(...args);
          return new Proxy(bound, { get(b, call) {
            if (call === "first") return async () => {
              await statement(env, "UPDATE chunks SET claim_token='new-runner' WHERE id=?", chunkId).run();
              return b.first();
            };
            const value = Reflect.get(b, call); return typeof value === "function" ? value.bind(b) : value;
          } });
        };
        const value = Reflect.get(s, method); return typeof value === "function" ? value.bind(s) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(infer({ ...settings, DB: db }, request(), chunkId)).rejects.toMatchObject({ status: 409 });
  expect((await one(env, "SELECT count(*) AS n FROM sfde_inference"))!.n).toBe(0);
});

it("returns unchanged clock raw values including zero/false/null, with a separate prompt hash and full context reserve", async () => {
  const raw = { model: "clairic", truncated: false, answers: {
    day: { type: "number", value: 0, confidence: 0 }, wins_earned: { type: "number", value: null }, lethal: { type: "number", value: false },
  }, usage: { input_tokens: 495, output_tokens: 0, state_tokens: 90, image_tokens: 70, schema_tokens: 335, passes: 1 } };
  const run = vi.fn(async () => {
    expect((await one(env, "SELECT charged_nano_usd FROM sfde_inference"))!.charged_nano_usd).toBe(6553600);
    return raw;
  });
  const response = await infer(gateway(run), request({ task: "clock_day" }), chunkId);
  expect(response).toMatchObject({ status: "completed", result: raw });
  expect(response.prompt_version).toMatch(/^BG116-three-numeric-v1:[0-9a-f]{64}$/);
  expect((await one(env, "SELECT actual_nano_usd FROM sfde_inference"))!.actual_nano_usd).toBe(49500);
  expect(inferencePrompt("clock_day")).toHaveProperty("fields.lethal");
});

it("rejects unbounded, echoed media and malformed probability results without refunding", async () => {
  for (const raw of [{ ...heroResult(), state_text: "data:image/png;base64," + png },
    { ...heroResult(), extra: "x".repeat(70000) }, { ...heroResult(), answers: { hero: { probabilities: { Dooley: 2 } } } }]) {
    const run = vi.fn(async () => raw);
    const response = await infer(gateway(run), request(), chunkId);
    expect(response.status).toBe("uncertain");
  }
  expect((await one(env, "SELECT sum(charged_nano_usd) AS total FROM sfde_inference"))!.total).toBe(933888 * 3);
  expect(JSON.stringify((await statement(env, "SELECT response_json FROM sfde_inference").all()).results)).not.toContain(png);
});
