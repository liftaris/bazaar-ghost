import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatchAutomatic, pendingVideos, plan } from '../processing';
import { statement, one } from '../http';
import { Twitch } from '../twitch';
import { enqueueCatalog } from '../jobs';

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
  expect(await dispatchAutomatic(hosted, 1)).toEqual([]);
  expect(await dispatchAutomatic(hosted, 3)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(await dispatchAutomatic(hosted, 2)).toHaveLength(1);
  const payload = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  expect(payload.ref).toBe('migration/cloudflare');
  expect(payload.inputs.environment).toBe('validation');
  expect(payload.inputs.vod_id).toBe('2');
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
      if(!sql.includes("key='max_concurrent_chunks'")) return original;
      const wrap=(stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt,{get(s,method){
        if(method==='bind')return (...args: unknown[])=>wrap(s.bind(...args));
        if(method==='first')return async()=>{const result=await s.first();await statement(env,"UPDATE processing_config SET value='2026-10-17T00:00:00Z' WHERE key='automatic_vods_since'").run();return result;};
        const value=Reflect.get(s,method);return typeof value==='function'?value.bind(s):value;
      }});
      return wrap(original);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  expect(await dispatchAutomatic({...env,DB:db,ENVIRONMENT:'validation',OUTBOUND_ENABLED:'true',GITHUB_TOKEN:'test-only'},2)).toEqual([]);
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
  await enqueueCatalog({...env,JOBS:{send} as unknown as Queue});
  expect(send).toHaveBeenCalledWith({type:'catalog',id:1},{delaySeconds:1});
});

it('acknowledges a deleted Twitch account without retrying its catalog indefinitely', async () => {
  const twitch=new Twitch(env);
  vi.spyOn(twitch,'helix').mockResolvedValue({data:[]});
  expect(await twitch.catalog(1)).toEqual({streamerId:1,unavailable:true});
  expect((await one(env,'SELECT processing_enabled FROM streamers WHERE id=1'))!.processing_enabled).toBe(1);
});
