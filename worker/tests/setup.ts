import { env, applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
beforeEach(async () => {
  // Explicit cleanup avoids resetting the runtime's own Durable Objects between tests.
  const tables = [
    "mutation_checks",
    "twitch_catalog_work",
    "social_reports",
    "social_moderation_audit",
    "social_rate_limits",
    "clip_comments",
    "clip_favorites",
    "clip_likes",
    "clips",
    "auth_flows",
    "auth_rate_limits",
    "auth_verifications",
    "user_sessions",
    "user_accounts",
    "app_users",
    "matchup_review_events",
    "matchup_appearances",
    "matchup_groups",
    "youtube_websub_deliveries",
    "youtube_websub_subscriptions",
    "platform_ingestion_dispatch",
    "platform_ingestion_jobs",
    "chat_mentions",
    "notification_deliveries",
    "notification_outbox",
    "detections",
    "search_grams",
    "search_names",
    "chunks",
    "vods",
    "platform_accounts",
    "notification_subscriptions",
    "server_channels",
    "streamers",
    "sfde_profiles",
    "processing_config",
    "cataloger_runs",
    "webhook_events",
  ];
  await env.DB.batch(
    tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  for (const bucket of [env.DETECTIONS, env.LOGS]) {
    const page = await bucket.list();
    if (page.objects.length)
      await bucket.delete(page.objects.map((object) => object.key));
  }
});
