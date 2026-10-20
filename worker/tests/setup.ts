import { env, applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
beforeEach(async () => {
  // Explicit cleanup avoids resetting the runtime's own Durable Objects between tests.
  const tables = [
    "mutation_checks",
    "notification_deliveries_v2",
    "notification_outbox_v2",
    "twitch_catalog_work",
    "social_reports",
    "social_moderation_audit",
    "social_rate_limits",
    "matchup_comments",
    "matchup_favorites",
    "matchup_likes",
    "matchup_anchors",
    "matchups",
    "auth_flows",
    "auth_rate_limits",
    "auth_verifications",
    "user_sessions",
    "user_accounts",
    "app_users",
    "matchup_overrides",
    "matchup_events",
    "youtube_websub_deliveries",
    "youtube_websub_subscriptions",
    "platform_ingestion_dispatch",
    "platform_ingestion_jobs",
    "chat_mentions",
    "detections",
    "search_grams",
    "search_names",
    "chunks",
    "vods",
    "proposal_evidence",
    "session_link_proposals",
    "recording_alignments",
    "session_events",
    "sessions",
    "channel_ownership",
    "platform_accounts",
    "streamer_identities",
    "notification_subscriptions",
    "server_channels",
    "streamers",
    "sfde_profiles",
    "processing_config",
    "cataloger_runs",
    "webhook_events",
  ];
  await env.DB.batch([
    ...tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    // Every known platform starts fully enabled; tests switch off what they cover.
    env.DB.prepare("DELETE FROM platform_settings"),
    env.DB.prepare(`INSERT INTO platform_settings(source,ingestion_enabled,discovery_enabled,processing_enabled,notifications_enabled)
      VALUES('twitch',1,1,1,1),('youtube',1,1,1,0),('bilibili',1,1,1,0)`),
  ]);
  for (const bucket of [env.DETECTIONS, env.LOGS]) {
    const page = await bucket.list();
    if (page.objects.length)
      await bucket.delete(page.objects.map((object) => object.key));
  }
});
