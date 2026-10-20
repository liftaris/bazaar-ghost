import { timingSafeEqual } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { atomic } from "./atomic";
import { external, HttpError, now, one, readBytes, statement, uuid } from "./http";
import { enqueueStatement } from "./platforms";
import { accountIdentity } from "./platform-registry";

const ATOM = "http://www.w3.org/2005/Atom";
const YOUTUBE = "http://www.youtube.com/xml/schemas/2015";
const DENIED = "Hub denied subscription; polling remains active";
const HOUR = 3_600_000;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const randomSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));

interface Subscription {
  account_id: string;
  callback_token: string;
  secret: string;
  source_id: string;
  requested_at: string | null;
  confirmed_at: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
}
export function topic(channelId: string) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${accountIdentity("youtube", channelId)}`;
}
function response(status: number, text: string | null = null) {
  return new Response(text, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}

/** Polling remains usable if the optional hub is disabled, delayed, or unavailable. */
export async function renewSubscription(env: Env, accountId: string, checks: Array<{sql: string; args: unknown[]}> = []): Promise<{ requested: boolean }> {
  uuid(accountId);
  if (env.OUTBOUND_ENABLED !== "true" || env.ENVIRONMENT === "local") return { requested: false };
  const base = new URL(env.PUBLIC_URL);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
      base.pathname !== "/" || ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new HttpError(400, "WebSub requires the configured public HTTPS origin");
  const account = await one<{source_id: string}>(env,
    "SELECT source_id FROM platform_accounts WHERE id=? AND source='youtube' AND processing_enabled=1", accountId);
  if (!account) return { requested: false };
  const channelTopic = topic(account.source_id);
  const insert = statement(env, `INSERT INTO youtube_websub_subscriptions(account_id,callback_token,secret)
    SELECT id,?,? FROM platform_accounts WHERE id=? AND source='youtube' AND source_id=? AND processing_enabled=1
    ON CONFLICT(account_id) DO NOTHING`, randomSecret(), randomSecret(), accountId, account.source_id);
  const time = now(), cutoff = new Date(Date.now() - HOUR).toISOString();
  // Claim the renewal in one statement. Concurrent catalogers cannot send overlapping requests.
  // Keep the current callback/secret while renewing a live lease. Rotate after expiry/denial.
  const renewal = statement(env, `UPDATE youtube_websub_subscriptions SET
    callback_token=CASE WHEN confirmed_at IS NULL OR lease_expires_at<=? THEN ? ELSE callback_token END,
    secret=CASE WHEN confirmed_at IS NULL OR lease_expires_at<=? THEN ? ELSE secret END,
    requested_at=?,last_error=NULL WHERE account_id=?
    AND (confirmed_at IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)
    AND (requested_at IS NULL OR requested_at<=?)
    AND NOT(last_error IS ? AND lease_expires_at>?)
    AND EXISTS(SELECT 1 FROM platform_accounts WHERE id=? AND source='youtube' AND source_id=? AND processing_enabled=1)
    RETURNING *`, time, randomSecret(), time, randomSecret(), time, accountId,
    new Date(Date.now() + 12 * HOUR).toISOString(), cutoff, DENIED, cutoff, accountId, account.source_id);
  const committed = await atomic(env, checks, [insert, renewal]);
  const claimed = committed[checks.length + 1].results[0] as Subscription | undefined;
  if (!claimed) return { requested: false };
  const callback = new URL("/functions/v1/youtube-webhook", base);
  callback.searchParams.set("account", accountId);
  callback.searchParams.set("token", claimed.callback_token);
  // Fence again immediately before network I/O; D1 cannot transact with a remote hub.
  if (checks.length) await atomic(env, checks, [statement(env, 'SELECT 1')]);
  try {
    const upstream = await external(env, "https://pubsubhubbub.appspot.com/subscribe", {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "hub.mode": "subscribe", "hub.callback": callback.href,
        "hub.topic": channelTopic, "hub.verify": "async", "hub.lease_seconds": "864000", "hub.secret": claimed.secret }),
    });
    await upstream.body?.cancel();
    if (![202, 204].includes(upstream.status)) throw new Error("Hub did not accept the subscription");
    return { requested: true };
  } catch {
    // A lost HTTP response does not prove the hub rejected it. Keep the pending challenge,
    // and fence this error so it cannot overwrite an asynchronous successful verification.
    await atomic(env, checks, [statement(env, `UPDATE youtube_websub_subscriptions SET last_error=?
      WHERE account_id=? AND callback_token=? AND requested_at=?`,
    "Subscription request failed; polling remains active", accountId, claimed.callback_token, time)]);
    return { requested: false };
  }
}

export async function validSignature(bytes: Uint8Array, header: string | null, secret: string) {
  const match = /^(sha1|sha256|sha384|sha512)=([a-fA-F0-9]+)$/.exec(header || "");
  const lengths: Record<string, number> = { sha1: 40, sha256: 64, sha384: 96, sha512: 128 };
  if (!match || match[2].length !== lengths[match[1]]) return false;
  const signature = Uint8Array.from(match[2].match(/../g)!, b => parseInt(b, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: match[1].replace("sha", "SHA-") }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, new Uint8Array(bytes));
}

type OrderedNode = Record<string, unknown>;
interface Element { uri: string; local: string; children: Element[]; text: string; }
/** Resolve expanded XML names, including nested declarations, without trusting a prefix's spelling. */
function elements(nodes: OrderedNode[], inherited: Record<string, string>, depth = 0): Element[] {
  if (depth > 32) throw new Error("XML nesting limit exceeded");
  const result: Element[] = [];
  for (const node of nodes) {
    for (const [name, value] of Object.entries(node)) {
      if (name === ":@" || name === "#text" || name === "#comment" || name === "#cdata" || name === "?xml") continue;
      if (name.startsWith("?") || !Array.isArray(value)) throw new Error("Invalid XML element");
      const ns = { ...inherited };
      const attributes = (node[":@"] || {}) as Record<string, string>;
      for (const [key, uri] of Object.entries(attributes)) {
        if (key === "@_xmlns") ns[""] = uri;
        else if (key.startsWith("@_xmlns:")) ns[key.slice(8)] = uri;
      }
      const parts = name.split(":"), prefix = parts.length === 2 ? parts[0] : "";
      if (parts.length > 2 || (prefix && !ns[prefix])) throw new Error("Unbound XML namespace");
      const children = value as OrderedNode[];
      result.push({ uri: ns[prefix] || "", local: parts.at(-1)!, children: elements(children, ns, depth + 1),
        text: children.map(child => String(child["#text"] ?? (Array.isArray(child["#cdata"]) ? child["#cdata"].map(part => String(part["#text"] ?? "")).join("") : ""))).join("").trim() });
    }
  }
  return result;
}
export function videoIds(xml: string, channelId: string): string[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid notification XML");
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false,
    removeNSPrefix: false, processEntities: false, parseTagValue: false, parseAttributeValue: false,
    cdataPropName: "#cdata", commentPropName: "#comment" });
  const root = elements(parser.parse(xml) as OrderedNode[], { xml: "http://www.w3.org/XML/1998/namespace" });
  if (root.length !== 1 || root[0].uri !== ATOM || root[0].local !== "feed") throw new Error("Expected an Atom feed");
  const entries = root[0].children.filter(e => e.uri === ATOM && e.local === "entry");
  if (entries.length > 100) throw new Error("Too many entries");
  const ids = entries.map(entry => {
    const channels = entry.children.filter(e => e.uri === YOUTUBE && e.local === "channelId");
    const videos = entry.children.filter(e => e.uri === YOUTUBE && e.local === "videoId");
    if (channels.length !== 1 || videos.length !== 1 || channels[0].children.length || videos[0].children.length ||
        channels[0].text !== channelId || !/^[A-Za-z0-9_-]{11}$/.test(videos[0].text))
      throw new Error("Notification account/video mismatch");
    return videos[0].text;
  });
  return [...new Set(ids)];
}

function enabledCheck(s: Subscription, time: string) {
  return { sql: `SELECT EXISTS(SELECT 1 FROM youtube_websub_subscriptions y JOIN platform_accounts a ON a.id=y.account_id
    WHERE y.account_id=? AND y.callback_token=? AND y.secret=? AND y.confirmed_at IS NOT NULL AND y.lease_expires_at>?
    AND a.source='youtube' AND a.source_id=? AND a.processing_enabled=1)`,
  args: [s.account_id, s.callback_token, s.secret, time, s.source_id] };
}
async function route(req: Request, env: Env) {
  if (!["GET", "POST"].includes(req.method)) return response(405);
  const url = new URL(req.url), accountId = url.searchParams.get("account") || "", token = url.searchParams.get("token") || "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(accountId) ||
      !/^[a-f0-9]{64}$/.test(token) || url.searchParams.getAll("account").length !== 1 || url.searchParams.getAll("token").length !== 1)
    return response(404);
  const s = await one<Subscription>(env, `SELECT y.*,a.source_id FROM youtube_websub_subscriptions y
    JOIN platform_accounts a ON a.id=y.account_id WHERE y.account_id=? AND a.source='youtube' AND a.processing_enabled=1`, accountId);
  if (!s || !timingSafeEqual(new TextEncoder().encode(s.callback_token), new TextEncoder().encode(token))) return response(404);
  if (req.method === "GET") {
    for (const key of ["hub.mode", "hub.topic", "hub.challenge", "hub.lease_seconds"])
      if (url.searchParams.getAll(key).length > 1) return response(404);
    if (url.searchParams.get("hub.topic") !== topic(s.source_id)) return response(404);
    const time = now();
    if (url.searchParams.get("hub.mode") === "denied") {
      // Hubs may deny an already confirmed subscription. Consume pending intent too;
      // a replayed challenge must not resurrect the denied subscription.
      await statement(env, `UPDATE youtube_websub_subscriptions SET last_error=?,requested_at=NULL,confirmed_at=NULL,lease_expires_at=?
        WHERE account_id=? AND callback_token=? AND (requested_at IS NOT NULL OR confirmed_at IS NOT NULL)
        AND EXISTS(SELECT 1 FROM platform_accounts WHERE id=? AND source='youtube' AND source_id=? AND processing_enabled=1)`,
      DENIED, time, accountId, token, accountId, s.source_id).run();
      return response(204);
    }
    const requested = Date.parse(s.requested_at || ""), secondsText = url.searchParams.get("hub.lease_seconds") || "";
    const seconds = Number(secondsText), challenge = url.searchParams.get("hub.challenge") || "";
    if (url.searchParams.get("hub.mode") !== "subscribe" || !/^[+\-./0-9=A-Z_a-z]{1,4096}$/.test(challenge) ||
        !/^[0-9]+$/.test(secondsText) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 31_536_000 ||
        !Number.isFinite(requested) || requested > Date.now() || Date.now() - requested > HOUR) return response(404);
    const confirmed = await one(env, `UPDATE youtube_websub_subscriptions SET confirmed_at=?,lease_expires_at=?,last_error=NULL,requested_at=NULL
      WHERE account_id=? AND callback_token=? AND requested_at=?
      AND EXISTS(SELECT 1 FROM platform_accounts WHERE id=? AND source='youtube' AND source_id=? AND processing_enabled=1) RETURNING account_id`,
    time, new Date(Date.now() + seconds * 1000).toISOString(), accountId, token, s.requested_at, accountId, s.source_id);
    return confirmed ? response(200, challenge) : response(404);
  }
  const expiry = Date.parse(s.lease_expires_at || "");
  if (!s.confirmed_at || !Number.isFinite(expiry) || expiry <= Date.now()) return response(403);
  const bytes = await readBytes(req, 65_536);
  if (!await validSignature(bytes, req.headers.get("X-Hub-Signature"), s.secret)) return response(403);
  let ids: string[];
  try { ids = videoIds(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), s.source_id); }
  catch { return response(400); }
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
  if (await one(env, "SELECT 1 FROM youtube_websub_deliveries WHERE account_id=? AND body_sha256=?", accountId, digest)) return response(204);
  try {
    await atomic(env, [enabledCheck(s, now()),
      { sql: "SELECT NOT EXISTS(SELECT 1 FROM youtube_websub_deliveries WHERE account_id=? AND body_sha256=?)", args: [accountId, digest] },
      { sql: `SELECT NOT EXISTS(SELECT 1 FROM platform_ingestion_jobs WHERE source='youtube' AND kind='video'
        AND source_id IN(SELECT value FROM json_each(?)) AND account_id IS NOT NULL AND account_id<>?)`, args: [JSON.stringify(ids), accountId] },
    ], [statement(env, "INSERT INTO youtube_websub_deliveries(account_id,body_sha256) VALUES(?,?)", accountId, digest),
      ...ids.map(id => enqueueStatement(env, { source: "youtube", kind: "video", source_id: id, account_id: accountId, wake: true })),
    ]);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      // A competing identical delivery won. Acknowledge it without waking any job again.
      if (await one(env, "SELECT 1 FROM youtube_websub_deliveries WHERE account_id=? AND body_sha256=?", accountId, digest)) return response(204);
      return response(409);
    }
    throw error;
  }
  return response(204);
}
export async function youtubeWebhook(req: Request, env: Env): Promise<Response> {
  try { return await route(req, env); }
  catch (error) {
    if (error instanceof HttpError && error.status === 413) return response(413);
    // Never include the request URL (a capability), signature, secret, or raw payload.
    console.error("YouTube notification persistence failed");
    return response(503);
  }
}
