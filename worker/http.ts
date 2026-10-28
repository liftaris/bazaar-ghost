import { timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(400, message);
}
/** Plain text remains plain text: clients must render it as text, never as HTML. */
export function text(value: unknown, label: string, max: number) {
  requireValue(typeof value === "string", `Invalid ${label}`);
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  const visible = normalized.replace(/[\n\t\u200d]/g, "");
  requireValue(!/[\p{Cc}\p{Cs}\p{Cf}]/u.test(visible) && /[^\p{White_Space}\p{M}]/u.test(visible) && [...normalized].length >= 1 && [...normalized].length <= max,
    `${label} must contain 1–${max} Unicode characters without control characters`);
  return normalized;
}
export async function authorized(
  req: Request,
  secret: string,
): Promise<boolean> {
  const candidate =
    req.headers.get("Authorization")?.replace(/^Bearer /, "") ||
    req.headers.get("apikey") ||
    "";
  if (!secret || !candidate) return false;
  const encode = (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [a, b] = await Promise.all([encode(secret), encode(candidate)]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
export async function readBytes(
  req: Request,
  limit = 2_000_000,
): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") || 0) > limit)
    throw new HttpError(413, "Request body too large");
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    parts.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
export async function readText(req: Request): Promise<string> {
  return new TextDecoder().decode(await readBytes(req));
}
export async function body(req: Request): Promise<Record<string, any>> {
  const raw = await readText(req);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  requireValue(
    data && typeof data === "object" && !Array.isArray(data),
    "Expected an object",
  );
  return data;
}
export function integer(
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  requireValue(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    `Invalid ${label}`,
  );
  return value;
}
export function uuid(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
    "Invalid UUID",
  );
  return value;
}
export const now = () => new Date().toISOString();
export function statement(
  env: Env,
  sql: string,
  ...args: unknown[]
): D1PreparedStatement {
  return env.DB.prepare(sql).bind(
    ...args.map((v) => (typeof v === "boolean" ? Number(v) : (v ?? null))),
  );
}
export async function rows<T = Record<string, any>>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  return (await statement(env, sql, ...args).all<T>()).results;
}
export async function one<T = Record<string, any>>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  return statement(env, sql, ...args).first<T>();
}
export function decodeRow(row: Record<string, any>): Record<string, any> {
  const result = { ...row };
  for (const key of ["bazaar_chapters", "crop_region", "igd_crop_region"])
    if (typeof result[key] === "string") result[key] = JSON.parse(result[key]);
  for (const key of [
    "old_templates",
    "notifications_enabled",
    "processing_enabled",
    "ready_for_processing",
    "has_vods",
    "opaque_edge",
    "truncated",
    "no_right_edge",
    "enabled",
  ])
    if (result[key] != null) result[key] = Boolean(result[key]);
  return result;
}
/** Outbound calls are opt-in; local work cannot accidentally dispatch jobs or notify Discord. */
export async function external(
  env: Env,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (env.OUTBOUND_ENABLED !== "true")
    throw new HttpError(503, "External integrations disabled");
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `Upstream ${new URL(url).hostname} returned ${response.status}`,
    );
  return response;
}
