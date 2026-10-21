import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      experimental: { newConfig: { configPath: "./cloudflare.config.ts" } },
      miniflare: {
        d1Databases: { MIGRATION_DB: "sfde-populated-migration-test" },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./worker/migrations"),
        },
      },
    }),
  ],
  test: {
    // workerd cannot read Vitest 5's host-filesystem module cache.
    fsModuleCache: false,
    include: ["worker/tests/**/*.test.ts"],
    setupFiles: ["./worker/tests/setup.ts"],
    fileParallelism: false,
  },
});
