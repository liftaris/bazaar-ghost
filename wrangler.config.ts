import { defineWranglerConfig } from "wrangler/experimental-config";

// cf uses Wrangler only as its bundler and local development runtime.
export default defineWranglerConfig({
  dev: { port: 8787 },
  types: { generate: false },
});
