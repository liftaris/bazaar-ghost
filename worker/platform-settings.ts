import { now, one, requireValue, rows, statement } from "./http";
import { source, sources, type Source } from "./sources";

export const PLATFORM_SETTINGS = ["ingestion_enabled", "discovery_enabled", "processing_enabled"] as const;
export type PlatformSetting = typeof PLATFORM_SETTINGS[number];

/** SQL predicate: the platform named by `sourceSql` has `setting` on. A platform without a row is off. */
export function platformEnabled(sourceSql: string, setting: PlatformSetting) {
  return `EXISTS(SELECT 1 FROM platform_settings ps WHERE ps.source=${sourceSql} AND ps.${setting}=1)`;
}

export async function isPlatformEnabled(env: Env, platform: Source, setting: PlatformSetting) {
  return Boolean(await one(env, `SELECT 1 WHERE ${platformEnabled("?", setting)}`, platform));
}

/** Every known platform, including ones without a row (reported as fully off). */
export async function platformSettings(env: Env) {
  const saved = new Map((await rows(env, "SELECT * FROM platform_settings")).map(row => [row.source, row]));
  const known = new Set<string>([...sources, ...saved.keys()]);
  return [...known].sort().map(name => {
    const row = saved.get(name);
    return {
      source: name,
      ...Object.fromEntries(PLATFORM_SETTINGS.map(key => [key, row?.[key] === 1])),
      updated_at: row?.updated_at ?? null,
    };
  });
}

/** Admin: list settings, or change any subset of one known platform's switches. */
export async function updatePlatformSettings(env: Env, input: Record<string, unknown>) {
  if (input.source == null) {
    requireValue(PLATFORM_SETTINGS.every(key => !Object.hasOwn(input, key)), "Select a platform to change");
    return platformSettings(env);
  }
  const platform = source(input.source);
  const changes = PLATFORM_SETTINGS.filter(key => Object.hasOwn(input, key));
  requireValue(changes.length > 0, "Provide at least one platform setting");
  for (const key of changes) requireValue(typeof input[key] === "boolean", `Invalid ${key}`);
  const time = now();
  await statement(env,
    `INSERT INTO platform_settings(source,${changes.join(",")},updated_at) VALUES(?,${changes.map(() => "?").join(",")},?)
     ON CONFLICT(source) DO UPDATE SET ${changes.map(key => `${key}=excluded.${key}`).join(",")},updated_at=excluded.updated_at`,
    platform, ...changes.map(key => input[key]), time).run();
  return platformSettings(env);
}
