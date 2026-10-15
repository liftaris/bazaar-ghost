// Secret values come from .dev.vars locally and existing hosted Worker secrets.
// Keeping them out of cf's required bindings permits disabled integrations.
declare namespace Cloudflare {
  interface Env {
    ADMIN_KEY: string;
    PROCESSOR_KEY: string;
    CATALOG_KEY: string;
    TWITCH_CLIENT_ID: string;
    TWITCH_CLIENT_SECRET: string;
    TWITCH_EVENTSUB_SECRET: string;
    GITHUB_TOKEN: string;
    DISCORD_PUBLIC_KEY: string;
    DISCORD_BOT_TOKEN: string;
  }
}
