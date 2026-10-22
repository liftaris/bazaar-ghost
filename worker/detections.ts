import { HttpError, integer, one, readBytes, requireValue, rows, statement, uuid } from "./http";
import { atomic } from "./atomic";
import { coalesceVod } from "./coalesce";
import { owned } from "./processing";
import { trigrams } from "./search";

export const HEROES = ["vanessa", "pygmalien", "dooley", "mak", "jules", "stelle", "karnok", "the_dragons"];
export const FIELD_KEYS = ["encounter", "username", "rank", "igd", "ghost_hero", "streamer_hero", "wins_remaining", "lethal"] as const;
export type FieldKey = typeof FIELD_KEYS[number];
export interface FieldObservation {
  at_ms: number; method: string; confidence: number | null; image_path: string;
  frame_sha256: string; source_width: number; source_height: number;
  region: [number, number, number, number]; phase: "intro" | "pre_fight" | "post_fight" | "unknown";
  selection_reason: string; model?: string; prompt_version?: string; raw_text?: string;
  samples?: Array<{ at_ms: number; image_path: string }>;
  run_segment_id?: string;
  inherited_from?: { detection_id: string; run_segment_id: string; at_ms: number };
}
export type FieldObservations = Partial<Record<FieldKey, FieldObservation>>;
const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");

/** Bounded JPEG marker walk; SOF dimensions describe the referenced image pixels. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at++] !== 255) return null;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const size = bytes[at] * 256 + bytes[at + 1];
    if (size < 2 || at + size > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (size < 8) return null;
      const height = bytes[at + 3] * 256 + bytes[at + 4], width = bytes[at + 5] * 256 + bytes[at + 6];
      return width > 0 && width <= 16384 && height > 0 && height <= 16384 ? { width, height } : null;
    }
    at += size;
  }
  return null;
}

export function imageKey(chunk: Record<string, any>, token: string, timestamp: number, kind = "detection", milliseconds = false) {
  integer(timestamp, milliseconds ? "timestamp_ms" : "timestamp");
  requireValue((milliseconds ? ["intro", "clock", "detection", "ocr_debug", "emblem_boxes"] : ["detection", "ocr_debug", "emblem_boxes"]).includes(kind), "Invalid image kind");
  const scale = milliseconds ? 1000 : 1;
  requireValue(timestamp >= chunk.start_seconds * scale && timestamp < chunk.end_seconds * scale, "Frame outside chunk");
  const file = milliseconds ? `evidence_${timestamp}_${kind}` : `${kind}_${timestamp}`;
  return `${chunk.source && chunk.source !== "twitch" ? `${chunk.source}/` : ""}${chunk.source_id}/${chunk.id}/${token}/${file}.jpg`;
}
export async function upload(env: Env, req: Request, id: string, timestamp: number, kind: string, milliseconds = false) {
  const token = req.headers.get("X-Claim-Token"), chunk = await owned(env, id, token);
  const key = imageKey(chunk, token!, timestamp, kind, milliseconds);
  requireValue(req.headers.get("content-type") === "image/jpeg", "Expected JPEG");
  const bytes = await readBytes(req, 8_000_000);
  requireValue(bytes.byteLength > 2 && bytes[0] === 255 && bytes[1] === 216, "Invalid JPEG");
  const size = jpegSize(bytes);
  requireValue(!milliseconds || size, "Evidence JPEG requires valid image dimensions");
  const sha256 = await sha256Hex(bytes);
  // Immutable objects: a retry cannot alter pixels already referenced by a publication.
  const prior = await env.DETECTIONS.head(key);
  if (prior) {
    let priorHash = prior.customMetadata?.sha256;
    // Pre-0022 objects lack our metadata. Preserve legacy byte-identical upload
    // retries without allowing replacement or reading an unbounded object.
    if (!priorHash && !milliseconds && prior.size <= 8_000_000) {
      const existing = await env.DETECTIONS.get(key);
      if (existing && existing.size <= 8_000_000) priorHash = await sha256Hex(new Uint8Array(await existing.arrayBuffer()));
    }
    if (priorHash !== sha256) throw new HttpError(409, "Image sample already uploaded with different bytes");
  } else {
    const put = await env.DETECTIONS.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { sha256, at_ms: String(timestamp * (milliseconds ? 1 : 1000)), ...(size ? { width: String(size.width), height: String(size.height) } : {}) },
      httpMetadata: { contentType: "image/jpeg" },
    });
    if (!put && (await env.DETECTIONS.head(key))?.customMetadata?.sha256 !== sha256)
      throw new HttpError(409, "Image sample concurrently uploaded with different bytes");
  }
  await owned(env, id, token);
  return { storage_path: `/detections/${key}` };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function score(value: unknown, label: string, nullable = false) {
  requireValue((nullable && value === null) || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1), `Invalid ${label}`);
}
function text(value: unknown, label: string, max: number) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), `Invalid ${label}`);
}
/** Canonicalize object keys, not array order, so JSON serialization order is not a conflict. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function claimedImage(env: Env, chunk: Record<string, any>, token: string, path: unknown, atMs: number, heads: Map<string, Promise<R2Object | null>>) {
  text(path, "image_path", 2048);
  const prefix = `/detections/${imageKey(chunk, token, chunk.start_seconds, "detection").replace(/detection_\d+\.jpg$/, "")}`;
  requireValue((path as string).startsWith(prefix), "Screenshot must belong to the current claim");
  const file = (path as string).slice(prefix.length);
  const ms = /^evidence_(\d+)_(intro|clock|detection)\.jpg$/.exec(file), seconds = /^detection_(\d+)\.jpg$/.exec(file);
  requireValue((ms && Number(ms[1]) === atMs) || (seconds && Number(seconds[1]) * 1000 === atMs), "Image time must match evidence time");
  integer(atMs, "at_ms", chunk.start_seconds * 1000, chunk.end_seconds * 1000 - 1);
  const key = (path as string).slice("/detections/".length);
  let head = heads.get(key);
  if (!head) { head = env.DETECTIONS.head(key); heads.set(key, head); }
  const image = await head;
  if (!image) throw new HttpError(409, "Required screenshot has not been uploaded");
  return image;
}
async function validateEvidence(env: Env, chunk: Record<string, any>, token: string, value: unknown, heads: Map<string, Promise<R2Object | null>>): Promise<FieldObservations> {
  requireValue(object(value) && new TextEncoder().encode(JSON.stringify(value)).length <= 32_768, "Invalid or oversized field_evidence");
  const allowed = ["at_ms", "method", "confidence", "image_path", "frame_sha256", "source_width", "source_height", "region", "phase", "selection_reason", "model", "prompt_version", "raw_text", "samples", "run_segment_id", "inherited_from"];
  for (const [key, e] of Object.entries(value)) {
    requireValue(FIELD_KEYS.includes(key as FieldKey) && object(e) && Object.keys(e).every(k => allowed.includes(k)), "Invalid evidence field");
    integer(e.at_ms, "at_ms", chunk.start_seconds * 1000, chunk.end_seconds * 1000 - 1);
    score(e.confidence, "field confidence", true);
    text(e.method, "method", 128); text(e.selection_reason, "selection_reason", 512);
    requireValue(typeof e.frame_sha256 === "string" && /^[a-f0-9]{64}$/.test(e.frame_sha256), "Invalid frame_sha256");
    integer(e.source_width, "source_width", 1, 16384); integer(e.source_height, "source_height", 1, 16384);
    requireValue(Array.isArray(e.region) && e.region.length === 4 && e.region.every(n => typeof n === "number" && Number.isFinite(n)), "Invalid region");
    const [x, y, w, h] = e.region as number[];
    requireValue(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= (e.source_width as number) && y + h <= (e.source_height as number), "Region outside referenced image");
    requireValue(["intro", "pre_fight", "post_fight", "unknown"].includes(e.phase as string), "Invalid evidence phase");
    for (const k of ["model", "prompt_version"]) if (e[k] !== undefined) text(e[k], k, 128);
    if (e.raw_text !== undefined) requireValue(typeof e.raw_text === "string" && e.raw_text.length <= 1024, "Invalid raw_text");
    if (e.run_segment_id !== undefined) {
      requireValue(key === "streamer_hero", "Only streamer_hero supports run_segment_id");
      text(e.run_segment_id, "run_segment_id", 128);
      requireValue((e.run_segment_id as string).trim().length > 0, "Invalid run_segment_id");
    }
    if (e.inherited_from !== undefined) {
      const ref = e.inherited_from;
      requireValue(key === "streamer_hero" && object(ref) && Object.keys(ref).length === 3 &&
        Object.keys(ref).every(k => ["detection_id", "run_segment_id", "at_ms"].includes(k)), "Invalid inherited_from");
      uuid(ref.detection_id);
      requireValue(e.run_segment_id !== undefined && ref.run_segment_id === e.run_segment_id && ref.at_ms === e.at_ms,
        "Inherited reference must preserve segment and observation time");
    }
    const image = await claimedImage(env, chunk, token, e.image_path, e.at_ms as number, heads);
    requireValue(Number(image.customMetadata?.width) === e.source_width && Number(image.customMetadata?.height) === e.source_height,
      "Evidence dimensions must match uploaded JPEG");
    if (e.samples !== undefined) {
      requireValue(Array.isArray(e.samples) && e.samples.length <= 8, "Invalid evidence samples");
      for (const sample of e.samples) {
        requireValue(object(sample) && Object.keys(sample).every(k => ["at_ms", "image_path"].includes(k)), "Invalid evidence sample");
        integer(sample.at_ms, "sample at_ms", chunk.start_seconds * 1000, chunk.end_seconds * 1000 - 1);
        await claimedImage(env, chunk, token, sample.image_path, sample.at_ms as number, heads);
      }
    }
  }
  return value as FieldObservations;
}

type PublicationCheck = { sql: string; args: unknown[] };
interface RunPublication {
  id: string; publish_id: string | null; chunk_id: string; vod_id: number; frame_time_seconds: number;
  publish_claim: string | null; publish_body: string | null; streamer_hero: string | null; igd: number | null; field_evidence: string;
}
function supportedDay(day: unknown, evidence: FieldObservations) {
  return typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 20 && evidence.igd?.phase === "pre_fight";
}
/** Reuse changes the selection, never the original observation identity (including optional fields). */
function originalProof(e: FieldObservation) {
  const { selection_reason: _reason, inherited_from: _ref, ...proof } = e;
  return canonical(proof);
}
function rootReference(ref: FieldObservation["inherited_from"], root: RunPublication, proof: FieldObservation) {
  return ref && (ref.detection_id === root.id || ref.detection_id === root.publish_id) &&
    ref.run_segment_id === proof.run_segment_id && ref.at_ms === proof.at_ms;
}
function latestObservation(e: FieldObservation) {
  return Math.max(e.at_ms, ...(e.samples ?? []).map(sample => sample.at_ms));
}
/** Reference consistency only: the trusted processor, not this backend, observes continuity. */
async function validateRunReference(env: Env, chunk: Record<string, any>, token: string, record: Record<string, unknown>,
  at: number, evidence: FieldObservations, batch: unknown[]): Promise<PublicationCheck[]> {
  const hero = evidence.streamer_hero;
  if (!hero?.run_segment_id && !hero?.inherited_from) return [];
  requireValue(record.streamer_hero != null && supportedDay(record.igd, evidence),
    "Segmented streamer hero requires a non-null hero and supported pre_fight day");
  if (!hero.inherited_from) return []; // Direct proofs without segments remain compatible too.
  const root = await one<RunPublication>(env, "SELECT * FROM detections WHERE id=? OR publish_id=?", hero.inherited_from.detection_id, hero.inherited_from.detection_id);
  requireValue(root && root.chunk_id === chunk.id && root.vod_id === chunk.vod_id && root.publish_claim === token &&
    root.publish_body !== null && root.frame_time_seconds < at, "Inherited root must be persisted earlier in this chunk and claim");
  const rootEvidence: FieldObservations = JSON.parse(root.field_evidence), proof = rootEvidence.streamer_hero;
  requireValue(proof && !proof.inherited_from && proof.run_segment_id === hero.run_segment_id &&
    root.streamer_hero === record.streamer_hero && supportedDay(root.igd, rootEvidence) &&
    rootReference(hero.inherited_from, root, proof) && originalProof(hero) === originalProof(proof),
    "Inherited hero must preserve the direct root hero, segment and original proof");
  // Do not filter by hero, day, name state, claim or visibility: unsupported encounters break reuse.
  // Strictly-before also excludes the current publication from exact-body retries.
  const previous = await one<RunPublication>(env,
    "SELECT * FROM detections WHERE chunk_id=? AND frame_time_seconds<? ORDER BY frame_time_seconds DESC LIMIT 1", chunk.id, at);
  requireValue(previous && previous.publish_claim === token && previous.publish_body !== null &&
    previous.vod_id === chunk.vod_id && root.frame_time_seconds <= previous.frame_time_seconds,
    "Inheritance requires the immediately preceding persisted encounter in this claim");
  const previousEvidence: FieldObservations = JSON.parse(previous.field_evidence), previousHero = previousEvidence.streamer_hero;
  requireValue(previousHero && previous.streamer_hero === record.streamer_hero &&
    previousHero.run_segment_id === hero.run_segment_id && supportedDay(previous.igd, previousEvidence) &&
    previous.igd! + 1 === record.igd && root.igd! <= previous.igd! &&
    originalProof(previousHero) === originalProof(proof) &&
    (previous.id === root.id || rootReference(previousHero.inherited_from, root, proof)),
    "Previous encounter must retain this root and segment with exactly the preceding supported day");
  requireValue(latestObservation(proof) < at * 1000 && latestObservation(rootEvidence.igd!) < at * 1000 &&
    latestObservation(previousEvidence.igd!) < at * 1000 &&
    (previous.id === root.id || Math.max(latestObservation(proof), latestObservation(rootEvidence.igd!)) < previous.frame_time_seconds * 1000),
    "Inherited proof cannot reference a future observation");
  // Checks run before mutations. A new predecessor in this batch cannot become a
  // hidden gap after validation; already-persisted exact root/previous retries are fine.
  requireValue(!batch.some(candidate => {
    if (!object(candidate)) return false;
    const time = candidate.timestamp ?? candidate.frame_time_seconds;
    return typeof time === "number" && time > previous.frame_time_seconds && time < at;
  }), "Inheritance cannot skip a predecessor being published in this batch");
  const snapshots = previous.id === root.id ? [root] : [root, previous];
  return [
    ...snapshots.map(row => ({
      sql: "SELECT EXISTS(SELECT 1 FROM detections WHERE id=? AND chunk_id=? AND vod_id=? AND frame_time_seconds=? AND publish_id IS ? AND publish_claim=? AND publish_body=? AND field_evidence=? AND streamer_hero IS ? AND igd IS ?)",
      args: [row.id, row.chunk_id, row.vod_id, row.frame_time_seconds, row.publish_id, token, row.publish_body, row.field_evidence, row.streamer_hero, row.igd],
    })),
    { sql: "SELECT (SELECT id FROM detections WHERE chunk_id=? AND frame_time_seconds<? ORDER BY frame_time_seconds DESC LIMIT 1) IS ?",
      args: [chunk.id, at, previous.id] },
  ];
}

export async function publish(env: Env, id: string, token: string | null, input: unknown) {
  const chunk = await owned(env, id, token);
  requireValue(Array.isArray(input) && input.length <= 50, "At most 50 detections per request");
  const statements: D1PreparedStatement[] = [], heads = new Map<string, Promise<R2Object | null>>();
  const checks: PublicationCheck[] = [{
    sql: "SELECT EXISTS(SELECT 1 FROM chunks WHERE id=? AND claim_token=? AND status='processing' AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))", args: [id, token],
  }];
  const anchors = new Set<number>(), ids = new Set<string>();
  let inserted = 0, replaced = 0, unchanged = 0;
  for (const record of input) {
    requireValue(object(record), "Invalid detection");
    const publisherId = uuid(record.id), v2 = record.schema_version === 2;
    requireValue(record.schema_version === undefined || v2, "Unsupported schema_version");
    if (v2) requireValue(Object.keys(record).every(k => ["schema_version", "id", "timestamp", "frame_time_seconds", "username", "confidence", "name_state", "encounter_confidence",
      "rank", "igd", "ghost_hero", "streamer_hero", "wins_remaining", "lethal", "storage_path", "field_evidence", "no_right_edge", "truncated"].includes(k)), "Unsupported detection field");
    const at = integer(v2 ? (record.timestamp ?? record.frame_time_seconds) : record.frame_time_seconds, "timestamp", chunk.start_seconds, chunk.end_seconds - 1);
    requireValue(record.timestamp === undefined || record.frame_time_seconds === undefined || record.timestamp === record.frame_time_seconds, "Conflicting anchor timestamps");
    requireValue(!anchors.has(at) && !ids.has(publisherId), "Duplicate ID or anchor in request"); anchors.add(at); ids.add(publisherId);
    for (const flag of ["no_right_edge", "truncated"]) requireValue(record[flag] == null || typeof record[flag] === "boolean", `Invalid ${flag}`);
    const state = v2 ? record.name_state : "legacy";
    requireValue(["legacy", "complete", "partial", "obstructed", "masked", "unreadable"].includes(state as string) && (!v2 || state !== "legacy"), "Invalid name_state");
    const named = state === "legacy" || state === "complete";
    const observed = named || state === "partial" || state === "obstructed";
    if (observed && record.username !== null) {
      text(record.username, "username", 128);
      requireValue((record.username as string).trim().length > 0, "Invalid username");
      score(record.confidence, "confidence", v2);
    } else requireValue(!named && record.username === null && record.confidence === null, "This name state requires null text and confidence");
    if (v2) score(record.encounter_confidence, "encounter_confidence");
    if (record.igd != null) integer(record.igd, "igd", 1, 20);
    requireValue(record.rank == null || ["bronze", "silver", "gold", "diamond", "legend"].includes(record.rank as string), "Invalid rank");
    for (const field of ["ghost_hero", "streamer_hero"]) requireValue(record[field] == null || (v2 && HEROES.includes(record[field] as string)), `Invalid ${field}`);
    if (record.wins_remaining != null) { requireValue(v2, "Clock fields require schema_version 2"); integer(record.wins_remaining, "wins_remaining", 0, 10); }
    requireValue(record.lethal == null || (v2 && typeof record.lethal === "boolean"), "Invalid lethal");
    const evidence = v2 ? await validateEvidence(env, chunk, token!, record.field_evidence, heads) : {};
    if (v2) {
      requireValue(evidence.encounter && evidence.username, "Encounter and name-state observations are required");
      for (const field of FIELD_KEYS.filter(k => !["encounter", "username"].includes(k)))
        requireValue(record[field] == null || evidence[field], `${field} requires its own evidence`);
      // The selected context is the actual observed intro, not a later clock or anchor-time fiction.
      requireValue(record.storage_path === evidence.encounter.image_path && evidence.encounter.phase === "intro", "storage_path must be selected intro evidence");
      requireValue(/\/(?:detection_\d+|evidence_\d+_(?:intro|detection))\.jpg$/.test(record.storage_path as string), "Encounter context must be an intro image, not a clock/debug crop");
      checks.push(...await validateRunReference(env, chunk, token!, record, at, evidence, input));
    } else {
      requireValue(record.field_evidence === undefined, "field_evidence requires schema_version 2");
      const key = imageKey(chunk, token!, at);
      requireValue(record.storage_path === `/detections/${key}`, "Screenshot must belong to the current claim");
      await claimedImage(env, chunk, token!, record.storage_path, at * 1000, heads);
    }
    const name = typeof record.username === "string" ? record.username.toLowerCase() : null;
    const normalized = { id: publisherId, timestamp: at, schema_version: v2 ? 2 : 1, username: record.username, confidence: record.confidence,
      rank: record.rank ?? null, igd: record.igd ?? null, storage_path: record.storage_path, no_right_edge: !!record.no_right_edge, truncated: !!record.truncated,
      name_state: state, encounter_confidence: v2 ? record.encounter_confidence : null, ghost_hero: record.ghost_hero ?? null,
      streamer_hero: record.streamer_hero ?? null, wins_remaining: record.wins_remaining ?? null, lethal: record.lethal ?? null, field_evidence: evidence };
    const body = canonical(normalized);
    const prior = await rows(env, "SELECT * FROM detections WHERE vod_id=? AND frame_time_seconds=?", chunk.vod_id, at);
    if (prior.length > 1) throw new HttpError(409, "Ambiguous historical publications at anchor; operator review required");
    const old = prior[0];
    if (await one(env, "SELECT 1 FROM detections WHERE (id=? OR publish_id=?) AND NOT(vod_id=? AND frame_time_seconds=?)", publisherId, publisherId, chunk.vod_id, at))
      throw new HttpError(409, "Detection ID belongs to another anchor");
    if (old) {
      if (old.chunk_id !== id) throw new HttpError(409, "Anchor belongs to another chunk");
      if (old.publish_claim === token) {
        if (old.publish_body !== body) throw new HttpError(409, "Detection retry body differs within current claim");
        checks.push({ sql: "SELECT EXISTS(SELECT 1 FROM detections WHERE id=? AND publish_claim=? AND publish_body=?)", args: [old.id, token, body] });
        unchanged++; continue;
      }
      if (old.name_state !== "legacy" && publisherId !== old.id && publisherId !== old.publish_id)
        throw new HttpError(409, "Distinct encounter IDs collide at the same anchor second");
      checks.push({ sql: "SELECT EXISTS(SELECT 1 FROM detections WHERE id=? AND publish_claim IS ? AND publish_body IS ?) AND NOT EXISTS(SELECT 1 FROM detections WHERE (id=? OR publish_id=?) AND id!=?)",
        args: [old.id, old.publish_claim, old.publish_body, publisherId, publisherId, old.id] });
    } else checks.push({ sql: "SELECT NOT EXISTS(SELECT 1 FROM detections WHERE (vod_id=? AND frame_time_seconds=?) OR id=? OR publish_id=?)", args: [chunk.vod_id, at, publisherId, publisherId] });
    if (name) {
      // Retained fragments/low-quality names still need the FK parent, but do
      // not become identity candidates merely because observed text exists.
      const grams = trigrams(name);
      statements.push(statement(env, "INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,?)", name, grams.length));
      if (named && (record.confidence as number) > 0.7) statements.push(statement(env,
        "INSERT OR IGNORE INTO search_grams(gram,name) SELECT value,? FROM json_each(?)", name, JSON.stringify(grams)));
    }
    const fields = ["username", "username_lower", "confidence", "rank", "storage_path", "no_right_edge", "truncated", "igd", "name_state", "encounter_confidence", "ghost_hero", "streamer_hero", "wins_remaining", "lethal", "field_evidence", "publish_id", "publish_claim", "publish_body"];
    const values = [record.username, name, record.confidence, record.rank, record.storage_path, !!record.no_right_edge, !!record.truncated, record.igd,
      state, v2 ? record.encounter_confidence : null, record.ghost_hero, record.streamer_hero, record.wins_remaining, record.lethal, canonical(evidence), publisherId, token, body];
    if (old) {
      statements.push(statement(env, `UPDATE detections SET ${fields.map(f => `${f}=?`).join(",")} WHERE id=?`, ...values, old.id)); replaced++;
    } else {
      statements.push(statement(env, `INSERT INTO detections(id,chunk_id,vod_id,frame_time_seconds,${fields.join(",")}) VALUES(${Array(fields.length + 4).fill("?").join(",")})`, publisherId, id, chunk.vod_id, at, ...values)); inserted++;
    }
  }
  // All observations/images validated before any write. Assertions and replacement
  // share a transaction: expiry/conflict rolls back search indexes and every row.
  if (input.some(record => object(record) && record.schema_version === 2 && record.name_state === "masked") && (inserted || replaced))
    statements.unshift(statement(env, "UPDATE vods SET streamer_mode=1 WHERE id=? AND streamer_mode=0", chunk.vod_id));
  await atomic(env, checks, statements);
  if (inserted || replaced) await coalesceVod(env, chunk.vod_id).catch(error =>
    console.log(JSON.stringify({ event: "coalesce_failed", vod_id: chunk.vod_id, error: String(error) })));
  return { published: inserted + replaced + unchanged, inserted, replaced, unchanged };
}

/** Compatibility route, intentionally NON-destructive. Publications are per-anchor
 * replacements acknowledged by POST, not a full-chunk manifest. Unmatched existing
 * encounters remain current; a failed/empty retry cannot silently delete evidence.
 * Orphan/old objects stay private. Deliberate recording deletion is separate.
 */
export async function clearChunk(env: Env, id: string, token: string | null) {
  await owned(env, id, token);
  const retained = (await one<{ n: number }>(env, "SELECT count(*) AS n FROM detections WHERE chunk_id=?", id))!.n;
  return { deleted: 0, retained, replacement: "per_anchor" };
}
