import { HttpError, integer, now, one, readBytes, requireValue, statement, uuid } from "./http";
import { owned } from "./processing";
import { heroOptions, inferencePrompt, type InferenceTask } from "./sfde-prompts";

const MAX_IMAGE = 1024 * 1024;
const MAX_BODY = Math.ceil(MAX_IMAGE / 3) * 4 + 1024;
const TIMEOUT_MS = 60_000;
const NANO_USD = 1_000_000_000;
type JsonObject = Record<string, unknown>;
export interface InferenceResponse {
  status: "completed" | "pending" | "uncertain" | "disabled" | "budget_exhausted" | "chunk_limit";
  task: InferenceTask;
  model: string;
  prompt_version: string;
  result: JsonObject | null;
  usage: JsonObject | null;
  cached: boolean;
}
interface Ledger {
  chunk_id: string;
  body_sha256: string;
  task: string;
  model: string;
  prompt_version: string;
  status: "pending" | "completed" | "uncertain";
  response_json: string | null;
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
function image(base64: unknown): { content_type: string; base64: string } {
  requireValue(typeof base64 === "string" && base64.length > 0 && base64.length <= Math.ceil(MAX_IMAGE / 3) * 4,
    "Image must be base64 PNG/JPEG, at most 1 MiB decoded");
  // Keep the regexp linear/simple even for a full 1 MiB image; atob + the
  // canonical round trip below enforce padding and unused-bit correctness.
  requireValue(base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), "Invalid image base64");
  let decoded: string;
  try { decoded = atob(base64); } catch { throw new HttpError(400, "Invalid image base64"); }
  requireValue(decoded.length > 0 && decoded.length <= MAX_IMAGE && btoa(decoded) === base64, "Invalid image size or encoding");
  const png = decoded.startsWith("\x89PNG\r\n\x1a\n");
  const jpeg = decoded.startsWith("\xff\xd8\xff");
  requireValue(png || jpeg, "Expected PNG/JPEG magic bytes");
  return { content_type: png ? "image/png" : "image/jpeg", base64 };
}
// Accept only bounded JSON; never persist echoed embedded media or provider errors.
function boundedResult(value: unknown, inputBase64: string): JsonObject | null {
  let nodes = 0;
  function safe(v: unknown, depth: number): boolean {
    if (++nodes > 2000 || depth > 8) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string") return v.length <= 2048 && !/data:|bearer\s/i.test(v) && !v.includes(inputBase64);
    if (Array.isArray(v)) return v.length <= 128 && v.every(item => safe(item, depth + 1));
    if (!object(v)) return false;
    return Object.entries(v).every(([key, item]) => key.length <= 100 && !/^(images?|base64|image_base64|authorization|secret|token)$/i.test(key) && safe(item, depth + 1));
  }
  if (!object(value) || !safe(value, 0)) return null;
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > 64 * 1024) return null;
  return value;
}
function validUsage(result: JsonObject, task: InferenceTask, context: number): JsonObject | null {
  const usage = result.usage;
  if (!object(usage) || !Number.isSafeInteger(usage.input_tokens) || (usage.input_tokens as number) < 0 ||
      (usage.input_tokens as number) > context || usage.output_tokens !== 0) return null;
  for (const key of ["state_tokens", "image_tokens", "schema_tokens"]) {
    if (key in usage && (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0 || (usage[key] as number) > context)) return null;
  }
  if (task === "clock_day" && (!Number.isSafeInteger(usage.passes) || (usage.passes as number) < 1 || (usage.passes as number) > 3)) return null;
  // Keep the envelope small: the complete provider usage already remains in
  // result. Duplicating arbitrary usage metadata can exceed the ledger limit
  // even when the raw result passed its own 64 KiB bound.
  return Object.fromEntries(["input_tokens", "output_tokens", "state_tokens", "image_tokens", "schema_tokens", "passes"]
    .filter(key => key in usage).map(key => [key, usage[key]]));
}
function validAnswers(result: JsonObject, task: InferenceTask, model: string): boolean {
  if (![model, model.replace("@cf/cloudflare/", "")].includes(String(result.model)) || !object(result.answers)) return false;
  if (task === "clock_day") return typeof result.truncated === "boolean" &&
    ["day", "wins_earned", "lethal"].every(key => {
      const answer = (result.answers as JsonObject)[key];
      return object(answer) && typeof answer.type === "string" && Object.hasOwn(answer, "value");
    });
  const answer = result.answers.hero;
  if (!object(answer) || answer.type !== "choice" || !heroOptions.includes(String(answer.choice)) ||
      typeof answer.confidence !== "number" || answer.confidence < 0 || answer.confidence > 1 || !object(answer.probabilities)) return false;
  const probabilities = answer.probabilities;
  if (Object.keys(probabilities).length !== heroOptions.length || !heroOptions.every(key =>
    typeof probabilities[key] === "number" && (probabilities[key] as number) >= 0 && (probabilities[key] as number) <= 1)) return false;
  return Math.abs(Object.values(probabilities).reduce<number>((sum, p) => sum + (p as number), 0) - 1) <= 0.01;
}

/** Outer processor route MUST authenticate PROCESSOR_KEY before invoking this. */
export async function infer(env: Env, req: Request, chunkId: string): Promise<InferenceResponse> {
  const token = req.headers.get("X-Claim-Token");
  const chunk = await owned(env, chunkId, token);
  let input: unknown;
  try { input = JSON.parse(new TextDecoder().decode(await readBytes(req, MAX_BODY))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid JSON"); }
  requireValue(object(input) && Object.keys(input).sort().join(",") === "at_ms,image_base64,request_id,task", "Expected request_id, task, at_ms, image_base64 only");
  const requestId = uuid(input.request_id).toLowerCase();
  requireValue(input.task === "ghost_hero" || input.task === "streamer_hero" || input.task === "clock_day", "Invalid inference task");
  const task = input.task;
  const atMs = integer(input.at_ms, "at_ms");
  requireValue(atMs >= chunk.start_seconds * 1000 && atMs < chunk.end_seconds * 1000, "Frame outside chunk");
  const embeddedImage = image(input.image_base64);
  const prompt = inferencePrompt(task);
  const model = task === "clock_day" ? "@cf/cloudflare/clairic" : "@cf/cloudflare/clef-flash";
  const promptVersion = `${task === "clock_day" ? "BG116-three-numeric-v1" : "hero-eight-v1"}:${await sha256(JSON.stringify(prompt))}`;
  const response = (status: InferenceResponse["status"], result: JsonObject | null = null, usage: JsonObject | null = null): InferenceResponse =>
    ({ status, task, model, prompt_version: promptVersion, result, usage, cached: false });
  if (env.SFDE_AI_ENABLED !== "true" || !["local", "validation"].includes(env.ENVIRONMENT) || !env.AI) return response("disabled");
  const configuredBudget = Number(env.SFDE_AI_DAILY_BUDGET_USD);
  if (!Number.isFinite(configuredBudget) || configuredBudget <= 0 || configuredBudget > 1) return response("disabled");
  const budget = Math.floor(configuredBudget * NANO_USD);
  const bodyHash = await sha256(JSON.stringify({ chunk_id: chunkId, task, at_ms: atMs, image_base64: embeddedImage.base64 }));
  const cached = async (): Promise<InferenceResponse | null> => {
    const row = await one<Ledger>(env, "SELECT * FROM sfde_inference WHERE request_id=?", requestId);
    if (!row) return null;
    if (row.chunk_id !== chunkId || row.body_sha256 !== bodyHash || row.task !== task || row.model !== model || row.prompt_version !== promptVersion)
      throw new HttpError(409, "Inference request_id conflicts with body/task/prompt");
    await owned(env, chunkId, token);
    return row.status === "completed" && row.response_json
      ? { ...JSON.parse(row.response_json) as InferenceResponse, cached: true }
      : { ...response(row.status), cached: true };
  };
  const previous = await cached();
  if (previous) return previous;
  const context = task === "clock_day" ? 65_536 : 24_576;
  const nanoPerToken = task === "clock_day" ? 100 : 38;
  const reservation = context * nanoPerToken;
  // A single serialized INSERT SELECT is the reservation transaction. All workers
  // share these counters, and claim/time fencing is inside the write, not a read.
  const reserved = await statement(env, `INSERT INTO sfde_inference
    (request_id,chunk_id,body_sha256,task,model,prompt_version,utc_day,status,reserved_nano_usd,charged_nano_usd,created_at,updated_at)
    SELECT ?,?,?,?,?,?,strftime('%Y-%m-%d','now'),'pending',?,?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE EXISTS(SELECT 1 FROM chunks c JOIN vod_processing_context v ON v.id=c.vod_id
      WHERE c.id=? AND c.claim_token=? AND c.status='processing'
      AND c.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND c.start_seconds*1000<=? AND c.end_seconds*1000>?)
    AND (SELECT count(*) FROM sfde_inference WHERE chunk_id=?)<64
    AND (SELECT coalesce(sum(charged_nano_usd),0) FROM sfde_inference WHERE utc_day=strftime('%Y-%m-%d','now'))+?<=?
    ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
    requestId, chunkId, bodyHash, task, model, promptVersion, reservation, reservation,
    chunkId, token, atMs, atMs, chunkId, reservation, budget).first();
  if (!reserved) {
    await owned(env, chunkId, token); // Stale claims never learn budget state.
    const raced = await cached();
    if (raced) return raced;
    const count = await one<{ n: number }>(env, "SELECT count(*) AS n FROM sfde_inference WHERE chunk_id=?", chunkId);
    return response(count && count.n >= 64 ? "chunk_limit" : "budget_exhausted");
  }
  let output = response("uncertain");
  let actual: number | null = null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Native AI binding, documented model schema. Unknown-model overload is
    // intentional: current generated AiModels does not yet list Clef/Clairic.
    const call = env.AI.run(model, { ...prompt, images: [embeddedImage] }, {
      signal: controller.signal,
      tags: ["sfde", env.ENVIRONMENT, task.replaceAll("_", "-")],
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Inference timeout")); }, TIMEOUT_MS);
    });
    const raw = await Promise.race([call, timeout]);
    const result = boundedResult(raw, embeddedImage.base64);
    const usage = result ? validUsage(result, task, context) : null;
    if (result && usage && validAnswers(result, task, model)) {
      actual = (usage.input_tokens as number) * nanoPerToken;
      output = response("completed", result, usage);
    } else output = response("uncertain", result, usage);
  } catch {
    // Timeout, provider error, or ambiguous transport: never refund or retry.
    // Do not expose provider exceptions, which can contain embedded input.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await statement(env, `UPDATE sfde_inference SET status=?,response_json=?,actual_nano_usd=?,charged_nano_usd=?,updated_at=?
    WHERE request_id=? AND status='pending'`, output.status, JSON.stringify(output), actual,
    actual ?? reservation, now(), requestId).run();
  return output;
}
