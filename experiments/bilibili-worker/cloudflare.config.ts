import { bindings, defineConfig } from "cf/config";
import environments from "../../config/environments.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  if (mode && !["local", "hosted"].includes(mode)) throw new Error("Unknown probe mode");
  const hosted = mode === "hosted";
  const expires = process.env.BILIBILI_PROBE_EXPIRES ?? "0";
  if (hosted && (!Number.isSafeInteger(Number(expires)) || Number(expires) <= Date.now()
      || Number(expires) > Date.now() + 3600000)) throw new Error("Set a probe expiry within one hour");
  return { accountId: hosted ? environments.validation.accountId : undefined, worker: {
    name: hosted ? "bazaarghost-bilibili-hosted-probe" : "bazaarghost-bilibili-local-probe",
    entrypoint: "index.ts",
    compatibilityDate: "2026-10-14",
    workersDev: hosted,
    previewUrls: false,
    // Reports are summaries; traces would retain device-cookie request headers.
    observability: { enabled: true, traces: { enabled: false } },
    env: {
      PROBE_NETWORK: bindings.text(hosted ? "cloudflare" : "local"),
      PROBE_EXPIRES: bindings.text(expires),
      PROBE_TOKEN: hosted ? bindings.secret() : bindings.text(""),
    },
  } };
});
