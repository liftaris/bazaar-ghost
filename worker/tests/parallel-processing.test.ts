import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claim, dispatchAutomatic, pendingVideos, plan, updateChunk } from '../processing';
import { statement, one } from '../http';
import { Twitch } from '../twitch';
import { enqueueCatalog, handleJob } from '../jobs';

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'parallel','[0,0,1,1]')").run();
  await statement(env, "INSERT INTO streamers(id,login) VALUES(1,'parallel')").run();
  await statement(env, "INSERT INTO processing_config(key,value) VALUES('automatic_vods_since','2026-10-16T00:00:00.000Z')").run();
  for (const [id, date] of [[1,'2026-10-15T23:59:59Z'],[2,'2026-10-16T00:00:00+00:00'],[3,null]]) {
    await statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,published_at,bazaar_chapters,ready_for_processing) VALUES(?,1,?,60,?,'[0,60]',1)",id,String(id),date).run();
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('selects only forward ingestion and fences queued historical messages while accepting equivalent UTC timestamps', async () => {
  expect(await pendingVideos(env)).toEqual([{ id: 2 }]);
  const hosted = { ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' };
  expect((await dispatchAutomatic(hosted, 1)).chunkIds).toEqual([]);
  expect((await dispatchAutomatic(hosted, 3)).chunkIds).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect((await dispatchAutomatic(hosted, 2)).chunkIds).toHaveLength(1);
  const payload = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  expect(payload.ref).toBe('migration/cloudflare');
  expect(payload.inputs.environment).toBe('validation');
  expect(payload.inputs.vod_id).toBe('2');
  expect(payload.inputs.sfde_next).toBe('true');
  expect(payload.inputs.sfde_profile).toBeUndefined();
});

it('dispatches automatic validation NEXT without interpreting legacy crop settings', async () => {
  await statement(env, "UPDATE sfde_profiles SET crop_region='[0,0,0,0]' WHERE id=1").run();
  const hosted = { ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' };
  const ids = (await dispatchAutomatic(hosted, 2)).chunkIds;
  expect(ids).toHaveLength(1);
  const payload = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  expect(payload.inputs).toMatchObject({sfde_next:'true', old_templates:'false', chunk_uuids:JSON.stringify(ids)});
  expect(payload.inputs.sfde_profile).toBeUndefined();
  expect(await one(env,'SELECT status,queued_at FROM chunks WHERE id=?',ids[0]))
    .toEqual({status:'queued',queued_at:payload.inputs.queued_at});
});

it('pins workflow code and image to the tested deployment even if the branch advances', async () => {
  const runtime = 'ghcr.io/liftaris/bazaar-ghost/sfde-next@sha256:' + 'a'.repeat(64);
  const revision = 'b'.repeat(40);
  await dispatchAutomatic({ ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only',
    SFDE_RUNTIME_IMAGE: runtime, BUILD_COMMIT: revision }, 2);
  const payload = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(payload.inputs).toMatchObject({runtime_image: runtime, processor_revision: revision});
});

it('dispatches an entire recording despite unrelated queued and processing chunks', async () => {
  await statement(env, "UPDATE vods SET duration_seconds=18000,bazaar_chapters='[0,18000]' WHERE id=2").run();
  await plan(env, 1);
  await plan(env, 3);
  await statement(env, "UPDATE chunks SET status='queued' WHERE vod_id=1").run();
  await statement(env, "UPDATE chunks SET status='processing' WHERE vod_id=3").run();
  const hosted = { ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' };
  const first = (await dispatchAutomatic(hosted, 2)).chunkIds;
  expect(first).toHaveLength(10);
  expect((await dispatchAutomatic(hosted, 2)).chunkIds).toEqual([]);
  expect(await one(env,"SELECT count(*) AS n FROM chunks WHERE status='pending'")).toEqual({n:0});
  expect(fetch).toHaveBeenCalledOnce();
});

it('splits a large recording into workflow matrices without dropping or repeating chunks', async () => {
  const duration = 257 * 1800;
  await statement(env, 'UPDATE vods SET duration_seconds=?,bazaar_chapters=? WHERE id=2', duration, JSON.stringify([0, duration])).run();
  const hosted = { ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' };
  const ids = (await dispatchAutomatic(hosted, 2)).chunkIds;
  const batches = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(JSON.parse(String(init!.body)).inputs.chunk_uuids));
  expect(batches.map(batch => batch.length)).toEqual([256, 1]);
  expect(batches.flat()).toEqual(ids);
  expect(new Set(ids).size).toBe(257);
  expect((await dispatchAutomatic(hosted, 2)).chunkIds).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('respects an operator pause before dispatching pending recordings', async () => {
  const hosted = { ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' };
  await statement(env,"UPDATE vods SET published_at='2026-10-17T00:00:00Z' WHERE id=3").run();
  const [id] = (await dispatchAutomatic(hosted, 2)).chunkIds;
  const token = (await claim(env, id)).claim_token!;
  await updateChunk(env, id, token, {status:'completed'});
  await statement(env,"INSERT INTO processing_config(key,value) VALUES('automatic_vods','[]')").run();
  expect((await dispatchAutomatic(hosted, 3)).chunkIds).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
  await statement(env,"DELETE FROM processing_config WHERE key='automatic_vods'").run();
  expect((await dispatchAutomatic(hosted, 3)).chunkIds).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  const payload = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
  expect(payload.inputs.vod_id).toBe('3');
});

it('completes chunks without scheduling more work and drains obsolete refill messages', async () => {
  const [chunk] = await plan(env, 2);
  const token = (await claim(env, chunk.id)).claim_token!;
  const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
  const hosted = { ...env, ENVIRONMENT:'validation', OUTBOUND_ENABLED:'true', JOBS:{send} as unknown as Queue };
  await expect(updateChunk(hosted, chunk.id, token, {status:'completed'})).resolves.toEqual({updated:true});
  expect(await one(env,'SELECT status FROM chunks WHERE id=?',chunk.id)).toEqual({status:'completed'});
  await expect(updateChunk(hosted, chunk.id, token, {status:'completed'})).rejects.toMatchObject({status:409});
  await handleJob(hosted, {type:'refill-processing', id:2});
  expect(send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([['dev','dev'],['production','main']])('keeps automatic %s dispatch on the legacy contract', async (environment, branch) => {
  await dispatchAutomatic({ ...env, ENVIRONMENT: environment, OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' }, 2);
  const payload = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  expect(payload.ref).toBe(branch);
  expect(payload.inputs.sfde_next).toBeUndefined();
  expect(JSON.parse(payload.inputs.sfde_profile).id).toBe(1);
});

it('fails closed on an invalid boundary and intersects it with an explicit allowlist', async () => {
  await statement(env, "INSERT INTO processing_config(key,value) VALUES('automatic_vods','[\"twitch:1\"]')").run();
  expect(await pendingVideos(env)).toEqual([]);
  await statement(env, "DELETE FROM processing_config WHERE key='automatic_vods'").run();
  await statement(env, "UPDATE processing_config SET value='invalid'").run();
  expect(await pendingVideos(env)).toEqual([]);
});

it('rechecks the start boundary inside dispatch reservations', async () => {
  await plan(env,2);
  const db = new Proxy(env.DB, { get(target, key) {
    if(key==='prepare') return (sql: string) => {
      const original=target.prepare(sql);
      if(!sql.includes('SELECT * FROM sfde_profiles WHERE id=?')) return original;
      const wrap=(stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt,{get(s,method){
        if(method==='bind')return (...args: unknown[])=>wrap(s.bind(...args));
        if(method==='first')return async()=>{const result=await s.first();await statement(env,"UPDATE processing_config SET value='2026-10-17T00:00:00Z' WHERE key='automatic_vods_since'").run();return result;};
        const value=Reflect.get(s,method);return typeof value==='function'?value.bind(s):value;
      }});
      return wrap(original);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  expect((await dispatchAutomatic({...env,DB:db,ENVIRONMENT:'validation',OUTBOUND_ENABLED:'true',GITHUB_TOKEN:'test-only'},2)).chunkIds).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect((await one(env,'SELECT status FROM chunks WHERE vod_id=2'))!.status).toBe('pending');
});

it('stops historical archive traversal before expensive chapter reads', async () => {
  const send=vi.fn().mockResolvedValue(undefined);
  const twitch=new Twitch({...env,JOBS:{send} as unknown as Queue});
  vi.spyOn(twitch,'ensureSubscription').mockResolvedValue(undefined);
  vi.spyOn(twitch,'helix').mockImplementation(async endpoint=>{
    if(endpoint==='users')return {data:[{id:'1',login:'parallel'}]};
    if(endpoint==='streams')return {data:[]};
    if(endpoint==='search/categories')return {data:[{id:'bazaar',name:'The Bazaar'}]};
    return {data:[{id:'4',created_at:'2026-10-16T01:00:00Z'},{id:'5',created_at:'2026-10-15T23:59:59Z'}],pagination:{cursor:'old-history'}};
  });
  const gql=vi.spyOn(twitch,'gql').mockResolvedValue({video:{id:'4',title:'New VOD',publishedAt:'2026-10-16T01:00:00Z',lengthSeconds:60,game:{id:'bazaar'},moments:{edges:[]}}});
  await twitch.catalog(1);
  expect(gql).toHaveBeenCalledTimes(1);
  expect(gql.mock.calls[0][1]).toEqual({id:'4'});
  expect(send.mock.calls.map(([job])=>job.type)).toEqual(['plan']);
  expect(await one(env,"SELECT id FROM vods WHERE source_id='5'")).toBeNull();
});

it('spreads hourly fallback reconciliation across the hour', async () => {
  const send=vi.fn().mockResolvedValue(undefined);
  const before=Date.now();
  await enqueueCatalog({...env,JOBS:{send} as unknown as Queue});
  expect(send).not.toHaveBeenCalled();
  expect((await one(env, 'SELECT due_at FROM twitch_catalog_work WHERE streamer_id=1'))!.due_at).toBeGreaterThanOrEqual(before+1000);
});

it('acknowledges a deleted Twitch account without retrying its catalog indefinitely', async () => {
  const twitch=new Twitch(env);
  vi.spyOn(twitch,'helix').mockResolvedValue({data:[]});
  expect(await twitch.catalog(1)).toEqual({streamerId:1,unavailable:true});
  expect((await one(env,'SELECT processing_enabled FROM streamers WHERE id=1'))!.processing_enabled).toBe(1);
});
