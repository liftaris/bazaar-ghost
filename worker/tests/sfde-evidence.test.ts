import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearChunk, publish, upload, type FieldObservation } from "../detections";
import { coalesceSession, linkAnchors } from "../coalesce";
import { one, rows, statement } from "../http";
import { notify } from "../notifications";
import { claim, plan } from "../processing";
import { moveRecording } from "../sessions";
import { proposeForRecording } from "../session-proposals";
import { publicImageVisible, publicState } from "../visibility";
import worker from "../index";
import { authEnv, login, mockProviders, ORIGIN } from "./auth-fixture";

const how = { actor: "sfde-test", evidence: "Manually reviewed these two recordings of the same encounter" };
// JPEG SOF marker with 1920x1080 dimensions. No decoder/inference runs in these protocol tests.
const jpeg = new Uint8Array([255,216,255,192,0,17,8,4,56,7,128,3,1,17,0,2,17,0,3,17,0,255,217]);
let chunks: Array<{ id: string }>, tokens: string[];
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "discord-channel" })));
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'sfde-evidence','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'sfde-evidence','SFDE')"),
    ...[1,2].map(id => statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,bazaar_chapters,ready_for_processing) VALUES(?,1,?,120,'[0,120]',1)", id, String(id))),
  ]);
  chunks = [(await plan(env, 1))[0], (await plan(env, 2))[0]].map(c => ({ id: c.id }));
  tokens = [(await claim(env, chunks[0].id)).claim_token!, (await claim(env, chunks[1].id)).claim_token!];
});
afterEach(() => vi.unstubAllGlobals());
async function image(index: number, atMs: number, kind = "intro", token = tokens[index]) {
  return (await upload(env, new Request("http://local/image", { method: "PUT", headers: {
    "X-Claim-Token": token, "Content-Type": "image/jpeg",
  }, body: jpeg }), chunks[index].id, atMs, kind, true)).storage_path;
}
function observation(path: string, atMs: number, phase: FieldObservation["phase"] = "intro"): FieldObservation {
  return { at_ms: atMs, image_path: path, phase, method: "local_cv_v1", confidence: null, frame_sha256: "a".repeat(64),
    source_width: 1920, source_height: 1080, region: [0,0,1920,1080], selection_reason: "best supported visible frame" };
}
async function detection(index = 0, at = 12, name: string | null = null, token = tokens[index]) {
  const intro = await image(index, at * 1000 + 25, "intro", token), clock = await image(index, at * 1000 + 2025, "clock", token);
  const e = observation(intro, at * 1000 + 25), c = observation(clock, at * 1000 + 2025, "pre_fight");
  return { schema_version: 2, id: `00000000-0000-5000-8000-${String((index + 1) * 1000 + at).padStart(12, "0")}`, timestamp: at,
    username: name, confidence: name ? 0.92 : null, name_state: name ? "complete" : "unreadable", encounter_confidence: 0.99,
    rank: "gold", igd: 9, ghost_hero: "vanessa", streamer_hero: "dooley", wins_remaining: 0, lethal: false,
    storage_path: intro, field_evidence: { encounter: e, username: { ...e, raw_text: name ?? "***" }, rank: e,
      igd: c, ghost_hero: e, streamer_hero: e, wins_remaining: c, lethal: c } };
}
const post = (index: number, records: unknown[], token = tokens[index], database = env) => publish(database, chunks[index].id, token, records);
async function get(path: string) {
  const response = await SELF.fetch(`http://local/api/v1${path}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<any>();
}
const anchor = async (vod = 1, at = 12) => (await one<{ id: number }>(env, "SELECT id FROM matchup_anchors WHERE vod_id=? AND anchor_seconds=?", vod, at))!.id;
async function nextClaim(index = 0) {
  await statement(env, "UPDATE chunks SET status='pending',claim_token=NULL,lease_expires_at=NULL WHERE id=?", chunks[index].id).run();
  tokens[index] = (await claim(env, chunks[index].id)).claim_token!;
  return tokens[index];
}

it("publishes masked encounters on scoped browse/detail/timeline/favorites/counts, never in discovery/name search/indexes/notifications", async () => {
  const d = await detection(); d.name_state = "masked";
  expect(await post(0, [d])).toMatchObject({ published: 1, inserted: 1, replaced: 0, unchanged: 0 });
  expect(await rows(env, "SELECT username,username_lower,confidence,name_state FROM detections")).toEqual([{ username: null, username_lower: null, confidence: null, name_state: "masked" }]);
  expect(await rows(env, "SELECT * FROM search_names")).toEqual([]);
  expect(await rows(env, "SELECT * FROM search_grams")).toEqual([]);
  expect(await rows(env, "SELECT * FROM notification_outbox_v2")).toEqual([]);
  expect((await get("/search")).items).toEqual([]);
  const id = await anchor(), browse = await get("/search?recordingId=1");
  expect(browse.items).toHaveLength(1);
  expect(browse.items[0]).toMatchObject({ id, opponent: { username: null, confidence: null, nameState: "masked", igd: 9 },
    encounter: { confidence: 0.99, winsRemaining: 0, lethal: false, ghostHero: "vanessa", streamerHero: "dooley" } });
  const detail = await get(`/matchups/${id}`);
  expect(detail.detections[0]).toMatchObject({ username: null, nameState: "masked", encounter: { winsRemaining: 0, lethal: false } });
  expect(detail.fieldEvidence.igd).toMatchObject({ atMs: 14025, screenshotUrl: d.field_evidence.igd.image_path });
  expect(detail.fieldEvidence.username).toMatchObject({ atMs: 12025 });
  expect(detail.fieldEvidence.username.confidence).toBeNull();
  expect(JSON.stringify(detail)).not.toContain("raw_text");
  expect((await get("/recordings/1/timeline")).items).toEqual([{ id, timestampSeconds: 12, username: null, nameState: "masked", rank: "gold" }]);
  expect((await get("/recordings/1/detections")).items[0].encounter.fieldEvidence.igd.atMs).toBe(14025);
  expect(await get("/stats")).toMatchObject({ matchups: 1, recordings: 1 });
  for (const q of ["masked", "unknown", "***", "Opponent"]) expect((await get(`/search?q=${encodeURIComponent(q)}`)).items).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  const session = (await one(env, "SELECT session_id FROM vods WHERE id=1"))!.session_id;
  expect((await get(`/search?sessionId=${session}&sort=time`)).items[0].opponent.username).toBeNull();
  expect(browse.items[0].recordedAt).toBeNull();
  mockProviders(); const { cookie, identity } = await login();
  const saved = await worker.fetch(new Request(`${ORIGIN}/api/v1/matchups/${id}/favorite`, { method: "PUT",
    headers: { Cookie: cookie, Origin: ORIGIN, "X-CSRF-Token": identity.csrfToken } }), authEnv());
  expect(saved.status).toBe(200);
  const favorites = await worker.fetch(new Request(`${ORIGIN}/api/v1/me/favorites`, { headers: { Cookie: cookie, Origin: ORIGIN } }), authEnv());
  expect(favorites.status).toBe(200);
  expect((await favorites.json<any>()).items[0]).toMatchObject({ id, opponent: { username: null }, encounter: { winsRemaining: 0, lethal: false } });
});

it.each(["partial", "obstructed", "unreadable"])("retains %s name-state observations without fabricating a name", async nameState => {
  const d = await detection(); d.name_state = nameState;
  await post(0, [d]);
  expect((await get("/search?recordingId=1")).items[0].opponent).toMatchObject({ username: null, nameState });
  expect(await rows(env, "SELECT * FROM notification_outbox_v2")).toEqual([]);
});

it("accepts nullable unobserved fields and unknown name confidence without making them searchable", async () => {
  const d = await detection(0, 12, "VisibleButUncalibrated");
  const unknown = { ...d, confidence: null, rank: null, igd: null, ghost_hero: null, streamer_hero: null, wins_remaining: null, lethal: null,
    field_evidence: { encounter: d.field_evidence.encounter, username: d.field_evidence.username } };
  await post(0, [unknown]);
  expect((await get("/search")).items[0].encounter).toMatchObject({ igd: null, ghostHero: null, streamerHero: null, winsRemaining: null, lethal: null });
  expect((await get("/search?q=VisibleButUncalibrated")).items).toEqual([]);
});

it("selects each field independently across manually established Sources; stronger names do not erase valid clocks", async () => {
  const a = await detection(0, 12, "Bestname"), b = await detection(1, 12);
  a.confidence = 0.99;
  a.igd = null as any; a.wins_remaining = null as any; a.lethal = null as any;
  delete (a.field_evidence as any).igd; delete (a.field_evidence as any).wins_remaining; delete (a.field_evidence as any).lethal;
  await post(0, [a]); await post(1, [b]);
  const x = await anchor(), y = await anchor(2);
  await linkAnchors(env, [x,y], how);
  for (const route of ["/search", "/search?q=Bestname", "/search?recordingId=1", `/matchups/${x}`]) {
    const response = await get(route), m = response.items?.[0] ?? response;
    expect(m.opponent).toMatchObject({ username: "Bestname", confidence: 0.99, igd: 9 });
    expect(m.encounter).toMatchObject({ winsRemaining: 0, lethal: false });
    expect(m.fieldEvidence.username.detectionId).toBe(a.id);
    expect(m.fieldEvidence.igd).toMatchObject({ detectionId: b.id, recordingId: 2, atMs: 14025 });
    expect(m.sources).toHaveLength(2);
  }
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=2").run();
  const m = await get(`/matchups/${x}`);
  expect(m.encounter.igd).toBe(9);
  expect(m.fieldEvidence.igd.screenshotUrl).toBeNull();
});

it("compares confidence only within a field's own method and uses stable observation-time ties", async () => {
  const a = await detection(0), b = await detection(1);
  a.igd = 5; a.field_evidence.igd.confidence = 0.7;
  b.igd = 9; b.field_evidence.igd.confidence = 0.9;
  await post(0, [a]); await post(1, [b]);
  const x = await anchor(); await linkAnchors(env, [x, await anchor(2)], how);
  expect((await get(`/matchups/${x}`)).encounter.igd).toBe(9);
  await statement(env, "UPDATE detections SET field_evidence=json_set(field_evidence,'$.igd.confidence',0.7) WHERE id=?", b.id).run();
  expect((await get(`/matchups/${x}`)).fieldEvidence.igd.detectionId).toBe(a.id);
});

it("uses millisecond image keys and rejects ambiguous upload parameters and overwriting published samples", async () => {
  const a = await image(0, 12001), b = await image(0, 12999);
  expect(a).not.toBe(b);
  expect(await image(0, 12001)).toBe(a);
  const headers = { Authorization: `Bearer ${env.PROCESSOR_KEY}`, "X-Claim-Token": tokens[0], "Content-Type": "image/jpeg" };
  for (const params of ["", "timestamp=12&timestamp_ms=12001", "timestamp_ms=NaN", "timestamp_ms=120000", "timestamp_ms=1.2", "timestamp_ms=1&timestamp_ms=2"]) {
    const response = await SELF.fetch(`http://local/api/processor/chunks/${chunks[0].id}/images?${params}`, { method: "PUT", headers, body: jpeg });
    expect(response.status, params).toBe(400);
  }
  const different = jpeg.slice(); different[different.length - 1] = 216;
  await expect(upload(env, new Request("http://local", { method: "PUT", headers, body: different }), chunks[0].id, 12001, "intro", true)).rejects.toMatchObject({ status: 409 });
});

it("acknowledges exact-body retries, conflicts on changed bodies and same-second IDs, and never reports ignored inserts", async () => {
  const d = await detection();
  await post(0, [d]);
  expect(await post(0, [{ ...d, field_evidence: { ...d.field_evidence } }])).toMatchObject({ inserted: 0, replaced: 0, unchanged: 1, published: 1 });
  await expect(post(0, [{ ...d, lethal: true }])).rejects.toMatchObject({ status: 409 });
  await expect(post(0, [{ ...d, id: crypto.randomUUID() }])).rejects.toMatchObject({ status: 409 });
  await expect(post(0, [d,d])).rejects.toMatchObject({ status: 400 });
  expect((await one(env, "SELECT count(*) AS n FROM detections"))!.n).toBe(1);
});

it("retains evidence on failed/empty retries and atomically replaces acknowledged anchors while preserving Matchup/detection IDs", async () => {
  const d = await detection(); await post(0, [d]);
  const id = await anchor(), before = await one(env, "SELECT * FROM detections WHERE id=?", d.id);
  const oldToken = tokens[0]; await nextClaim();
  expect(await clearChunk(env, chunks[0].id, tokens[0])).toEqual({ deleted: 0, retained: 1, replacement: "per_anchor" });
  expect(await one(env, "SELECT * FROM detections WHERE id=?", d.id)).toEqual(before);
  await post(0, []);
  expect(await publicImageVisible(env, d.storage_path.slice(12))).toBe(true);
  const broken = await detection(0, 12, "Recognized"); broken.field_evidence.igd.at_ms++;
  await expect(post(0, [broken])).rejects.toMatchObject({ status: 400 });
  expect(await one(env, "SELECT * FROM detections WHERE id=?", d.id)).toEqual(before);
  const replacement = await detection(0, 12, "Recognized");
  expect(await post(0, [replacement])).toMatchObject({ replaced: 1, inserted: 0 });
  expect(await anchor()).toBe(id);
  expect((await get(`/matchups/${id}`)).opponent.username).toBe("Recognized");
  expect(await rows(env, "SELECT * FROM notification_outbox_v2")).toEqual([]); // no retroactive notification
  expect(await publicImageVisible(env, d.storage_path.slice(12))).toBe(false);
  expect(await env.DETECTIONS.head(d.storage_path.slice(12))).not.toBeNull();
  await expect(post(0, [d], oldToken)).rejects.toMatchObject({ status: 409 });
  await nextClaim();
  const collision = await detection(); collision.id = crypto.randomUUID();
  await expect(post(0, [collision])).rejects.toMatchObject({ status: 409 });
});

it("recognizes a legacy same-anchor row and retains its UUID, social anchor, and later deterministic publisher ID", async () => {
  const key = `1/${chunks[0].id}/${tokens[0]}/detection_12.jpg`;
  await env.DETECTIONS.put(key, jpeg);
  expect(await upload(env, new Request("http://local/image", { method: "PUT", headers: {
    "X-Claim-Token": tokens[0], "Content-Type": "image/jpeg",
  }, body: jpeg }), chunks[0].id, 12, "detection")).toEqual({ storage_path: `/detections/${key}` });
  const legacy = { id: crypto.randomUUID(), frame_time_seconds: 12, username: "Oldname", confidence: 0.9, storage_path: `/detections/${key}` };
  await post(0, [legacy]); const id = await anchor();
  expect((await get(`/matchups/${id}`)).opponent.nameState).toBe("legacy");
  await nextClaim(); const replacement = await detection();
  await post(0, [replacement]);
  expect(await rows(env, "SELECT id,publish_id FROM detections")).toEqual([{ id: legacy.id, publish_id: replacement.id }]);
  expect(await anchor()).toBe(id);
  expect(await post(0, [replacement])).toMatchObject({ unchanged: 1 });
});

it.each(["encounter_confidence", "confidence"])("rejects non-finite %s before any batch write", async field => {
  const d = await detection(0, 12, "Complete");
  for (const invalid of [NaN, Infinity, -Infinity, -0.1, 1.1]) await expect(post(0, [{ ...d, [field]: invalid }])).rejects.toMatchObject({ status: 400 });
  expect(await rows(env, "SELECT * FROM detections")).toEqual([]);
});

it("rejects unsupported values, missing proofs, invalid claim/image/time/region/dimensions and inherited claims", async () => {
  const d = await detection(), foreign = await detection(1);
  const invalid = [
    { ...d, name_state: "complete" }, { ...d, username: "***" }, { ...d, name_state: "legacy" },
    { ...d, name_state: "complete", username: "\u0001", confidence: 0.9 },
    { ...d, ghost_hero: "unknown" }, { ...d, wins_remaining: 11 }, { ...d, wins_remaining: 1.5 }, { ...d, lethal: 0 },
    { ...d, timestamp: 120 }, { ...d, timestamp: 12.5 }, { ...d, frame_time_seconds: 13 },
    { ...d, field_evidence: { ...d.field_evidence, ghost_hero: undefined } },
    { ...d, field_evidence: { ...d.field_evidence, igd: undefined } },
    { ...d, field_evidence: { ...d.field_evidence, lethal: undefined } },
    { ...d, field_evidence: { ...d.field_evidence, igd: { ...d.field_evidence.igd, at_ms: 14026 } } },
    { ...d, field_evidence: { ...d.field_evidence, igd: { ...d.field_evidence.igd, image_path: foreign.field_evidence.igd.image_path } } },
    { ...d, field_evidence: { ...d.field_evidence, igd: { ...d.field_evidence.igd, region: [0,0,1921,1080] } } },
    { ...d, field_evidence: { ...d.field_evidence, igd: { ...d.field_evidence.igd, source_width: 1921 } } },
    { ...d, field_evidence: { ...d.field_evidence, igd: { ...d.field_evidence.igd, confidence: NaN } } },
    { ...d, field_evidence: { ...d.field_evidence, igd: { ...d.field_evidence.igd, samples: Array(9).fill({ at_ms: 14025, image_path: d.field_evidence.igd.image_path }) } } },
    { ...d, field_evidence: { ...d.field_evidence, streamer_hero: { ...d.field_evidence.streamer_hero, inherited_from: { detection_id: d.id, run_segment_id: "unproven", at_ms: 1 } } } },
  ];
  for (const value of invalid) await expect(post(0, [value])).rejects.toMatchObject({ status: 400 });
  await expect(post(0, [d], tokens[1])).rejects.toMatchObject({ status: 409 });
  expect(await rows(env, "SELECT * FROM detections")).toEqual([]);
});

it("rolls back every row/index when the claim expires after validation but before the transaction", async () => {
  const d = await detection(0, 12, "Complete");
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await statement(env, "UPDATE chunks SET lease_expires_at='2000-01-01' WHERE id=?", chunks[0].id).run();
      return target.batch(statements);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(post(0, [d], tokens[0], { ...env, DB: db })).rejects.toMatchObject({ status: 409 });
  expect(await rows(env, "SELECT * FROM detections")).toEqual([]);
  expect(await rows(env, "SELECT * FROM search_names")).toEqual([]);
  expect(await rows(env, "SELECT * FROM mutation_checks")).toEqual([]);
});

it("makes current field images public only for their real available Recording; historical, orphan and hidden-shared evidence remains private", async () => {
  const d = await detection(); await post(0, [d]);
  const key = d.field_evidence.igd.image_path.slice(12);
  expect(await publicImageVisible(env, key)).toBe(true);
  await statement(env, "UPDATE vods SET availability='unavailable' WHERE id=1").run();
  expect(await publicImageVisible(env, key)).toBe(false);
  await statement(env, "UPDATE vods SET availability='available' WHERE id=1").run();
  const e = await detection(1); await post(1, [e]);
  await statement(env, "UPDATE detections SET field_evidence=json_set(field_evidence,'$.igd.image_path',?) WHERE id=?", d.field_evidence.igd.image_path, e.id).run();
  await statement(env, "UPDATE matchups SET status='hidden' WHERE id=?", await anchor(2)).run();
  expect(await publicImageVisible(env, key)).toBe(false);
  await statement(env, "UPDATE matchups SET status='visible' WHERE id=?", await anchor(2)).run();
  const before = await publicState(env, true);
  await statement(env, "UPDATE detections SET field_evidence=json_remove(field_evidence,'$.igd','$.wins_remaining','$.lethal') WHERE id IN(?,?)", d.id,e.id).run();
  const after = await publicState(env, true);
  expect(after.search).toBeGreaterThan(before.search); expect(after.cache).toBeGreaterThan(before.cache);
  expect(await publicImageVisible(env, key)).toBe(false);
  const orphan = await image(0, 30000, "clock");
  expect(await publicImageVisible(env, orphan.slice(12))).toBe(false);
});

it("does not coalesce anonymous or low-name-confidence encounters, but manual overrides still work", async () => {
  const a = await detection(0, 12, "SameName"), b = await detection(1, 12, "SameName");
  b.confidence = 0.5;
  await post(0, [a]); await post(1, [b]);
  const session = (await one(env, "SELECT session_id FROM vods WHERE id=1"))!.session_id;
  await moveRecording(env, 2, session, 0, how); await coalesceSession(env, session);
  expect(await rows(env, "SELECT * FROM public_matchups")).toHaveLength(2);
  expect((await get("/search?q=SameName")).items).toHaveLength(1);
  expect(await proposeForRecording(env, 1)).toEqual([]);
  const x = await anchor(); await linkAnchors(env, [x, await anchor(2)], how);
  expect((await get(`/matchups/${x}`)).sources).toHaveLength(2);
});

it("excludes unknown names from proposal support, conflicts, distinct names and coverage denominators", async () => {
  const names = ["Alpha", "Beta", "Gamma"], times = [10,50,100];
  for (const index of [0,1]) {
    const known = await Promise.all(times.map((at, i) => detection(index, at, names[i])));
    const unknown = await Promise.all([15,20,25,30,35,40,45,55,60,65,70,75,80,85,90,95].map(at => detection(index, at)));
    await post(index, [...known, ...unknown]);
  }
  const made = await proposeForRecording(env, 1);
  expect(made).toHaveLength(1);
  expect(await one(env, "SELECT support,distinct_names,conflicts,coverage FROM session_link_proposals WHERE id=?", made[0].id))
    .toEqual({ support: 3, distinct_names: 3, conflicts: 0, coverage: 1 });
  await nextClaim();
  const lost = await detection(0, 50); await post(0, [lost]);
  expect(await one(env, "SELECT status FROM session_link_proposals WHERE id=?", made[0].id)).toEqual({ status: "superseded" });
  expect(await proposeForRecording(env, 1)).toEqual([]);
  await nextClaim();
  const restored = await detection(0, 50, "Beta"); await post(0, [restored]);
  expect(await proposeForRecording(env, 1)).toHaveLength(1); // stable Detection IDs, new proof revision
});

it("suppresses pending notifications after last eligible name loss and never includes masks beside a valid name", async () => {
  const a = await detection(0, 12, "Opponent"), b = await detection(1);
  await post(0, [a]); await post(1, [b]);
  const x = await anchor(); await linkAnchors(env, [x, await anchor(2)], how);
  await statement(env, "INSERT INTO notification_subscriptions(discord_user_id,username,username_lower,notify_type) VALUES('u','Opponent','opponent','dm')").run();
  await statement(env, "UPDATE notification_outbox_v2 SET eligible_at='2000-01-01'").run();
  const prod = { ...env, ENVIRONMENT: "production", OUTBOUND_ENABLED: "true", DISCORD_BOT_TOKEN: "test" };
  await notify(prod, x);
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls).toHaveLength(2);
  const message = JSON.parse(String(calls[1][1]?.body));
  expect(message.content).toContain("vs **Opponent**"); expect(message.content).not.toContain("null"); expect(message.content).not.toContain("***");
  const c = await detection(0, 40, "Opponent"); await post(0, [c]); const y = await anchor(1,40);
  await nextClaim(); const lost = await detection(0, 40); await post(0, [lost]);
  await statement(env, "UPDATE notification_outbox_v2 SET eligible_at='2000-01-01' WHERE matchup_id=?", y).run();
  await notify(prod, y);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await one(env, "SELECT suppressed_reason FROM notification_outbox_v2 WHERE matchup_id=?", y)).toEqual({ suppressed_reason: "no_source" });
});
