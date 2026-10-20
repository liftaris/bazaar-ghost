import { SELF, env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import registry from "../../contracts/platforms.json";
import cases from "../../contracts/platforms.cases.json";
import type { Page, PlatformDefinition } from "../../contracts/public-api";
import { rows, statement } from "../http";
import { enqueueStatement, upsertAccount } from "../platforms";
import {
  accountIdentity, embedUrl, listPlatforms, parseUrl, platform, registerPlatformsForTest, videoIdentity, watchUrl,
  type PlatformEntry,
} from "../platform-registry";

afterEach(() => registerPlatformsForTest([]));

it("loads every registry entry with the keys all loaders rely on", () => {
  expect(listPlatforms().map((entry) => entry.id)).toEqual(registry.platforms.map((entry) => entry.id));
  for (const entry of listPlatforms()) {
    expect(entry.id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(Object.keys(entry.capabilities).sort()).toEqual(
      ["clipParentRange", "clips", "createClip", "fullscreen", "mute", "qualitySelectable", "seek", "swap", "timeEvents"]);
    expect(Array.isArray(entry.embed.requires)).toBe(true);
    for (const pattern of [entry.recording.idPattern, entry.recording.submissionPattern, entry.channel.idPattern,
      ...entry.recording.urlPatterns, ...entry.channel.urlPatterns]) expect(() => new RegExp(pattern)).not.toThrow();
  }
  expect(platform("twitch").embed.requires).toEqual(["parent"]);
});

it("validates identities against the shared cases", () => {
  for (const [id, set] of Object.entries(cases.videoIdentity)) {
    for (const value of set.valid) expect(videoIdentity(id, value)).toBe(value);
    for (const value of set.invalid) expect(() => videoIdentity(id, value)).toThrow("Invalid source video identity");
  }
  for (const [id, set] of Object.entries(cases.accountIdentity)) {
    for (const value of set.valid) expect(accountIdentity(id, value)).toBe(value);
    for (const value of set.invalid) expect(() => accountIdentity(id, value)).toThrow("Invalid platform account identity");
  }
  expect(() => platform("nope")).toThrow("Invalid source");
});

it("builds and parses URLs exactly as the shared cases say", () => {
  for (const item of cases.urls) {
    const { id, ...rest } = item.values as Record<string, string | number>;
    const recording = { sourceId: String(id), ...rest };
    expect(watchUrl(item.platform, recording)).toBe(item.watchUrl);
    expect(watchUrl(item.platform, recording, 12)).toBe(item.watchUrlAt);
    expect(embedUrl(item.platform, recording)).toBe(item.embedUrl);
    expect(embedUrl(item.platform, recording, 12)).toBe(item.embedUrlAt);
  }
  for (const item of cases.parse) expect(parseUrl(item.url)).toEqual(item.expect);
});

const fourth: PlatformEntry = {
  id: "kick", name: "Kick", mark: "kick",
  recording: {
    idPattern: "^[0-9]{6}$", submissionPattern: "^[0-9]{6}$", parts: false,
    urlPatterns: ["^https://kick\\.example/vod/(?<id>[0-9]{6})$"],
    watchUrl: "https://kick.example/vod/{id}", watchUrlAt: "https://kick.example/vod/{id}?t={t}",
    embedUrl: "https://kick.example/embed/{id}", embedUrlAt: "https://kick.example/embed/{id}?t={t}",
    resolveUrl: "https://kick.example/vod/{id}", resolveUrlAt: "https://kick.example/vod/{id}?t={t}", timestampFormat: "seconds",
  },
  channel: { idPattern: "^[a-z]{3,10}$", urlPatterns: ["^https://kick\\.example/(?<id>[a-z]{3,10})$"], profileUrl: "https://kick.example/{id}" },
  clip: { idPattern: null, urlPatterns: [], watchUrl: null, embedUrl: null },
  capabilities: { seek: true, timeEvents: false, mute: true, fullscreen: true, swap: false, clips: false, createClip: false, clipParentRange: false, qualitySelectable: false },
  embed: { kind: "iframe", requires: [] },
  adapters: { catalog: null, ingestion: "kick", discovery: null, media: null, push: null },
};

it("supports a fourth platform without a schema change", async () => {
  registerPlatformsForTest([fourth]);
  await env.DB.exec("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')");
  await statement(env, "INSERT OR REPLACE INTO platform_settings(source,ingestion_enabled,discovery_enabled,processing_enabled) VALUES('kick',1,1,1)").run();

  const account = await upsertAccount(env, { source: "kick", source_id: "someone", display_name: "Someone" });
  expect(account).toMatchObject({ source: "kick", source_id: "someone" });
  await statement(env, `INSERT INTO vods(source,source_id,platform_account_id,title,duration_seconds)
    VALUES('kick','123456',?,'Fourth',100)`, account.id).run();
  await env.DB.batch([enqueueStatement(env, { source: "kick", kind: "video", source_id: "123456", account_id: account.id })]);
  expect(await rows(env, "SELECT source,kind FROM platform_ingestion_jobs")).toEqual([{ source: "kick", kind: "video" }]);

  expect(parseUrl("https://kick.example/vod/123456")).toEqual({ platform: "kick", kind: "recording", groups: { id: "123456" } });
  expect(watchUrl("kick", { sourceId: "123456" }, 9)).toBe("https://kick.example/vod/123456?t=9");

  const response = await SELF.fetch("http://local/api/v1/platforms");
  const body = await response.json() as Page<PlatformDefinition>;
  expect(body.items.map((item) => item.id)).toEqual(["twitch", "youtube", "bilibili", "kick"]);
  expect(body.items.every((item) => !("adapters" in item) && !("recording" in item))).toBe(true);
  expect(body.items[0]).toMatchObject({ id: "twitch", embed: { requires: ["parent"] } });
});

it("rejects platform IDs that break the stored format", async () => {
  await expect(statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('x','Bad Id','1','x')").run()).rejects.toThrow();
  await expect(statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('x','','1','x')").run()).rejects.toThrow();
});
