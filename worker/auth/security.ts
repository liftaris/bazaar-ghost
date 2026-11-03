import { timingSafeEqual } from "node:crypto";
import { HttpError, readBytes, statement } from "../http";

export type AuthEnv = Env & {
  AUTH_ENABLED?: string;
  AUTH_SECRET?: string;
  DISCORD_AUTH_CLIENT_ID?: string;
  DISCORD_AUTH_CLIENT_SECRET?: string;
  TWITCH_AUTH_CLIENT_ID?: string;
  TWITCH_AUTH_CLIENT_SECRET?: string;
};
export interface Identity {
  userId: string;
  sessionId: string;
  name: string;
  image: string | null;
  createdAt: string;
  expiresAt: string;
  csrfToken: string;
}
export const FRESH_MS = 300_000;
export const sqlNow = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export const sqlDate = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function configuration(env: AuthEnv) {
  const base = new URL(env.PUBLIC_URL);
  const local = env.ENVIRONMENT === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((!local && base.protocol !== "https:") || !["http:", "https:"].includes(base.protocol) ||
      base.pathname !== "/" || base.search || base.hash || base.username || base.password)
    throw new HttpError(503, "Authentication requires a configured public origin");
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32)
    throw new HttpError(503, "Authentication is not configured");
  const origins = [...new Set([base.origin, ...env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)])];
  for (const value of origins) {
    const origin = new URL(value);
    if (origin.origin !== value || !["http:", "https:"].includes(origin.protocol) ||
        (origin.protocol !== "https:" && !(env.ENVIRONMENT === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))))
      throw new HttpError(503, "Authentication has an invalid trusted origin");
  }
  return { base: base.origin, origins, secure: base.protocol === "https:", secret: env.AUTH_SECRET };
}

export function requireOrigin(req: Request, env: AuthEnv) {
  if (!configuration(env).origins.includes(req.headers.get("Origin") || ""))
    throw new HttpError(403, "Untrusted request origin");
}
/** WebAuthn binds to the page origin. Browsers omit Origin on same-origin GETs; the frontend
 * proxies with the page URL, so a GET may fall back to the request URL's trusted origin. */
export function ceremonyOrigin(req: Request, env: AuthEnv) {
  const origin = req.headers.get("Origin") ?? (req.method === "GET" ? new URL(req.url).origin : "");
  if (!configuration(env).origins.includes(origin)) throw new HttpError(403, "Untrusted request origin");
  return origin;
}
export function requireFresh(identity: Identity) {
  const age = Date.now() - Date.parse(identity.createdAt);
  if (!Number.isFinite(age) || age < -60_000 || age > FRESH_MS)
    throw new HttpError(401, "Fresh login required");
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
export async function signature(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
export async function csrf(env: AuthEnv, userId: string, sessionId: string) {
  return signature(configuration(env).secret, `csrf:${userId}:${sessionId}`);
}
export async function requireCsrf(req: Request, env: AuthEnv, identity: Identity) {
  requireOrigin(req, env);
  const candidate = req.headers.get("X-CSRF-Token") || "";
  const expected = await csrf(env, identity.userId, identity.sessionId);
  if (!/^[a-f0-9]{64}$/.test(candidate) || !timingSafeEqual(new TextEncoder().encode(candidate), new TextEncoder().encode(expected)))
    throw new HttpError(403, "Invalid CSRF token");
}
/** A user may sign in only while they hold an OAuth account or a passkey. */
export const hasCredential = (alias: string) => `EXISTS(SELECT 1 FROM user_credentials c WHERE c.userId=${alias}.id)`;
/** Include this check in the SAME D1 batch as a custom authenticated mutation. */
export function identityCheck(identity: Identity, fresh = false) {
  return { sql: `EXISTS(SELECT 1 FROM user_sessions s JOIN app_users u ON u.id=s.userId
    WHERE s.id=? AND s.userId=? AND s.expiresAt>${sqlDate} AND u.status='active'
    AND ${hasCredential("u")}
    ${fresh ? "AND s.createdAt>strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 seconds')" : ""})`, args: [identity.sessionId, identity.userId] };
}
export async function jsonBody(req: Request, limit = 4096) {
  if (req.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new HttpError(415, "Expected application/json");
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(await readBytes(req, limit))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Expected an object");
  return data as Record<string, unknown>;
}
export function only(data: Record<string, unknown>, keys: string[]) {
  if (Object.keys(data).some(key => !keys.includes(key))) throw new HttpError(400, "Unsupported request parameters");
}
export function privateResponse(response: Response) {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}
export const sessionCookie = (env: AuthEnv) => `${configuration(env).secure ? "__Host-" : ""}bazaarghost_session`;
export function clearSessionCookie(env: AuthEnv, response: Response) {
  const { secure } = configuration(env);
  response.headers.append("Set-Cookie", `${sessionCookie(env)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  return response;
}
/** Cloudflare supplies CF-Connecting-IP. Never accept a user-controlled forwarded chain. */
export async function rateLimit(req: Request, env: AuthEnv, category: string, limit: number) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  // Collapse IPv6 to /64; rotating addresses within one allocation do not evade limits.
  let address = ip;
  try {
    if (ip.includes(":")) {
      const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
      const [left, right = ""] = normalized.split("::");
      const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
      address = [...a, ...Array(8-a.length-b.length).fill("0"), ...b].slice(0, 4).join(":");
    }
  } catch { address = "unknown"; }
  const minute = Math.floor(Date.now() / 60_000);
  const key = await signature(configuration(env).secret, `rate:${category}:${address}:${minute}`);
  const result = await statement(env, `INSERT INTO auth_rate_limits(key,count,expiresAt) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`, key, (minute + 2) * 60_000, limit).first();
  if (!result) throw new HttpError(429, "Too many authentication requests; try again shortly");
}
