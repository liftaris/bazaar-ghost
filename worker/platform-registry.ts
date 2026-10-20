import registry from "../contracts/platforms.json";
import { requireValue } from "./http";

export type Source = string;
export interface PlatformCapabilities {
  seek: boolean; timeEvents: boolean; mute: boolean; fullscreen: boolean; swap: boolean;
  clips: boolean; createClip: boolean; clipParentRange: boolean; qualitySelectable: boolean;
}
export interface PlatformEntry {
  id: string;
  name: string;
  mark: string;
  recording: {
    idPattern: string; submissionPattern: string; parts: boolean; urlPatterns: string[];
    watchUrl: string; watchUrlAt: string; embedUrl: string | null; embedUrlAt: string | null;
    resolveUrl: string; resolveUrlAt: string; timestampFormat: string;
  };
  channel: { idPattern: string; urlPatterns: string[]; profileUrl: string };
  clip: { idPattern: string | null; urlPatterns: string[]; watchUrl: string | null; embedUrl: string | null };
  capabilities: PlatformCapabilities;
  embed: { kind: string; requires: string[] };
  adapters: { catalog: string | null; ingestion: string | null; discovery: string | null; media: string | null; push: string | null };
}

const ID_FORMAT = /^[a-z][a-z0-9_-]{0,31}$/;
const builtin = registry.platforms as PlatformEntry[];
let extra: PlatformEntry[] = [];
const patterns = new Map<string, RegExp>();
function regex(pattern: string) {
  let compiled = patterns.get(pattern);
  if (!compiled) patterns.set(pattern, compiled = new RegExp(pattern));
  return compiled;
}

export function listPlatforms(): PlatformEntry[] {
  return [...builtin, ...extra];
}
/** Test hook: add platform definitions without touching contracts/platforms.json. */
export function registerPlatformsForTest(entries: PlatformEntry[]) {
  extra = entries;
}
export function platform(value: unknown): PlatformEntry {
  const found = typeof value === "string" ? listPlatforms().find(entry => entry.id === value) : undefined;
  requireValue(found, "Invalid source");
  return found;
}
/** Validate a platform ID, defaulting to the legacy implicit platform for old callers. */
export function source(value: unknown = "twitch"): Source {
  return platform(value).id;
}
export function isPlatformId(value: unknown): value is string {
  return typeof value === "string" && ID_FORMAT.test(value);
}
export function ingestionPlatforms(): PlatformEntry[] {
  return listPlatforms().filter(entry => entry.adapters.ingestion);
}
/** Platforms that can be ingested through the generic ingestion jobs (not a platform-specific catalog). */
export function requireIngestion(value: unknown, message: string): PlatformEntry {
  const entry = platform(value);
  requireValue(entry.adapters.ingestion, message);
  return entry;
}
export function videoIdentity(id: Source, value: unknown): string {
  requireValue(typeof value === "string" && regex(platform(id).recording.idPattern).test(value), "Invalid source video identity");
  return value;
}
export function submissionIdentity(id: Source, value: unknown): string {
  requireValue(typeof value === "string" && regex(platform(id).recording.submissionPattern).test(value), "Invalid source video identity");
  return value;
}
export function accountIdentity(id: Source, value: unknown): string {
  requireValue(typeof value === "string" && regex(platform(id).channel.idPattern).test(value), "Invalid platform account identity");
  return value;
}

export interface RecordingRef {
  sourceId: string;
  videoId?: string | null;
  partId?: string | null;
  partIndex?: number | string | null;
}
function fill(template: string, values: Record<string, unknown>) {
  return template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(String(values[key] ?? "")));
}
function values(recording: RecordingRef, at?: number | null) {
  return { id: recording.sourceId, videoId: recording.videoId, partId: recording.partId, partIndex: recording.partIndex, t: at };
}
function hasAt(at: number | null | undefined): at is number {
  return at !== null && at !== undefined;
}
export function watchUrl(id: Source, recording: RecordingRef, at?: number | null): string {
  const { recording: r } = platform(id);
  return fill(hasAt(at) ? r.watchUrlAt : r.watchUrl, values(recording, at));
}
export function embedUrl(id: Source, recording: RecordingRef, at?: number | null): string | null {
  const { recording: r } = platform(id);
  const template = hasAt(at) ? r.embedUrlAt : r.embedUrl;
  return template ? fill(template, values(recording, at)) : null;
}
/** A Channel's public profile URL; null when the platform template needs a value the Channel lacks (e.g. a Twitch login). */
export function channelUrl(id: Source, channel: { sourceId: string; login: string | null }): string | null {
  const template = platform(id).channel.profileUrl;
  const needed = { id: channel.sourceId, login: channel.login };
  for (const [, key] of template.matchAll(/\{(\w+)\}/g)) if (!needed[key as keyof typeof needed]) return null;
  return fill(template, needed);
}
export type ParsedUrl = { platform: string; kind: "recording" | "channel"; groups: Record<string, string> };
/** Identify a public recording or channel URL against every registered platform. */
export function parseUrl(url: string): ParsedUrl | null {
  for (const entry of listPlatforms()) {
    for (const [kind, list] of [["recording", entry.recording.urlPatterns], ["channel", entry.channel.urlPatterns]] as const) {
      for (const pattern of list) {
        const match = regex(pattern).exec(url);
        if (match) return { platform: entry.id, kind, groups: Object.fromEntries(Object.entries(match.groups ?? {}).filter(([, value]) => value !== undefined)) };
      }
    }
  }
  return null;
}
