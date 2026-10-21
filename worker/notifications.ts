import { HttpError, external, now, one, rows, statement } from "./http";

export const MAX_DELIVERY_ATTEMPTS = 5;
const OUTBOX_BATCH = 100;

interface Source {
  username: string;
  username_lower: string;
  display: string | null;
}
interface Destination {
  channel?: string;
  user?: string;
  users: Set<string>;
  subscriptions: number[];
}

async function discordApi(env: Env, path: string, data: unknown): Promise<any> {
  const response = await external(env, `https://discord.com/api/v10/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  return response.json();
}

/** Outbox rows whose grace window has elapsed and that still need a decision. */
export async function dueNotifications(env: Env) {
  return rows<{ matchup_id: number }>(
    env,
    "SELECT matchup_id FROM notification_outbox_v2 WHERE sent_at IS NULL AND suppressed_reason IS NULL AND eligible_at<=? ORDER BY eligible_at LIMIT ?",
    now(),
    OUTBOX_BATCH,
  );
}

const settle = (env: Env, id: number, reason?: string) =>
  statement(
    env,
    "UPDATE notification_outbox_v2 SET sent_at=?,suppressed_reason=? WHERE matchup_id=? AND sent_at IS NULL AND suppressed_reason IS NULL",
    reason ? null : now(),
    reason ?? null,
    id,
  ).run();

async function destinationsFor(env: Env, usernames: string[]) {
  const subs = await rows(
    env,
    "SELECT * FROM notification_subscriptions WHERE enabled=1 AND username_lower IN(SELECT value FROM json_each(?))",
    JSON.stringify(usernames),
  );
  const destinations = new Map<string, Destination>();
  const add = (key: string, sub: any, init: Partial<Destination>) => {
    const dest = destinations.get(key) || { users: new Set(), subscriptions: [], ...init };
    dest.users.add(sub.discord_user_id);
    dest.subscriptions.push(sub.id);
    destinations.set(key, dest);
  };
  for (const sub of subs) {
    if (sub.notify_type !== "server")
      add(`dm:${sub.discord_user_id}`, sub, { user: sub.discord_user_id });
    if (sub.notify_type !== "dm" && sub.guild_id) {
      const channel = await one(
        env,
        "SELECT channel_id FROM server_channels WHERE guild_id=?",
        sub.guild_id,
      );
      if (channel)
        add(`channel:${channel.channel_id}`, sub, { channel: channel.channel_id });
    }
  }
  return destinations;
}

async function nonce(matchup: number, destination: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${matchup}:${destination}`),
  );
  return Array.from(new Uint8Array(hash).slice(0, 12), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const recordDelivery = (
  env: Env,
  matchup: number,
  destination: Destination,
  key: string,
  status: "pending" | "sent" | "failed" | "uncertain",
  error: string | null,
) =>
  env.DB.batch(
    destination.subscriptions.flatMap((subscription) => [
      statement(
        env,
        `INSERT INTO notification_deliveries_v2(matchup_id,subscription_id,destination,status,attempts,last_error,sent_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(matchup_id,subscription_id,destination) DO UPDATE SET status=excluded.status,
          attempts=attempts+?9,last_error=excluded.last_error,sent_at=coalesce(excluded.sent_at,sent_at),updated_at=excluded.updated_at`,
        matchup,
        subscription,
        key,
        status,
        status === "pending" ? 1 : 0,
        error,
        status === "sent" ? now() : null,
        now(),
        status === "pending" ? 1 : 0,
      ),
      ...(status === "sent"
        ? [
            statement(
              env,
              "UPDATE notification_subscriptions SET notification_count=notification_count+1 WHERE id=?",
              subscription,
            ),
          ]
        : []),
    ]),
  );

/**
 * Sends the one notification of a Matchup. Delivery identity is (matchup, subscription, destination):
 * `sent` and `uncertain` are never sent again; `failed` is retried up to MAX_DELIVERY_ATTEMPTS.
 */
export async function notify(env: Env, matchup: number) {
  const outbox = await one(
    env,
    "SELECT o.sent_at,o.suppressed_reason,o.eligible_at,m.status,m.merged_into FROM notification_outbox_v2 o JOIN matchups m ON m.id=o.matchup_id WHERE o.matchup_id=?",
    matchup,
  );
  if (!outbox || outbox.sent_at || outbox.suppressed_reason) return;
  if (outbox.merged_into !== null) return settle(env, matchup, "merged");
  if (outbox.status === "hidden") return settle(env, matchup, "hidden");
  if (outbox.eligible_at > now()) return;
  const sources = await rows<Source>(
    env,
    `SELECT ps.username,ps.username_lower,coalesce(pa.display_name,pa.login) AS display
     FROM public_sources ps JOIN public_matchups pm ON pm.matchup_id=ps.matchup_id
     LEFT JOIN platform_accounts pa ON pa.id=ps.channel_id
      WHERE ps.matchup_id=? AND ps.name_state IN('legacy','complete') AND ps.confidence>0.7 AND ps.username IS NOT NULL
      ORDER BY ps.detection_id=pm.detection_id DESC,ps.anchor_id`,
    matchup,
  );
  const owner = await one<{ display_name: string }>(
    env,
    `SELECT si.display_name FROM matchup_streamers ms JOIN streamer_identities si ON si.id=ms.streamer_id
     WHERE ms.matchup_id=? ORDER BY ms.streamer_id LIMIT 1`,
    matchup,
  );
  if (!sources.length) return settle(env, matchup, "no_source");
  if (env.ENVIRONMENT !== "production") return settle(env, matchup);
  // Another delivery path only starts once outbound calls are allowed; until then the row stays pending.
  if (env.OUTBOUND_ENABLED !== "true") return;
  const streamer = owner?.display_name ?? sources.find((s) => s.display)?.display ?? "Unknown streamer",
    opponents = [...new Set(sources.map((s) => s.username))];
  const destinations = await destinationsFor(env, [
    ...new Set(sources.map((s) => s.username_lower)),
  ]);
  const base = env.PUBLIC_SITE_URL.replace(/\/+$/, "");
  let unfinished = false;
  for (const [key, target] of destinations) {
    const previous = await rows(
      env,
      "SELECT status,attempts FROM notification_deliveries_v2 WHERE matchup_id=? AND destination=?",
      matchup,
      key,
    );
    if (previous.some((p) => p.status === "sent" || p.status === "uncertain")) continue;
    // A pending row with no outcome means an earlier run stopped mid-call: its result is unknown.
    if (previous.some((p) => p.status === "pending")) {
      await recordDelivery(env, matchup, target, key, "uncertain", "Interrupted before the outcome was recorded");
      continue;
    }
    if (previous.some((p) => p.attempts >= MAX_DELIVERY_ATTEMPTS)) continue;
    await recordDelivery(env, matchup, target, key, "pending", null);
    let sending = false;
    try {
      let channel = target.channel;
      if (target.user)
        channel = (
          await discordApi(env, "users/@me/channels", { recipient_id: target.user })
        ).id;
      if (!channel) throw new Error("Discord did not return a channel");
      const content = `👻🚨 New matchup found!\n**${streamer}** vs **${opponents.join("**, **")}**\n${base}/matchups/${matchup}${target.channel ? "\n" + [...target.users].map((u) => `<@${u}>`).join(" ") : ""}`;
      sending = true;
      await discordApi(env, `channels/${channel}/messages`, {
        content,
        allowed_mentions: { parse: [] },
        // Stable nonce suppresses short-term duplicates after an ambiguous HTTP response.
        nonce: await nonce(matchup, key),
        enforce_nonce: true,
      });
      await recordDelivery(env, matchup, target, key, "sent", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A rejected request (HTTP status) was not delivered; a timeout or network error may have been.
      const known = !sending || error instanceof HttpError || /returned \d{3}$/.test(message);
      await recordDelivery(env, matchup, target, key, known ? "failed" : "uncertain", message.slice(0, 500));
      if (known) unfinished = true;
    }
  }
  if (!unfinished) await settle(env, matchup);
}

export async function notificationsAdminRoute(req: Request, env: Env, path: string) {
  if (path !== "/api/admin/notifications/problems" || req.method !== "GET")
    throw new HttpError(404, "Unknown notifications endpoint");
  return Response.json(
    await rows(
      env,
      `SELECT matchup_id,subscription_id,destination,status,attempts,last_error,updated_at FROM notification_deliveries_v2
       WHERE status='uncertain' OR (status='failed' AND attempts>=?) ORDER BY updated_at DESC LIMIT 200`,
      MAX_DELIVERY_ATTEMPTS,
    ),
  );
}
