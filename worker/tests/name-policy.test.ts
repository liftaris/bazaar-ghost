import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearChunk, publish, upload } from "../detections";
import { linkAnchors } from "../coalesce";
import { one, rows, statement } from "../http";
import { nativeRoute } from "../native-api";
import { notify } from "../notifications";
import { claim, plan, updateChunk } from "../processing";
import { proposeForRecording } from "../session-proposals";
import { mergeSessions, moveRecording, undoSessionEvent } from "../sessions";
import { publicImageVisible, publicState } from "../visibility";

const how = { actor: "name-policy-test", evidence: "Reviewed the same session in both recordings" };
const jpeg = new Uint8Array([255,216,255,192,0,17,8,4,56,7,128,3,1,17,0,2,17,0,3,17,0,255,217]);
let chunks: Array<Record<string, any>>, tokens: string[];
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "discord-channel" })));
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'name-policy','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'name-policy','Name policy')"),
    ...[1,2].map(id => statement(env, "INSERT INTO vods(id,streamer_id,source_id,title,duration_seconds,bazaar_chapters,ready_for_processing) VALUES(?,1,?,'Policy session',3600,'[0,3600]',1)", id, String(id))),
  ]);
  chunks = [...await plan(env, 1), ...await plan(env, 2)];
  tokens = await Promise.all(chunks.map(async c => (await claim(env, c.id)).claim_token!));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function detection(index = 0, at = chunks[index].start_seconds + 12, text: string | null = "Whole.Name", state = text === null ? "masked" : "complete") {
  const atMs = at * 1000 + 25;
  const path = (await upload(env, new Request("http://local/image", { method: "PUT", headers: {
    "X-Claim-Token": tokens[index], "Content-Type": "image/jpeg",
  }, body: jpeg }), chunks[index].id, atMs, "intro", true)).storage_path;
  const proof = { at_ms: atMs, image_path: path, phase: "intro", method: "test-native-ocr", confidence: 0.99,
    frame_sha256: "a".repeat(64), source_width: 1920, source_height: 1080,
    region: [0,0,1920,1080], selection_reason: "actual observed intro" };
  return { schema_version: 2, id: `00000000-0000-5000-8000-${String((index + 1) * 10000 + at).padStart(12, "0")}`,
    timestamp: at, username: text, confidence: text === null ? null : 0.99, name_state: state,
    encounter_confidence: 0.99, storage_path: path, field_evidence: { encounter: proof, username: { ...proof, raw_text: text ?? "******" } } };
}
type Detection = Awaited<ReturnType<typeof detection>>;
const post = (index: number, ds: Detection[], database = env, token = tokens[index]) => publish(database, chunks[index].id, token, ds);
const sessionOf = async (id = 1) => (await one<{ session_id: string }>(env, "SELECT session_id FROM vods WHERE id=?", id))!.session_id;
const anchor = async (vod = 1, at = 12) => (await one<{ id: number }>(env, "SELECT matchup_id AS id FROM matchup_anchors WHERE vod_id=? AND anchor_seconds=?", vod, at))!.id;
async function get(path: string) {
  const response = await SELF.fetch(`http://local/api/v1${path}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<any>();
}
async function nextClaim(index = 0) {
  await statement(env, "UPDATE chunks SET status='pending',claim_token=NULL,lease_expires_at=NULL WHERE id=?", chunks[index].id).run();
  tokens[index] = (await claim(env, chunks[index].id)).claim_token!;
}

it.each(["partial", "obstructed"])("retains %s text and confidence on scoped views but not identity indexes/discovery by default", async state => {
  const d = await detection(0, 12, "!?片 段-é..", state);
  await post(0, [d]);
  const id = await anchor();
  expect(await one(env, "SELECT username,username_lower,confidence,name_state FROM detections WHERE id=?", d.id))
    .toEqual({ username: d.username, username_lower: d.username!.toLowerCase(), confidence: 0.99, name_state: state });
  expect(await one(env, "SELECT name FROM search_names WHERE name=?", d.username!.toLowerCase())).not.toBeNull();
  expect(await rows(env, "SELECT * FROM search_grams")).toEqual([]);
  expect(await rows(env, "SELECT * FROM notification_outbox_v2")).toEqual([]);
  expect((await get("/search")).items).toEqual([]);
  const canonical = { id, opponent: { username: d.username, confidence: 0.99, nameState: state } };
  for (const path of ["/search?excludeObstructed=false", "/search?recordingId=1", `/search?sessionId=${await sessionOf()}&sort=time`])
    expect((await get(path)).items[0]).toMatchObject(canonical);
  expect((await get(`/matchups/${id}`)).detections[0]).toMatchObject({ username: d.username, confidence: 0.99, nameState: state });
  expect((await get("/recordings/1/timeline")).items[0]).toMatchObject({ username: d.username, nameState: state });
  expect((await get("/recordings/1/detections")).items[0]).toMatchObject({ username: d.username, nameState: state });
  expect((await get("/search?recordingId=1&excludeObstructed=true")).items).toEqual([]);
  expect((await get(`/search?q=${encodeURIComponent(d.username!)}&excludeObstructed=false`)).items).toEqual([]);
});

it("accepts observed complete Unicode, punctuation and multi-token text without a lexical identity allowlist", async () => {
  const names = ["!?!", "Ça va 玩家", "O'Name (EU)"], ds = await Promise.all(names.map((name, i) => detection(0, 12 + i, name)));
  await post(0, ds);
  expect((await get("/search?recordingId=1")).items.map((m: any) => m.opponent.username).sort()).toEqual(names.sort());
  for (const username of [" ", "a".repeat(129), "bad\u0001name"])
    await expect(post(1, [{ ...await detection(1), username }])).rejects.toMatchObject({ status: 400 });
});

it("prefers a low-confidence complete name over a stronger obstruction, consistently across SQL pools and field proof", async () => {
  const a = await detection(0, 12, "Trusted whole"), b = await detection(2, 12, "Trusted wh", "obstructed");
  a.confidence = 0.5;
  await post(0, [a]); await post(2, [b]);
  const id = await anchor(); await linkAnchors(env, [id, await anchor(2)], how);
  for (const path of ["/search", "/search?recordingId=1", `/search?sessionId=${await sessionOf()}`]) {
    const item = (await get(path)).items[0];
    expect(item.opponent).toMatchObject({ username: a.username, confidence: 0.5, nameState: "complete" });
    expect(item.fieldEvidence.username.detectionId).toBe(a.id);
  }
  expect((await get(`/matchups/${id}`)).fieldEvidence.username.detectionId).toBe(a.id);
  expect((await get(`/search?q=${encodeURIComponent(a.username!)}&excludeObstructed=false`)).items).toEqual([]);
  expect((await get(`/matchups/${id}`)).detections.find((d: any) => d.id === b.id).username).toBe(b.username);
});

it("does not trust stale name grams or obstructed text for automatic grouping/proposals", async () => {
  const a = await detection(0), b = await detection(2);
  await post(0, [a]); await post(2, [b]);
  await nextClaim(2);
  const fragment = await detection(2, 12, b.username, "obstructed");
  await post(2, [fragment]);
  expect(await rows(env, "SELECT * FROM search_grams")).not.toEqual([]);
  expect((await get(`/search?q=${a.username}&recordingId=2&excludeObstructed=false`)).items).toEqual([]);
  await moveRecording(env, 2, await sessionOf(), 0, how);
  expect(await rows(env, "SELECT * FROM public_matchups")).toHaveLength(2);
  expect(await proposeForRecording(env, 1)).toEqual([]);
});

it("hides all associated fights from discovery but retains Session/Recording browse, counts, flags and screenshots", async () => {
  const named = await detection(), masked = await detection(1, 1812, null), clean = await detection(2, 12, "Other");
  await post(0, [named]); await post(2, [clean]);
  await moveRecording(env, 2, await sessionOf(), 0, how);
  const before = await publicState(env, true);
  await post(1, [masked]);
  const after = await publicState(env, true);
  expect(after.search).toBeGreaterThan(before.search); expect(after.cache).toBeGreaterThan(before.cache);
  for (const query of ["", "excludeObstructed=false", "streamerId=1", "channelId=" + (await one(env, "SELECT platform_account_id AS id FROM vods WHERE id=1"))!.id,
    "q=Whole.Name", "q=Whole.Name&recordingId=1", `q=Other&sessionId=${await sessionOf()}&excludeObstructed=false`])
    expect((await get(`/search?${query}`)).items).toEqual([]);
  const sessionId = await sessionOf();
  for (const query of [`sessionId=${sessionId}`, `sessionId=${sessionId}&sort=time`, `sessionId=${sessionId}&q=%20%20`])
    expect((await get(`/search?${query}`)).items).toHaveLength(3);
  expect((await get("/search?recordingId=1")).items).toHaveLength(2);
  expect((await get("/recordings/1/playback")).recording.streamerMode).toBe(true);
  expect((await get("/recordings/2/playback")).recording.streamerMode).toBe(false);
  expect(await get(`/sessions/${sessionId}`)).toMatchObject({ streamerMode: true, matchupCount: 3 });
  expect((await get("/sessions?q=Policy")).items[0]).toMatchObject({ id: sessionId, streamerMode: true, matchupCount: 3 });
  expect(await get("/stats")).toMatchObject({ matchups: 3, recordings: 2 });
  expect(await publicImageVisible(env, named.storage_path.slice(12))).toBe(true);
  const id = await anchor();
  expect((await get(`/matchups/${id}`)).opponent.username).toBe(named.username);
  await statement(env, "UPDATE matchups SET status='hidden' WHERE id=?", id).run();
  expect((await get("/search?recordingId=1")).items).toHaveLength(1);
  expect(await publicImageVisible(env, named.storage_path.slice(12))).toBe(false);
});

it.each([true, false])("keeps VOD/Session masking monotonic with parallel chunks, mask-first=%s", async maskFirst => {
  const ordinary = await detection(), mask = await detection(1, 1812, null);
  for (const index of maskFirst ? [1,0] : [0,1]) await post(index, [index ? mask : ordinary]);
  const session = await sessionOf();
  expect(await one(env, "SELECT streamer_mode FROM vods WHERE id=1")).toEqual({ streamer_mode: 1 });
  expect(await one(env, "SELECT streamer_mode FROM sessions WHERE id=?", session)).toEqual({ streamer_mode: 1 });
  const revision = await publicState(env, true);
  expect(await post(1, [mask])).toMatchObject({ unchanged: 1 });
  expect(await publicState(env, true)).toEqual(revision);
  await expect(post(1, [{ ...mask, encounter_confidence: 0.8 }])).rejects.toMatchObject({ status: 409 });
  const old = tokens[1]; await nextClaim(1);
  await clearChunk(env, chunks[1].id, tokens[1]); await post(1, []);
  await post(1, [await detection(1, 1812, "Unmasked now")]);
  await expect(post(1, [mask], env, old)).rejects.toMatchObject({ status: 409 });
  await updateChunk(env, chunks[1].id, tokens[1], { status: "completed" });
  await statement(env, "DELETE FROM detections WHERE id=?", mask.id).run();
  expect(await one(env, "SELECT streamer_mode FROM vods WHERE id=1")).toEqual({ streamer_mode: 1 });
  await expect(statement(env, "UPDATE vods SET streamer_mode=0 WHERE id=1").run()).rejects.toThrow(/cannot be cleared/);
  await expect(statement(env, "UPDATE sessions SET streamer_mode=0 WHERE id=?", session).run()).rejects.toThrow(/cannot be cleared/);
});

it("rolls back mask marking and every sibling name/index when validation or final claim fencing fails", async () => {
  const masked = await detection(1, 1812, null), named = await detection(1, 1840, "RolledBack");
  await expect(post(1, [masked, { ...named, field_evidence: { ...named.field_evidence,
    username: { ...named.field_evidence.username, source_width: 1921 } } }])).rejects.toMatchObject({ status: 400 });
  expect(await one(env, "SELECT streamer_mode FROM vods WHERE id=1")).toEqual({ streamer_mode: 0 });
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await statement(env, "UPDATE chunks SET lease_expires_at='2000-01-01' WHERE id=?", chunks[1].id).run();
      return target.batch(statements);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(post(1, [masked, named], { ...env, DB: db })).rejects.toMatchObject({ status: 409 });
  expect(await rows(env, "SELECT * FROM detections")).toEqual([]);
  expect(await rows(env, "SELECT * FROM search_names")).toEqual([]);
  expect(await rows(env, "SELECT * FROM search_grams")).toEqual([]);
  expect(await rows(env, "SELECT * FROM mutation_checks")).toEqual([]);
  expect((await one(env, "SELECT streamer_mode FROM sessions WHERE id=?", await sessionOf()))!.streamer_mode).toBe(0);
  expect((await one(env, "SELECT streamer_mode FROM vods WHERE id=1"))!.streamer_mode).toBe(0);
});

it("validates obstruction filters and binds cursor/cache snapshots to query and sticky mode", async () => {
  await post(0, [await detection(0, 12), await detection(0, 24, "Second")]);
  for (const query of ["excludeObstructed=1", "excludeObstructed=TRUE", "excludeObstructed=", "excludeObstructed=true&excludeObstructed=false", "q=***&excludeObstructed=invalid"])
    expect((await SELF.fetch(`http://local/api/v1/search?${query}`)).status).toBe(400);
  const first = await get("/search?excludeObstructed=false&limit=1");
  expect(first.nextCursor).not.toBeNull();
  expect((await SELF.fetch(`http://local/api/v1/search?excludeObstructed=true&cursor=${first.nextCursor}`)).status).toBe(400);
  const hosted = { ...env, ENVIRONMENT: "validation" };
  const request = new Request("http://local/api/v1/search");
  expect((await (await nativeRoute(request, hosted)).json<any>()).items).toHaveLength(2);
  await post(1, [await detection(1, 1812, null)]);
  expect((await SELF.fetch(`http://local/api/v1/search?excludeObstructed=false&cursor=${first.nextCursor}`)).status).toBe(409);
  expect((await (await nativeRoute(request, hosted)).json<any>()).items).toEqual([]);
});

it("propagates observations on move/merge/undo and reads a concurrent empty loser's flag in the merge transaction", async () => {
  const source = await sessionOf(), target = await sessionOf(2);
  await post(0, [await detection(0, 12, null)]);
  const moved = await moveRecording(env, 1, target, 0, how);
  expect(moved.session).toMatchObject({ streamer_mode: 1 });
  await undoSessionEvent(env, moved.event_id, how);
  expect(await sessionOf()).toBe(source);
  expect((await one(env, "SELECT streamer_mode FROM sessions WHERE id=?", target))!.streamer_mode).toBe(1);
  // A clean recording was never directly observed as masked, even after it leaves a flagged Session.
  await statement(env, "INSERT INTO sessions(id,origin) VALUES(?, 'operator')", "c".repeat(32)).run();
  await moveRecording(env, 2, "c".repeat(32), 0, how);
  expect((await one(env, "SELECT streamer_mode FROM vods WHERE id=2"))!.streamer_mode).toBe(0);
  expect((await one(env, "SELECT streamer_mode FROM sessions WHERE id=?", "c".repeat(32)))!.streamer_mode).toBe(0);
  // Empty loser initially unflagged. A parallel observation lands after JS reads,
  // before the atomic merge: the SQL OR must read it, not a stale boolean snapshot.
  await statement(env, "INSERT INTO sessions(id,origin,streamer_id) VALUES(?,'operator',1)", "d".repeat(32)).run();
  const db = new Proxy(env.DB, { get(targetDb, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await statement(env, "UPDATE sessions SET streamer_mode=1 WHERE id=?", "d".repeat(32)).run();
      return targetDb.batch(statements);
    };
    const value = Reflect.get(targetDb, key); return typeof value === "function" ? value.bind(targetDb) : value;
  } });
  const merged = await mergeSessions({ ...env, DB: db }, "c".repeat(32), "d".repeat(32), 0, how);
  expect(merged.session).toMatchObject({ streamer_mode: 1 });
  await undoSessionEvent(env, merged.event_id, how);
  expect((await one(env, "SELECT streamer_mode FROM sessions WHERE id=?", "d".repeat(32)))!.streamer_mode).toBe(1);
  expect((await one(env, "SELECT streamer_mode FROM sessions WHERE id=?", "c".repeat(32)))!.streamer_mode).toBe(1);
});

it("propagates a late observation through retired Session successors without recursive-trigger assumptions", async () => {
  const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  await env.DB.batch(ids.map(id => statement(env, "INSERT INTO sessions(id,origin) VALUES(?,'operator')", id)));
  await statement(env, "UPDATE sessions SET merged_into=? WHERE id=?", ids[1], ids[0]).run();
  await statement(env, "UPDATE sessions SET merged_into=? WHERE id=?", ids[2], ids[1]).run();
  await statement(env, "UPDATE sessions SET streamer_mode=1 WHERE id=?", ids[0]).run();
  expect(await rows(env, "SELECT streamer_mode FROM sessions WHERE id IN(?,?,?)", ...ids)).toEqual(ids.map(() => ({ streamer_mode: 1 })));
});

it("suppresses pending named notifications after linked/Session masking, including a mask during destination lookup", async () => {
  const a = await detection(), b = await detection(2);
  await post(0, [a]); await post(2, [b]);
  const first = await anchor(), second = await anchor(2);
  await statement(env, "INSERT INTO notification_subscriptions(discord_user_id,username,username_lower,notify_type) VALUES('u','Whole.Name','whole.name','dm')").run();
  await statement(env, "UPDATE notification_outbox_v2 SET eligible_at='2000-01-01'").run();
  const prod = { ...env, ENVIRONMENT: "production", OUTBOUND_ENABLED: "true", DISCORD_BOT_TOKEN: "test" };
  // The first source is now unavailable, but a linked clean recording still plays.
  await post(1, [await detection(1, 1812, null)]);
  await linkAnchors(env, [first, second], how);
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=1").run();
  expect((await get("/search?recordingId=2")).items).toHaveLength(1);
  expect((await get("/search?q=Whole.Name")).items).toEqual([]);
  await notify(prod, first);
  expect(fetch).not.toHaveBeenCalled();
  expect((await one(env, "SELECT suppressed_reason FROM notification_outbox_v2 WHERE matchup_id=?", first))!.suppressed_reason).toBe("no_source");
  // A separate clean matchup queues normally, then masking appears during the DM lookup.
  const next = await detection(2, 40); await post(2, [next]); const id = await anchor(2, 40);
  await statement(env, "UPDATE notification_outbox_v2 SET eligible_at='2000-01-01' WHERE matchup_id=?", id).run();
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await statement(env, "UPDATE vods SET streamer_mode=1 WHERE id=2").run();
    return Response.json({ id: "dm-channel" });
  });
  await notify(prod, id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await one(env, "SELECT suppressed_reason FROM notification_outbox_v2 WHERE matchup_id=?", id))!.suppressed_reason).toBe("no_source");
});
