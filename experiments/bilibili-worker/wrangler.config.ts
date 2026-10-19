import { defineWranglerConfig } from "wrangler/experimental-config";

// cf's local runtime only. This probe has no remote resources.
export default defineWranglerConfig({
  dev: { ip: "127.0.0.1", port: 8792 },
  types: { generate: false },
});
