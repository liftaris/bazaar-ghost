import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { publish, type FieldObservation, type FieldObservations } from "../detections";
import { one, rows, statement } from "../http";
import { claim, plan } from "../processing";

// Protocol-only JPEG SOF header: 1920x1080, no decoder or inference involved.
const jpeg = new Uint8Array([255,216,255,192,0,17,8,4,56,7,128,3,1,17,0,2,17,0,3,17,0,255,217]);
const segment = "recording-local-continuity:0";
interface Detection {
  schema_version: number; id: string; timestamp: number; username: string | null; confidence: number | null;
  name_state: string; encounter_confidence: number; rank: string | null; igd: number | null;
  streamer_hero: string | null; storage_path: string; field_evidence: FieldObservations;
}
let chunks: string[], tokens: string[];
beforeEach(async () => {
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'inheritance','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'inheritance','Inheritance')"),
    ...[1,2].map(id => statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,bazaar_chapters,ready_for_processing) VALUES(?,1,?,120,'[0,120]',1)", id, String(id))),
  ]);
  chunks = [(await plan(env, 1))[0].id, (await plan(env, 2))[0].id];
  tokens = [(await claim(env, chunks[0])).claim_token!, (await claim(env, chunks[1])).claim_token!];
});
function headers(index = 0) {
  return { Authorization: `Bearer ${env.PROCESSOR_KEY}`, "X-Claim-Token": tokens[index] };
}
async function image(atMs: number, kind = "intro", index = 0) {
  const response = await SELF.fetch(`http://local/api/processor/chunks/${chunks[index]}/images?timestamp_ms=${atMs}&kind=${kind}`, {
    method: "PUT", headers: { ...headers(index), "Content-Type": "image/jpeg" }, body: jpeg,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ storage_path: string }>()).storage_path;
}
function observation(image_path: string, at_ms: number, phase: FieldObservation["phase"] = "intro"): FieldObservation {
  return { at_ms, image_path, phase, method: "fixed-task-inference", confidence: 0.97,
    frame_sha256: "a".repeat(64), source_width: 1920, source_height: 1080, region: [0,0,960,1080],
    selection_reason: "direct supported observation", model: "test-model", prompt_version: "hero-v1", raw_text: "direct raw result",
    samples: [{ at_ms, image_path }] };
}
async function detection(at = 10, day: number | null = 1, index = 0): Promise<Detection> {
  const atMs = at * 1000 + 25, path = await image(atMs, "intro", index);
  const clockMs = at * 1000 - 1000, clock = await image(clockMs, "clock", index);
  const intro = observation(path, atMs), dayProof = observation(clock, clockMs, "pre_fight");
  return { schema_version: 2, id: crypto.randomUUID(), timestamp: at,
    username: null, confidence: null, name_state: "masked", encounter_confidence: 0.99, rank: null,
    igd: day, streamer_hero: "stelle", storage_path: path,
    field_evidence: { encounter: intro, username: { ...intro, raw_text: "******" },
      igd: dayProof, streamer_hero: { ...intro, run_segment_id: segment } } };
}
function inherit(current: Detection, root: Detection, rootId = root.id) {
  const proof = structuredClone(root.field_evidence.streamer_hero!);
  current.field_evidence.streamer_hero = { ...proof, selection_reason: "accepted_hero_reused_under_observed_run_continuity",
    inherited_from: { detection_id: rootId, run_segment_id: proof.run_segment_id!, at_ms: proof.at_ms } };
  return current;
}
async function post(records: unknown[], index = 0, status = 200) {
  const response = await SELF.fetch(`http://local/api/processor/chunks/${chunks[index]}/detections`, {
    method: "POST", headers: { ...headers(index), "Content-Type": "application/json" }, body: JSON.stringify({ detections: records }),
  });
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json<Record<string, unknown>>();
}
async function get(path: string) {
  const response = await SELF.fetch(`http://local/api/v1${path}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<any>();
}
async function nextClaim(index = 0) {
  await statement(env, "UPDATE chunks SET status='pending',claim_token=NULL,lease_expires_at=NULL WHERE id=?", chunks[index]).run();
  tokens[index] = (await claim(env, chunks[index])).claim_token!;
}
async function persisted(id: string) {
  return one(env, "SELECT * FROM detections WHERE id=? OR publish_id=?", id, id);
}

it("persists A day1 -> B day2 -> C day3 with the same original direct root, including masked encounters and exact retries", async () => {
  const a = await detection(); await post([a]);
  const b = inherit(await detection(20,2),a); await post([b]);
  const c = inherit(await detection(30,3),a); await post([c]);
  for (const d of [b,c]) {
    const saved = (await persisted(d.id))!;
    expect(JSON.parse(saved.field_evidence).streamer_hero).toEqual(d.field_evidence.streamer_hero);
    expect(saved.streamer_hero).toBe("stelle");
    expect(await post([d])).toMatchObject({ published:1, unchanged:1, inserted:0, replaced:0 });
  }
  expect((await rows(env, "SELECT * FROM detections"))).toHaveLength(3);
  // A and B in the same retry batch are already persisted, not forward roots.
  expect(await post([a,b])).toMatchObject({ unchanged:2 });
});

it("accepts a fresh direct recheck as a new root, never an old root across that recheck", async () => {
  const a = await detection(); await post([a]);
  const b = await detection(20,2); await post([b]);
  const c = await detection(30,3);
  await post([inherit(structuredClone(c),a)],0,400);
  await post([inherit(c,b)]);
  expect(JSON.parse((await persisted(c.id))!.field_evidence).streamer_hero.inherited_from.detection_id).toBe(b.id);
});

it("retains legacy and schema-2 direct evidence without run segments or supported days", async () => {
  const d = await detection(10,null);
  delete d.field_evidence.streamer_hero!.run_segment_id;
  d.field_evidence.igd!.phase = "unknown";
  await post([d]);
  const path = `/detections/1/${chunks[0]}/${tokens[0]}/detection_40.jpg`;
  const uploaded = await SELF.fetch(`http://local/api/processor/chunks/${chunks[0]}/images?timestamp=40`, {
    method:"PUT",headers:{...headers(),"Content-Type":"image/jpeg"},body:jpeg,
  });
  expect(uploaded.status).toBe(200);
  await post([{id:crypto.randomUUID(),frame_time_seconds:40,username:"Legacy",confidence:0.9,storage_path:path}]);
});

it.each(["null-hero","null-day","unknown-phase","post-fight-phase","empty-segment","oversized-segment","whitespace-segment"])("rejects unsupported direct run segments: %s", async kind => {
  const a = await detection();
  if (kind === "null-hero") a.streamer_hero = null;
  if (kind === "null-day") a.igd = null;
  if (kind === "unknown-phase") a.field_evidence.igd!.phase = "unknown";
  if (kind === "post-fight-phase") a.field_evidence.igd!.phase = "post_fight";
  if (kind === "empty-segment") a.field_evidence.streamer_hero!.run_segment_id = "";
  if (kind === "oversized-segment") a.field_evidence.streamer_hero!.run_segment_id = "x".repeat(129);
  if (kind === "whitespace-segment") a.field_evidence.streamer_hero!.run_segment_id = " \n ";
  await post([a],0,400);
  expect(await rows(env,"SELECT * FROM detections")).toEqual([]);
});

it.each(["encounter","username","rank","igd","ghost_hero","wins_remaining","lethal"] as const)("rejects segment or inheritance metadata on %s", async field => {
  const a = await detection();
  a.field_evidence[field] = { ...a.field_evidence.encounter!, run_segment_id: segment };
  await post([a],0,400);
  delete a.field_evidence[field]!.run_segment_id;
  a.field_evidence[field]!.inherited_from = {detection_id:a.id,run_segment_id:segment,at_ms:10025};
  await post([a],0,400);
});

it.each(["wrong-hero","wrong-segment","wrong-ref-segment","wrong-ref-time","arbitrary-root","null-hero","missing-segment","missing-ref-key","extra-ref-key","nonuuid-root"])("rejects inconsistent inherited reference: %s", async kind => {
  const a = await detection(); await post([a]);
  const b = inherit(await detection(20,2),a), e = b.field_evidence.streamer_hero!;
  if (kind === "wrong-hero") b.streamer_hero = "jules";
  if (kind === "wrong-segment") { e.run_segment_id = "other"; e.inherited_from!.run_segment_id = "other"; }
  if (kind === "wrong-ref-segment") e.inherited_from!.run_segment_id = "other";
  if (kind === "wrong-ref-time") e.inherited_from!.at_ms++;
  if (kind === "arbitrary-root") e.inherited_from!.detection_id = crypto.randomUUID();
  if (kind === "null-hero") b.streamer_hero = null;
  if (kind === "missing-segment") delete e.run_segment_id;
  if (kind === "missing-ref-key") delete (e.inherited_from as Partial<NonNullable<FieldObservation["inherited_from"]>>).at_ms;
  if (kind === "extra-ref-key") Object.assign(e.inherited_from!, {fake:true});
  if (kind === "nonuuid-root") e.inherited_from!.detection_id = "not-a-uuid";
  await post([b],0,400);
  expect(await rows(env,"SELECT * FROM detections")).toHaveLength(1);
});

it.each(["at_ms","image_path","frame_sha256","source_width","source_height","region","method","model","prompt_version","confidence","samples","raw_text","phase"] as const)("rejects altered original source proof: %s", async field => {
  const a = await detection(); await post([a]);
  const b = inherit(await detection(20,2),a), e = b.field_evidence.streamer_hero!;
  if (field === "at_ms") { e.at_ms = 19000; e.image_path = b.field_evidence.igd!.image_path; e.inherited_from!.at_ms = e.at_ms; }
  else if (field === "image_path") e.image_path = await image(e.at_ms,"clock");
  else if (field === "frame_sha256") e.frame_sha256 = "b".repeat(64);
  else if (field === "source_width") e.source_width--;
  else if (field === "source_height") { e.source_height--; e.region[3]--; }
  else if (field === "region") e.region[2]--;
  else if (field === "confidence") e.confidence = 0.98;
  else if (field === "samples") e.samples = [{at_ms:19000,image_path:b.field_evidence.igd!.image_path}];
  else if (field === "phase") e.phase = "pre_fight";
  else e[field] = "mutated";
  await post([b],0,400);
});

it.each(["unknown-hero","unknown-day","unknown-phase","day-reset","same-day","skipped-day","fresh-root","other-hero","other-segment"])("does not skip an intervening persisted encounter: %s", async kind => {
  const a = await detection(); await post([a]);
  const b = inherit(await detection(20,2),a);
  if (kind === "unknown-hero") { b.streamer_hero=null; delete b.field_evidence.streamer_hero; }
  if (kind === "unknown-day") { b.igd=null; delete b.field_evidence.streamer_hero!.run_segment_id; delete b.field_evidence.streamer_hero!.inherited_from; }
  if (kind === "unknown-phase") { b.field_evidence.igd!.phase="unknown"; delete b.field_evidence.streamer_hero!.run_segment_id; delete b.field_evidence.streamer_hero!.inherited_from; }
  if (["day-reset","same-day","skipped-day","fresh-root","other-hero","other-segment"].includes(kind)) {
    const fresh = await detection(20,kind === "day-reset" ? 1 : kind === "same-day" ? 1 : kind === "skipped-day" ? 4 : 2);
    Object.assign(b,fresh);
    if (kind === "other-hero") b.streamer_hero="jules";
    if (kind === "other-segment") b.field_evidence.streamer_hero!.run_segment_id="other";
  }
  await post([b]);
  await post([inherit(await detection(30,3),a)],0,400);
});

it.each([null,1,3,20])("rejects unknown, reset, skipped or unsupported next day %s", async day => {
  const a = await detection(); await post([a]);
  await post([inherit(await detection(20,day),a)],0,400);
});

it("rejects using an inherited B as the direct root for C", async () => {
  const a = await detection(); await post([a]);
  const b = inherit(await detection(20,2),a); await post([b]);
  const c = inherit(await detection(30,3),b,b.id);
  await post([c],0,400);
});

it("requires an already-persisted root and predecessor, never a forward/same-batch root", async () => {
  const a = await detection(), b = inherit(await detection(20,2),a);
  await post([a,b],0,400); await post([b,a],0,400);
  expect(await rows(env,"SELECT * FROM detections")).toEqual([]);
  await post([a]);
  const gap = await detection(15,null); gap.streamer_hero=null; delete gap.field_evidence.streamer_hero;
  await post([b,gap],0,400); await post([gap,b],0,400);
  expect(await rows(env,"SELECT * FROM detections")).toHaveLength(1);
});

it("rejects a persisted future root and future-dated original proof", async () => {
  const a = await detection(30,1); await post([a]);
  await post([inherit(await detection(20,2),a)],0,400);
  const direct = await detection(10,1);
  direct.field_evidence.streamer_hero = { ...observation(await image(25000),25000),run_segment_id:segment };
  await post([direct]);
  await post([inherit(await detection(20,2),direct)],0,400);
});

it.each(["hero-sample","root-day","root-day-sample","previous-day","previous-day-sample"])("rejects future original/previous observations: %s", async kind => {
  const a=await detection();
  if(kind==="hero-sample") a.field_evidence.streamer_hero!.samples=[{at_ms:35000,image_path:await image(35000)}];
  if(kind==="root-day") a.field_evidence.igd=observation(await image(35000,"clock"),35000,"pre_fight");
  if(kind==="root-day-sample") a.field_evidence.igd!.samples=[{at_ms:35000,image_path:await image(35000,"clock")}];
  await post([a]);
  if(kind.startsWith("previous")) {
    const b=inherit(await detection(20,2),a);
    if(kind==="previous-day") b.field_evidence.igd=observation(await image(35000,"clock"),35000,"pre_fight");
    else b.field_evidence.igd!.samples=[{at_ms:35000,image_path:await image(35000,"clock")}];
    await post([b]);
    await post([inherit(await detection(30,3),a)],0,400);
  } else await post([inherit(await detection(20,2),a)],0,400);
});

it.each(["root-day-exceeds-previous","root-day-unknown","root-phase-unknown","previous-day-unknown","previous-phase-unknown"])("rejects corrected persisted day support: %s", async kind=>{
  const a=await detection(); await post([a]);
  const b=inherit(await detection(20,2),a); await post([b]);
  const root=kind.startsWith("root"), id=root?a.id:b.id;
  if(kind==="root-day-exceeds-previous") await statement(env,"UPDATE detections SET igd=3 WHERE id=?",id).run();
  else if(kind.endsWith("day-unknown")) await statement(env,"UPDATE detections SET igd=NULL WHERE id=?",id).run();
  else await statement(env,"UPDATE detections SET field_evidence=json_set(field_evidence,'$.igd.phase','unknown') WHERE id=?",id).run();
  await post([inherit(await detection(30,3),a)],0,400);
});

it("requires the original root's day observation to precede the previous inherited encounter too",async()=>{
  const a=await detection(); await post([a]);
  const b=inherit(await detection(20,2),a); await post([b]);
  const path=await image(25000,"clock");
  await statement(env,"UPDATE detections SET field_evidence=json_set(field_evidence,'$.igd',json(?)) WHERE id=?",
    JSON.stringify(observation(path,25000,"pre_fight")),a.id).run();
  await post([inherit(await detection(30,3),a)],0,400);
});

it("rejects cross-claim root reuse even if its old source image is rewritten to the current claim", async () => {
  const a = await detection(); await post([a]); await nextClaim();
  const b = inherit(await detection(20,2),a);
  await post([b],0,400);
  b.field_evidence.streamer_hero!.image_path = await image(a.field_evidence.streamer_hero!.at_ms);
  b.field_evidence.streamer_hero!.samples = [{at_ms:10025,image_path:b.field_evidence.streamer_hero!.image_path}];
  await post([b],0,400);
});

it("rejects cross-recording/chunk references, even with a valid current-claim copied source", async () => {
  const a = await detection(); await post([a]);
  const b = inherit(await detection(20,2,1),a);
  const copied = observation(await image(10025,"intro",1),10025);
  b.field_evidence.streamer_hero = {...copied,run_segment_id:segment,inherited_from:{detection_id:a.id,run_segment_id:segment,at_ms:10025}};
  await post([b],1,400);
});

it("rejects cross-chunk reuse in the same Recording with both valid active claims", async () => {
  await statement(env,"UPDATE chunks SET end_seconds=60 WHERE id=?",chunks[0]).run();
  await statement(env,"INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,1,60,120,1)",crypto.randomUUID()).run();
  const second = (await one(env,"SELECT id FROM chunks WHERE vod_id=1 AND start_seconds=60"))!.id;
  chunks.push(second); tokens.push((await claim(env,second)).claim_token!);
  const a=await detection(); await post([a]);
  const b=inherit(await detection(70,2,2),a);
  await post([b],2,400);
});

it("resolves canonical legacy IDs and current publisher aliases without inventing references", async () => {
  const legacyId=crypto.randomUUID();
  const uploaded=await SELF.fetch(`http://local/api/processor/chunks/${chunks[0]}/images?timestamp=10`,{
    method:"PUT",headers:{...headers(),"Content-Type":"image/jpeg"},body:jpeg,
  });
  const oldPath=(await uploaded.json<{storage_path:string}>()).storage_path;
  await post([{id:legacyId,frame_time_seconds:10,username:"Old",confidence:0.9,storage_path:oldPath}]);
  await nextClaim(); const a=await detection(); await post([a]);
  expect(await one(env,"SELECT id,publish_id FROM detections")).toEqual({id:legacyId,publish_id:a.id});
  const b=inherit(await detection(20,2),a,legacyId); await post([b]);
  const c=inherit(await detection(30,3),a,a.id); await post([c]);
  expect(await post([b,c])).toMatchObject({unchanged:2});
});

it.each(["root-body","root-claim","root-proof","previous-body","previous-claim","previous-proof","new-predecessor","claim-expiry"])("atomically rejects source/selection races and rolls back publication/indexes: %s", async race => {
  const a=await detection(); await post([a]);
  const b=inherit(await detection(20,2),a); await post([b]);
  const c=inherit(await detection(30,3),a);
  c.username="RaceOnlyName"; c.confidence=0.99; c.name_state="complete";
  const gap=await detection(25,null); gap.streamer_hero=null; delete gap.field_evidence.streamer_hero;
  let raced=false;
  const db=new Proxy(env.DB,{get(target,key){
    if(key==="batch") return async (statements:D1PreparedStatement[])=>{
      if(!raced){
        raced=true;
        if(race==="new-predecessor") await post([gap]);
        else if(race==="claim-expiry") await statement(env,"UPDATE chunks SET lease_expires_at='2000-01-01' WHERE id=?",chunks[0]).run();
        else {
          const id=race.startsWith("root")?a.id:b.id;
          if(race.endsWith("body")) await statement(env,"UPDATE detections SET publish_body=publish_body||' ' WHERE id=?",id).run();
          if(race.endsWith("claim")) await statement(env,"UPDATE detections SET publish_claim='raced-claim' WHERE id=?",id).run();
          if(race.endsWith("proof")) await statement(env,"UPDATE detections SET field_evidence=json_set(field_evidence,'$.streamer_hero.raw_text','corrected') WHERE id=?",id).run();
        }
      }
      return target.batch(statements);
    };
    const value=Reflect.get(target,key); return typeof value==="function"?value.bind(target):value;
  }});
  await expect(publish({...env,DB:db},chunks[0],tokens[0],[c])).rejects.toMatchObject({status:409});
  expect(await persisted(c.id)).toBeNull();
  expect(await one(env,"SELECT name FROM search_names WHERE name='raceonlyname'")).toBeNull();
  expect(await rows(env,"SELECT * FROM search_grams WHERE name='raceonlyname'")).toEqual([]);
  expect(await rows(env,"SELECT * FROM mutation_checks")).toEqual([]);
});

it("rejects later retries whose root/previous reference changed rather than treating them as fresh observations", async () => {
  const a=await detection(); await post([a]);
  const b=inherit(await detection(20,2),a); await post([b]);
  await statement(env,"UPDATE detections SET field_evidence=json_set(field_evidence,'$.streamer_hero.raw_text','corrected') WHERE id=?",a.id).run();
  await post([b],0,400);
});

it("projects original time/image and explicit root provenance; hidden root images remain private", async () => {
  const a=await detection(); await post([a]);
  const b=inherit(await detection(20,2),a); await post([b]);
  const id=(await one(env,"SELECT matchup_id FROM matchup_anchors WHERE current_detection_id=?",b.id))!.matchup_id;
  const detail=await get(`/matchups/${id}`);
  const expected={detectionId:b.id,atMs:10025,screenshotUrl:a.field_evidence.streamer_hero!.image_path,
    runSegmentId:segment,inheritedFrom:{detectionId:a.id,runSegmentId:segment,atMs:10025}};
  expect(detail.fieldEvidence.streamerHero).toMatchObject(expected);
  expect(detail.detections[0].fieldEvidence.streamerHero).toMatchObject(expected);
  expect((await get("/recordings/1/detections")).items.find((d: {id:string})=>d.id===b.id).fieldEvidence.streamerHero).toMatchObject(expected);
  expect((await get(`/search?recordingId=1`)).items.find((d:{id:number})=>d.id===id).fieldEvidence.streamerHero).toMatchObject(expected);
  expect((await SELF.fetch(`http://local${expected.screenshotUrl}`)).status).toBe(200);
  await statement(env,"UPDATE matchups SET status='hidden' WHERE id=(SELECT matchup_id FROM matchup_anchors WHERE current_detection_id=?)",a.id).run();
  expect((await SELF.fetch(`http://local${expected.screenshotUrl}`)).status).toBe(404);
  expect((await get(`/matchups/${id}`)).fieldEvidence.streamerHero).toMatchObject(expected);
  // The reference still names its real original observation, not B's visible intro.
  expect(await env.DETECTIONS.head(expected.screenshotUrl.slice(12))).not.toBeNull();
  expect((await SELF.fetch(`http://local${b.storage_path}`)).status).toBe(200);
});

it("keeps 128-character segment and 32-KiB field-evidence bounds", async () => {
  const a=await detection(); a.field_evidence.streamer_hero!.run_segment_id="x".repeat(128);
  await post([a]);
  const b=inherit(await detection(20,2),a);
  b.field_evidence.encounter!.raw_text="x".repeat(1025); await post([b],0,400);
  b.field_evidence.encounter!.raw_text="";
  // Individually bounded paths/samples can still exceed the aggregate evidence budget.
  const oversized=Object.fromEntries(["encounter","username","rank","igd","ghost_hero","streamer_hero","wins_remaining","lethal"].map(key=>[key,{
    ...b.field_evidence.encounter, samples:Array.from({length:8},()=>({at_ms:10025,image_path:"x".repeat(2000)})),
  }]));
  expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(32768);
  await post([{...b,field_evidence:oversized}],0,400);
});
