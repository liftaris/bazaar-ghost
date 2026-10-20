import {
  now,
  readText,
  one,
  requireValue,
  rows,
  statement,
} from "./http";
import { search } from "./native-api";

const reply = (content: string) =>
  Response.json({
    type: 4,
    data: {
      content: content.slice(0, 1950),
      flags: 64,
      allowed_mentions: { parse: [] },
    },
  });
export async function discord(req: Request, env: Env) {
  const raw = await readText(req),
    signature = req.headers.get("X-Signature-Ed25519") || "",
    timestamp = req.headers.get("X-Signature-Timestamp") || "";
  if (
    !/^[a-f\d]{128}$/i.test(signature) ||
    !/^[a-f\d]{64}$/i.test(env.DISCORD_PUBLIC_KEY) ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000
  )
    return new Response("Invalid signature", { status: 401 });
  const bytes = (hex: string) =>
    new Uint8Array(hex.match(/../g)!.map((s) => parseInt(s, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(env.DISCORD_PUBLIC_KEY),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      bytes(signature),
      new TextEncoder().encode(timestamp + raw),
    ))
  )
    return new Response("Invalid signature", { status: 401 });
  const data = JSON.parse(raw);
  if (data.type === 1) return Response.json({ type: 1 });
  if (data.type !== 2) return reply("Unknown command");
  const user = data.member?.user?.id || data.user?.id,
    guild = data.guild_id;
  if (!user) return reply("Could not identify user");
  const name = data.data?.name,
    options = data.data?.options || [];
  const option = (key: string) =>
    options.find((o: any) => o.name === key)?.value;
  if (name === "help")
    return reply(
      "Use /search <username> to find matchups, /notify <bazaar_username> [where] to toggle notifications, /list to show subscriptions, and /setchannel or /clearchannel to configure a server.",
    );
  if (name === "setchannel" || name === "clearchannel") {
    if (!guild) return reply("This command can only be used in a server");
    if (!(BigInt(data.member?.permissions || "0") & (8n | 32n)))
      return reply("Manage Server permission is required");
    if (name === "clearchannel")
      await statement(
        env,
        "DELETE FROM server_channels WHERE guild_id=?",
        guild,
      ).run();
    else
      await statement(
        env,
        "INSERT INTO server_channels(guild_id,channel_id) VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id",
        guild,
        option("channel") || data.channel_id,
      ).run();
    return reply(
      name === "clearchannel"
        ? "Notification channel cleared"
        : `Notifications will be posted to <#${option("channel") || data.channel_id}>`,
    );
  }
  if (name === "notify") {
    const username = option("bazaar_username"),
      where = option("where") || "both";
    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.length > 128
    )
      return reply("Please provide a username of at most 128 characters");
    if (!["dm", "server", "both"].includes(where))
      return reply("Invalid notification destination");
    if (
      where !== "dm" &&
      (!guild ||
        !(await one(
          env,
          "SELECT channel_id FROM server_channels WHERE guild_id=?",
          guild,
        )))
    )
      return reply(
        "Server notifications require a server with a channel configured using /setchannel",
      );
    // Cache mutating interaction IDs, so Discord retries cannot toggle a subscription twice.
    const id = `discord:${data.id}`;
    requireValue(typeof data.id === "string", "Missing interaction ID");
    const results = await env.DB.batch([
      statement(
        env,
        `INSERT INTO notification_subscriptions(discord_user_id,username,username_lower,notify_type,guild_id)
        SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM webhook_events WHERE id=?)
        ON CONFLICT(discord_user_id,username_lower) DO UPDATE SET enabled=1-enabled,notify_type=excluded.notify_type,guild_id=excluded.guild_id`,
        user,
        username,
        username.toLowerCase(),
        where,
        where === "dm" ? null : guild,
        id,
      ),
      statement(
        env,
        "INSERT OR IGNORE INTO webhook_events(id,created_at) VALUES(?,?)",
        id,
        now(),
      ),
      statement(
        env,
        "SELECT enabled FROM notification_subscriptions WHERE discord_user_id=? AND username_lower=?",
        user,
        username.toLowerCase(),
      ),
    ]);
    return reply(
      `${(results[2].results[0] as any).enabled ? "Subscribed to" : "Unsubscribed from"} notifications on username **${username}**`,
    );
  }
  if (name === "list") {
    const subs = await rows(
      env,
      "SELECT username FROM notification_subscriptions WHERE discord_user_id=? AND enabled=1 ORDER BY created_at LIMIT 50",
      user,
    );
    return reply(
      subs.length
        ? subs.map((s) => `• ${s.username}`).join("\n")
        : "No active subscriptions. Use /notify to subscribe.",
    );
  }
  if (name === "search") {
    const username = option("username");
    if (typeof username !== "string" || !username.trim())
      return reply("Please provide a username");
    const limit =
      option("results") === "all"
        ? 10
        : Math.max(1, Math.min(10, Number(option("results") || 1)));
    if (username.length > 128) return reply("Please provide a username of at most 128 characters");
    const { items } = await search(
      env,
      new URL(`https://internal/api/v1/search?${new URLSearchParams({ q: username, limit: String(limit) })}`),
    );
    const base = env.PUBLIC_SITE_URL.replace(/\/+$/, "");
    return reply(
      items.length
        ? items
            .map((m) => {
              const who = m.streamer?.displayName ?? (m.sources[0] as any)?.channel?.displayName ?? "Unknown";
              const at = m.recordedAt ? ` — <t:${Math.floor(Date.parse(m.recordedAt) / 1000)}:f>` : "";
              return `**${who}** vs **${m.opponent.username}**${at} — ${base}/matchups/${m.id}`;
            })
            .join("\n")
        : `No results found for **${username}**`,
    );
  }
  return reply("Unknown command");
}
