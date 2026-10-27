import type { RecordingIgdQuality } from "../contracts/public-api";
import { atomic } from "./atomic";
import { canonical, FIELD_KEYS, type FieldKey, type FieldObservation, type FieldObservations } from "./detections";
import { body, HttpError, integer, one, requireValue, rows, statement, uuid } from "./http";
import { projectEncounter, type SourceRow } from "./native-model";

interface Snapshot {
  id: string; vod_id: number; igd: number | null; field_evidence: string; publish_body: string | null;
  correction_id: string | null;
}
async function snapshot(env: Env, id: string) {
  uuid(id);
  const row = await one<Snapshot>(env, `SELECT d.id,d.vod_id,d.igd,d.field_evidence,d.publish_body,c.id AS correction_id
    FROM detections d LEFT JOIN igd_corrections c ON c.detection_id=d.id WHERE d.id=?`, id);
  if (!row) throw new HttpError(404, "Detection not found");
  const bytes = new TextEncoder().encode(canonical(row));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  return { row, digest };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, name: string, max: number): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), `Invalid ${name}`);
  return value;
}
function field(value: unknown): FieldKey {
  const key = FIELD_KEYS.find(key => key === value);
  requireValue(key, "Invalid source field");
  return key;
}

/** Registered source pixels are reused; raw detections and observations never change. */
export async function correctIgd(env: Env, id: string, input: unknown) {
  requireValue(object(input) && Object.keys(input).every(key => ["inputDigest", "igd", "method", "actor", "reason", "sourceRefs"].includes(key)), "Invalid correction");
  requireValue(Object.hasOwn(input, "igd"), "igd is required (null explicitly clears it)");
  const igd = input.igd === null ? null : integer(input.igd, "igd", 1, 20);
  const method = text(input.method, "method", 128), actor = text(input.actor, "actor", 128), reason = text(input.reason, "reason", 512);
  const { row, digest } = await snapshot(env, id);
  if (input.inputDigest !== digest) throw new HttpError(409, "Detection or correction changed; refresh inputDigest");
  const observations: FieldObservations = JSON.parse(row.field_evidence);
  requireValue(Array.isArray(input.sourceRefs) && input.sourceRefs.length > 0 && input.sourceRefs.length <= 8, "Provide 1-8 registered source references");
  const sourceRefs = input.sourceRefs.map(ref => {
    requireValue(object(ref) && Object.keys(ref).every(key => ["detectionId", "field"].includes(key)) && ref.detectionId === id,
      "Source references must belong to this detection");
    const key = field(ref.field);
    requireValue(observations[key], "Source observation not found");
    return { detectionId: id, field: key };
  });
  const source = observations[sourceRefs[0].field]!;
  for (const ref of sourceRefs) {
    const observation = observations[ref.field]!;
    requireValue(observation.image_path === source.image_path && observation.at_ms === source.at_ms && observation.frame_sha256 === source.frame_sha256,
      "Correction sources must describe the same image observation");
  }
  const image = await env.DETECTIONS.head(source.image_path.replace(/^\/detections\//, ""));
  if (!image) throw new HttpError(409, "Source image is no longer available");
  const evidence: FieldObservation = {
    at_ms: source.at_ms, image_path: source.image_path, frame_sha256: source.frame_sha256,
    source_width: source.source_width, source_height: source.source_height, region: source.region, phase: source.phase,
    method, confidence: null, selection_reason: reason,
  };
  const correctionId = crypto.randomUUID();
  await atomic(env, [{ sql: `SELECT EXISTS(SELECT 1 FROM detections d LEFT JOIN igd_corrections c ON c.detection_id=d.id
    WHERE d.id=? AND d.igd IS ? AND d.field_evidence=? AND d.publish_body IS ? AND c.id IS ?)`,
    args: [id, row.igd, row.field_evidence, row.publish_body, row.correction_id] }], [statement(env,
    `INSERT INTO igd_corrections(detection_id,id,igd,raw_igd,raw_field_evidence,raw_publish_body,input_digest,evidence,source_refs,actor,reason)
     VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(detection_id) DO UPDATE SET
     id=excluded.id,igd=excluded.igd,raw_igd=excluded.raw_igd,raw_field_evidence=excluded.raw_field_evidence,
     raw_publish_body=excluded.raw_publish_body,input_digest=excluded.input_digest,evidence=excluded.evidence,
     source_refs=excluded.source_refs,actor=excluded.actor,reason=excluded.reason,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    id, correctionId, igd, row.igd, row.field_evidence, row.publish_body, digest, canonical(evidence), canonical(sourceRefs), actor, reason)]);
  return { detectionId: id, correctionId, igd, rawIgd: row.igd };
}

export async function igdAdminRoute(req: Request, env: Env, id: string) {
  if (req.method === "GET") {
    const { row, digest } = await snapshot(env, id);
    const correction = await one(env, "SELECT * FROM igd_corrections WHERE detection_id=?", id);
    return Response.json({ detectionId: id, recordingId: row.vod_id, rawIgd: row.igd,
      rawFieldEvidence: JSON.parse(row.field_evidence), inputDigest: digest, correction });
  }
  if (req.method === "PUT") return Response.json(await correctIgd(env, id, await body(req)));
  if (req.method === "DELETE") {
    const input = await body(req);
    requireValue(Object.keys(input).length === 1 && typeof input.inputDigest === "string", "Provide inputDigest");
    const { row, digest } = await snapshot(env, id);
    if (input.inputDigest !== digest) throw new HttpError(409, "Detection or correction changed; refresh inputDigest");
    await atomic(env, [{ sql: `SELECT EXISTS(SELECT 1 FROM detections d LEFT JOIN igd_corrections c ON c.detection_id=d.id
      WHERE d.id=? AND d.igd IS ? AND d.field_evidence=? AND d.publish_body IS ? AND c.id IS ?)`,
      args: [id, row.igd, row.field_evidence, row.publish_body, row.correction_id] }],
    [statement(env, "DELETE FROM igd_corrections WHERE detection_id=?", id)]);
    return Response.json({ detectionId: id, correctionId: null, igd: row.igd, rawIgd: row.igd });
  }
  throw new HttpError(405, "Method not allowed");
}

export async function recordingIgdQuality(env: Env, recordingId: number): Promise<RecordingIgdQuality> {
  const sources = await rows<SourceRow>(env, "SELECT * FROM public_sources WHERE vod_id=? ORDER BY at,detection_id", recordingId);
  const matchups = new Map<number, SourceRow[]>();
  for (const source of sources) {
    const group = matchups.get(source.matchup_id);
    if (group) group.push(source); else matchups.set(source.matchup_id, [source]);
  }
  const found = [...matchups.values()].map(group => {
    const encounter = projectEncounter(group);
    const selected = group.find(row => row.detection_id === encounter.fieldEvidence.igd?.detectionId) ?? group[0];
    return { detection_id: selected.detection_id, at: group[0].at, igd: encounter.igd,
      raw_igd: encounter.rawIgd, igd_correction_id: encounter.igdCorrection?.id ?? null };
  });
  const known = found.filter(row => row.igd !== null).length, rawKnown = found.filter(row => row.raw_igd !== null).length;
  const suggestions: RecordingIgdQuality["suggestions"] = [];
  for (let i = 1; i + 1 < found.length; i++) {
    const previous = found[i - 1], current = found[i], next = found[i + 1];
    if (previous.igd === null || next.igd === null || next.igd !== previous.igd + 2 || current.igd === previous.igd + 1 || current.igd_correction_id) continue;
    suggestions.push({ detectionId: current.detection_id, at: current.at, currentIgd: current.igd, suggestedIgd: previous.igd + 1,
      previousDetectionId: previous.detection_id, nextDetectionId: next.detection_id, method: "bracketed_sequence", requiresReview: true });
  }
  return { recordingId, metric: "coverage", total: found.length, known, missing: found.length - known,
    corrected: found.filter(row => row.igd_correction_id !== null).length, rawKnown, rawMissing: found.length - rawKnown, suggestions };
}
