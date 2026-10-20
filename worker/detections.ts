import {
  HttpError,
  integer,
  now,
  readBytes,
  requireValue,
  rows,
  statement,
  uuid,
} from "./http";
import { coalesceVod } from "./coalesce";
import { owned } from "./processing";
import { trigrams } from "./search";

export function imageKey(
  chunk: Record<string, any>,
  token: string,
  timestamp: number,
  kind = "detection",
) {
  requireValue(
    ["detection", "ocr_debug", "emblem_boxes"].includes(kind),
    "Invalid image kind",
  );
  requireValue(
    timestamp >= chunk.start_seconds && timestamp < chunk.end_seconds,
    "Frame outside chunk",
  );
  return `${chunk.source && chunk.source !== "twitch" ? `${chunk.source}/` : ""}${chunk.source_id}/${chunk.id}/${token}/${kind}_${timestamp}.jpg`;
}
export async function upload(
  env: Env,
  req: Request,
  id: string,
  timestamp: number,
  kind: string,
) {
  const token = req.headers.get("X-Claim-Token");
  const chunk = await owned(env, id, token);
  integer(timestamp, "timestamp");
  requireValue(
    req.headers.get("content-type") === "image/jpeg",
    "Expected JPEG",
  );
  const bytes = await readBytes(req, 8_000_000);
  requireValue(
    bytes.byteLength > 2 && bytes.byteLength <= 8_000_000,
    "JPEG must be 1 byte–8 MB",
  );
  requireValue(
    new Uint8Array(bytes)[0] === 255 && new Uint8Array(bytes)[1] === 216,
    "Invalid JPEG",
  );
  const key = imageKey(chunk, token!, timestamp, kind);
  await env.DETECTIONS.put(key, bytes, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  return { storage_path: `/detections/${key}` };
}
export async function publish(
  env: Env,
  id: string,
  token: string | null,
  input: unknown,
) {
  const chunk = await owned(env, id, token);
  requireValue(
    Array.isArray(input) && input.length <= 50,
    "At most 50 detections per request",
  );
  const statements: D1PreparedStatement[] = [];
  for (const record of input) {
    uuid(record.id);
    for (const flag of ["no_right_edge", "truncated"]) {
      requireValue(
        record[flag] == null || typeof record[flag] === "boolean",
        `Invalid ${flag}`,
      );
    }
    integer(record.frame_time_seconds, "frame_time_seconds");
    requireValue(
      typeof record.username === "string" &&
        record.username.trim().length > 0 &&
        record.username.length <= 128,
      "Invalid username",
    );
    requireValue(
      typeof record.confidence === "number" &&
        record.confidence >= 0 &&
        record.confidence <= 1,
      "Invalid confidence",
    );
    if (record.igd != null) integer(record.igd, "igd", 1, 20);
    requireValue(
      record.rank == null ||
        ["bronze", "silver", "gold", "diamond", "legend"].includes(record.rank),
      "Invalid rank",
    );
    const key = imageKey(chunk, token!, record.frame_time_seconds);
    requireValue(
      record.storage_path === `/detections/${key}`,
      "Screenshot must belong to the current claim",
    );
    if (!(await env.DETECTIONS.head(key)))
      throw new HttpError(409, "Required screenshot has not been uploaded");
    const name = record.username.toLowerCase(),
      grams = trigrams(name);
    statements.push(
      statement(
        env,
        "INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,?)",
        name,
        grams.length,
      ),
    );
    statements.push(
      statement(
        env,
        "INSERT OR IGNORE INTO search_grams(gram,name) SELECT value,? FROM json_each(?)",
        name,
        JSON.stringify(grams),
      ),
    );
    statements.push(
      statement(
        env,
        `INSERT OR IGNORE INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,rank,frame_time_seconds,storage_path,no_right_edge,truncated,igd)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chunks WHERE id=? AND claim_token=? AND status='processing' AND lease_expires_at>?)`,
        record.id,
        id,
        chunk.vod_id,
        record.username,
        name,
        record.confidence,
        record.rank,
        record.frame_time_seconds,
        record.storage_path,
        Boolean(record.no_right_edge),
        Boolean(record.truncated),
        record.igd,
        id,
        token,
        now(),
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  // A stale claim never publishes. Surface the race as a conflict rather than false success.
  await owned(env, id, token);
  // New anchors may match another Recording of the same Session; failures leave the Session flagged for the scheduled reconcile.
  if (input.some((record) => record.confidence > 0.7))
    await coalesceVod(env, chunk.vod_id).catch((error) =>
      console.log(JSON.stringify({ event: "coalesce_failed", vod_id: chunk.vod_id, error: String(error) })));
  return { published: input.length };
}
export async function clearChunk(env: Env, id: string, token: string | null) {
  await owned(env, id, token);
  let count = 0;
  while (true) {
    const batch = await rows(
      env,
      "SELECT id,storage_path FROM detections WHERE chunk_id=? LIMIT 100",
      id,
    );
    if (!batch.length) break;
    await owned(env, id, token);
    // Delete the DB rows only while still owning the claim; old images are unique to old tokens.
    const result = await statement(
      env,
      "DELETE FROM detections WHERE id IN(SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM chunks WHERE id=? AND claim_token=? AND status='processing' AND lease_expires_at>?) RETURNING id",
      JSON.stringify(batch.map((d) => d.id)),
      id,
      token,
      now(),
    ).all();
    if (!result.results.length) throw new HttpError(409, "Lost chunk claim");
    const keys = batch.flatMap((d) => {
      if (!d.storage_path) return [];
      const key = d.storage_path.replace(/^\/detections\//, "");
      return [
        key,
        key.replace(/detection_(\d+)\.jpg$/, "ocr_debug_$1.jpg"),
        key.replace(/detection_(\d+)\.jpg$/, "emblem_boxes_$1.jpg"),
      ];
    });
    if (keys.length) await env.DETECTIONS.delete([...new Set(keys)]);
    count += result.results.length;
  }
  return { deleted: count };
}
