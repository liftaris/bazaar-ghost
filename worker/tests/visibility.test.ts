import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { linkDetections } from "./link-fixture";
import { publicCache } from "../cache";
import { one, rows, statement } from "../http";
import { publicImageVisible, publicRevision } from "../visibility";
import worker from "../index";

let twitch: string, youtube: string;
async function detect(vod: number, time: number, path = `/detections/${vod}/image_${time}.jpg`, confidence = 0.95) {
  const id = crypto.randomUUID();
  await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,storage_path)
    VALUES(?,?,?,'Opponent','opponent',?,?,?)`, id, `chunk-${vod}`, vod, confidence, time, path).run();
  return id;
}
const hide = (id: string, status = "hidden") => statement(env,
  "UPDATE matchups SET status=? WHERE id IN(SELECT matchup_id FROM matchup_anchors WHERE current_detection_id=?)", status, id).run();
beforeEach(async () => {
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'visibility','[0,0,1,1]')").run();
  await statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'visibility','Creator')").run();
  await statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('yt','youtube','UCabcdefghijklmnopqrstuv','Creator')").run();
  await statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,published_at) VALUES(1,1,'123',900,'2026-09-01T00:00:00.000Z')").run();
  await statement(env, "INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,published_at) VALUES(2,'youtube','abcdefghijk','yt',900,'2026-09-01T00:00:00.000Z')").run();
  for (const id of [1, 2]) await statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,?,0,900,0)", `chunk-${id}`, id).run();
  await statement(env, "INSERT INTO search_names(name,gram_count) VALUES('opponent',8)").run();
  twitch = await detect(1, 12); youtube = await detect(2, 12);
});

it("applies Matchup visibility to search views, public Matchups and aggregate counts", async () => {
  expect((await rows(env, "SELECT * FROM detection_search"))).toHaveLength(1);
  expect(await rows(env, "SELECT matchup_id FROM public_matchups")).toHaveLength(2);
  await hide(twitch);
  expect(await rows(env, "SELECT * FROM detection_search")).toEqual([]);
  expect((await rows(env, "SELECT detection_id FROM public_matchups")).map(row => row.detection_id)).toEqual([youtube]);
  expect((await rows(env, "SELECT detection_id FROM public_sources")).map(row => row.detection_id)).toEqual([youtube]);
  expect(await rows(env, "SELECT id FROM detections")).toHaveLength(2);
});
it("hides every Source of a linked Matchup together and restores it as one", async () => {
  const search = async (q = "") => (await (await SELF.fetch(`http://local/api/v1/search${q}`)).json<any>()).items;
  const group = await linkDetections(env, [twitch, youtube], "Manually reviewed the same opponent and surrounding game frames");
  let items = await search();
  expect(items).toHaveLength(1); expect(String(items[0].id)).toBe(group.matchup_id); expect(items[0].sources).toHaveLength(2);
  expect(await search("?platform=twitch&limit=1")).toHaveLength(1);
  await hide(twitch);
  expect(await search("?platform=twitch")).toEqual([]);
  expect(await search()).toEqual([]);
  await hide(youtube, "visible"); items = await search();
  expect(items).toHaveLength(1); expect(items[0].sources).toHaveLength(2);
});
it("does not unhide an anchor when OCR replaces its detection UUID", async () => {
  await hide(twitch);
  const clip = await one<{id:number}>(env, "SELECT id FROM matchup_anchors WHERE current_detection_id=?", twitch);
  await statement(env, "DELETE FROM detections WHERE id=?", twitch).run();
  const replacement = await detect(1, 12, "/detections/1/new_claim_12.jpg");
  expect(await one(env, "SELECT a.id,m.status,a.current_detection_id FROM matchup_anchors a JOIN matchups m ON m.id=a.matchup_id WHERE a.id=?", clip!.id)).toEqual({ id: clip!.id, status: "hidden", current_detection_id: replacement });
  expect(await rows(env, "SELECT * FROM detection_search")).toEqual([]);
  expect(await publicImageVisible(env, "1/new_claim_12.jpg")).toBe(false);
  await hide(replacement, "visible");
  expect((await rows(env, "SELECT detection_id FROM detection_search"))).toEqual([{ detection_id: replacement }]);
});
it("hides all publications at an anchor even if the current pointer refers to only one", async () => {
  // An old/imported database can retain multiple publications at one video anchor.
  await statement(env, "DROP TRIGGER chunks_no_overlap").run();
  try {
    await statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('historical',1,1,899,1)").run();
    const old = crypto.randomUUID();
    await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,storage_path)
      VALUES(?,'historical',1,'Old name','opponent',0.99,12,'/detections/1/old.jpg')`, old).run();
    await hide(old);
    expect(await rows(env,"SELECT detection_id FROM detection_search")).toEqual([]);
    expect(await publicImageVisible(env,"1/image_12.jpg")).toBe(false);
    expect(await publicImageVisible(env,"1/old.jpg")).toBe(false);
  } finally {
    await env.DB.prepare(`CREATE TRIGGER chunks_no_overlap BEFORE INSERT ON chunks WHEN EXISTS(
      SELECT 1 FROM chunks WHERE vod_id=NEW.vod_id AND start_seconds<NEW.end_seconds AND end_seconds>NEW.start_seconds)
      BEGIN SELECT RAISE(ABORT,'overlapping chunk'); END`).run();
  }
});
it("changes the cache key immediately after a moderation transaction and restores independently", async () => {
  const request = new Request(`https://${crypto.randomUUID()}.example.org/api/v1/search`);
  const load = vi.fn(async () => Response.json(await rows(env, "SELECT detection_id FROM public_matchups")));
  const hosted = { ...env, ENVIRONMENT: "validation" };
  const first = await publicCache(request, hosted, load);
  expect(first.headers.get("Cache-Control")).toBe("public,max-age=0,must-revalidate"); expect(await first.json()).toHaveLength(2);
  expect(await (await publicCache(request, hosted, load)).json()).toHaveLength(2); expect(load).toHaveBeenCalledTimes(1);
  await hide(twitch);
  expect(await (await publicCache(request, hosted, load)).json()).toHaveLength(1); expect(load).toHaveBeenCalledTimes(2);
  await hide(twitch, "visible");
  expect(await (await publicCache(request, hosted, load)).json()).toHaveLength(2); expect(load).toHaveBeenCalledTimes(3);
});
it("rolls back revision changes together with a failed moderation batch", async () => {
  const before = await publicRevision(env);
  await expect(env.DB.batch([
    statement(env,"UPDATE matchups SET status='hidden' WHERE id IN(SELECT matchup_id FROM matchup_anchors WHERE current_detection_id=?)",twitch),
    statement(env,"INSERT INTO mutation_checks(id,ok) VALUES('fail-visibility',0)"),
  ])).rejects.toThrow();
  expect(await publicRevision(env)).toBe(before);
  expect(await rows(env,"SELECT * FROM detection_search")).toHaveLength(1);
  await hide(twitch,"visible");expect(await publicRevision(env)).toBe(before);
  await hide(twitch);expect(Number(await publicRevision(env))).toBe(Number(before)+1);
});
it("keeps hidden, unreferenced historical, debug and low-confidence image objects private", async () => {
  expect(await publicImageVisible(env,"1/image_12.jpg")).toBe(true);
  await hide(twitch);expect(await publicImageVisible(env,"1/image_12.jpg")).toBe(false);
  await hide(twitch,"visible");
  await statement(env,"DELETE FROM detections WHERE id=?",twitch).run();
  expect(await publicImageVisible(env,"1/image_12.jpg")).toBe(false);
  await detect(1,13,"/detections/1/low.jpg",0.5);
  for(const key of ["1/low.jpg","1/ocr_debug_12.jpg","unknown.jpg","../unknown.jpg","/1/image_12.jpg"])
    expect(await publicImageVisible(env,key)).toBe(false);
});
it("supports stored legacy path forms and denies an object shared with any hidden anchor", async () => {
  for (const path of ["legacy.jpg","/storage/v1/object/public/detections/legacy.jpg","/detections/legacy.jpg"]) {
    await statement(env,"UPDATE detections SET storage_path=? WHERE id=?",path,twitch).run();
    expect(await publicImageVisible(env,"legacy.jpg")).toBe(true);
  }
  await statement(env,"UPDATE detections SET storage_path='/detections/legacy.jpg' WHERE id=?",youtube).run();
  await hide(youtube);expect(await publicImageVisible(env,"legacy.jpg")).toBe(false);
});
it("gates image GET/HEAD/conditional requests before serving an R2 object", async () => {
  await env.DETECTIONS.put("1/image_12.jpg",new Uint8Array([255,216,255,217]),{httpMetadata:{contentType:"image/jpeg"}});
  const call=(method="GET",etag?:string)=>worker.fetch(new Request("http://local/detections/1/image_12.jpg",{method,headers:etag?{"If-None-Match":etag}:{}}),env);
  const visible=await call();expect(visible.status).toBe(200);const etag=visible.headers.get("ETag")!;
  expect((await call("GET",etag)).status).toBe(304);
  await hide(twitch);
  for(const method of ["GET","HEAD"])expect((await call(method,etag)).status).toBe(404);
  expect(await env.DETECTIONS.head("1/image_12.jpg")).not.toBeNull();
});

it("retries transient R2 reads, caps failures, and still checks visibility before storage", async () => {
  await env.DETECTIONS.put("1/image_12.jpg", new Uint8Array([255,216,255,217]));
  const transient = new Error("get: We encountered an internal error. Please try again. (10001)");
  const get = vi.fn().mockRejectedValueOnce(transient)
    .mockImplementation(() => env.DETECTIONS.get("1/image_12.jpg"));
  const testEnv = { ...env, DETECTIONS: { get } as unknown as R2Bucket };
  const call = () => worker.fetch(new Request("http://local/detections/1/image_12.jpg"), testEnv);
  expect((await call()).status).toBe(200);
  expect(get).toHaveBeenCalledTimes(2);
  get.mockReset().mockRejectedValue(transient);
  expect((await call()).status).toBe(503);
  expect(get).toHaveBeenCalledTimes(3);
  get.mockReset().mockResolvedValue(null);
  expect((await call()).status).toBe(404);
  expect(get).toHaveBeenCalledTimes(1);
  get.mockClear();
  await hide(twitch);
  expect((await call()).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});
