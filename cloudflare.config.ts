import { bindings, defineConfig, triggers } from "cf/config";
import environments from "./config/environments.json" with { type: "json" };

export function configuration(mode = "local") {
  if (!Object.hasOwn(environments, mode)) throw new Error(`Unknown Cloudflare mode: ${mode}`);
  const settings = environments[mode as keyof typeof environments];
  return {
    accountId: settings.accountId ?? undefined,
    worker: {
      name: settings.name,
      entrypoint: "worker/index.ts",
      compatibilityDate: "2026-08-22",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: settings.workersDev,
      previewUrls: settings.previewUrls,
      observability: { enabled: true },
      env: {
        ENVIRONMENT: bindings.text(settings.vars.ENVIRONMENT),
        BUILD_COMMIT: bindings.text(process.env.BUILD_COMMIT ?? ("BUILD_COMMIT" in settings.vars ? settings.vars.BUILD_COMMIT : "unreleased")),
        PUBLIC_URL: bindings.text(settings.vars.PUBLIC_URL),
        PUBLIC_SITE_URL: bindings.text(settings.vars.PUBLIC_SITE_URL),
        OUTBOUND_ENABLED: bindings.text(settings.vars.OUTBOUND_ENABLED),
        AUTH_ENABLED: bindings.text(settings.vars.AUTH_ENABLED),
        CORS_ORIGINS: bindings.text(settings.vars.CORS_ORIGINS),
        DB: bindings.d1(settings.database),
        DETECTIONS: bindings.r2({ name: settings.buckets.DETECTIONS }),
        LOGS: bindings.r2({ name: settings.buckets.LOGS }),
        JOBS: bindings.queue({ name: settings.queue.name }),
      },
      triggers: [
        ...settings.crons.map(schedule => triggers.scheduled({ schedule })),
        triggers.queue({ ...settings.queue, maxBatchSize: 1, maxRetries: 5 }),
      ],
    },
  };
}

export default defineConfig(({ mode, isPreview }) => {
  if (isPreview) throw new Error("Use the isolated validation mode; preview resources are not configured");
  // Vitest reserves its own mode; all tests use the isolated local resources.
  return configuration(mode === "test" ? "local" : mode);
});
