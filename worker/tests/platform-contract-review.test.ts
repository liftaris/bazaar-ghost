import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nativeRoute } from '../native-api';
import { catalogRoute, saveVideo, updateAccount, upsertAccount } from '../platforms';
import { dispatch, pendingVideos, plan } from '../processing';
import { one, rows, statement } from '../http';

beforeEach(async () => {
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unexpected outbound request');}));
  await statement(env,"INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'independent-review','[0,0,1,1]')").run();
});
afterEach(()=>vi.unstubAllGlobals());

// Simulate a process losing the response to its first committed database transaction.
// An enabled account must still have durable polling work after this interruption.
function interruptedBatch() {
  return new Proxy(env.DB,{
    get(target,key) {
      if(key==='batch') return async (statements:D1PreparedStatement[])=>{
        await target.batch(statements);
        throw new Error('Lost database response after commit');
      };
      const value=Reflect.get(target,key);
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

async function catalog(enabled = true) {
  const account = await upsertAccount(env,{source:'youtube',source_id:'UC'+'a'.repeat(22),display_name:'Reviewed creator',processing_enabled:enabled});
  const video = await saveVideo(env,{account_id:account.id,video:{source:'youtube',source_id:'abcdefghijk',title:'The Bazaar recording',duration_seconds:100,bazaar_chapters:[0,100]}});
  return {account,video};
}

async function detection(vodId:number) {
  const chunk=(await one(env,'SELECT id FROM chunks WHERE vod_id=?',vodId))!;
  const id=crypto.randomUUID();
  await env.DB.batch([
    statement(env,"INSERT INTO search_names(name,gram_count) VALUES('opponent',1)"),
    statement(env,"INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds) VALUES(?,?,?,'Opponent','opponent',0.9,12)",id,chunk.id,vodId),
  ]);
  return id;
}

it('preserves the populated source_video_id contract for ordinary YouTube appearances',async()=>{
  const {video}=await catalog();
  await detection(video.id);
  expect((await one(env,'SELECT source_video_id FROM public_sources'))!.source_video_id).toBe('abcdefghijk');
});

it('restarts the search with 409 instead of mixing results when a source disappears between reads',async()=>{
  const {video}=await catalog();
  await detection(video.id);
  let changed=false;
  const database=new Proxy(env.DB,{
    get(target,key) {
      if(key==='prepare') return (sql:string)=>{
        const prepared=target.prepare(sql);
        if(!sql.includes('FROM public_matchups p')) return prepared;
        const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{
          get(stmt,method) {
            if(method==='bind') return (...args:unknown[])=>wrap(stmt.bind(...args));
            if(method==='all') return async()=>{
              const result=await stmt.all();
              if(!changed) {
                changed=true;
                await statement(env,"UPDATE vods SET availability='unavailable' WHERE id=?",video.id).run();
              }
              return result;
            };
            const property=Reflect.get(stmt,method);
            return typeof property==='function'?property.bind(stmt):property;
          },
        });
        return wrap(prepared);
      };
      const value=Reflect.get(target,key);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  await expect(nativeRoute(new Request('http://local/api/v1/search'),{...env,DB:database})).rejects.toMatchObject({status:409});
  expect(changed).toBe(true);
});

it('makes a previously disabled historical catalog eligible for the ingestion dispatch path after enablement',async()=>{
  const {account,video}=await catalog(false);
  expect(await rows(env,'SELECT id FROM chunks WHERE vod_id=?',video.id)).toEqual([]);
  await updateAccount(env,account.id,{processing_enabled:true});
  await catalogRoute(new Request('http://local/api/catalog/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_environment:env.ENVIRONMENT,dry_run:true,limit:3})}),env);
  expect(await rows(env,'SELECT start_seconds,end_seconds FROM chunks WHERE vod_id=?',video.id)).toEqual([{start_seconds:0,end_seconds:100}]);
});

it('cannot leave a new enabled account without polling after a committed transaction loses its response',async()=>{
  await expect(upsertAccount({...env,DB:interruptedBatch()},{source:'youtube',source_id:'UC'+'b'.repeat(22),display_name:'Interrupted creator',processing_enabled:true})).rejects.toThrow('Lost database response');
  const accounts=await rows(env,'SELECT * FROM platform_accounts WHERE processing_enabled=1');
  expect(accounts).toHaveLength(1);
  expect(await rows(env,"SELECT account_id,status FROM platform_ingestion_jobs WHERE kind='account'")).toEqual([{account_id:accounts[0].id,status:'pending'}]);
});

it('atomically wakes polling when re-enabling an account, even if the response is lost',async()=>{
  const {account}=await catalog(false);
  expect(await rows(env,'SELECT id FROM platform_ingestion_jobs')).toEqual([]);
  await expect(updateAccount({...env,DB:interruptedBatch()},account.id,{processing_enabled:true})).rejects.toThrow('Lost database response');
  expect((await one(env,'SELECT processing_enabled FROM platform_accounts WHERE id=?',account.id))!.processing_enabled).toBe(1);
  expect(await rows(env,"SELECT account_id,status FROM platform_ingestion_jobs WHERE kind='account'")).toEqual([{account_id:account.id,status:'pending'}]);
});

it('does not reserve or dispatch work after an account is disabled between planning and reservation',async()=>{
  const {account,video}=await catalog();
  let disabled=false;
  const database=new Proxy(env.DB,{
    get(target,key) {
      if(key==='prepare') return (sql:string)=>{
        const prepared=target.prepare(sql);
        if(!sql.includes('SELECT * FROM sfde_profiles WHERE id=?')) return prepared;
        const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{
          get(stmt,method) {
            if(method==='bind') return (...args:unknown[])=>wrap(stmt.bind(...args));
            if(method==='first') return async()=>{
              const result=await stmt.first();
              await statement(env,'UPDATE platform_accounts SET processing_enabled=0 WHERE id=?',account.id).run();
              disabled=true;
              return result;
            };
            const property=Reflect.get(stmt,method);
            return typeof property==='function'?property.bind(stmt):property;
          },
        });
        return wrap(prepared);
      };
      const value=Reflect.get(target,key);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  const result=(await dispatch({...env,DB:database,ENVIRONMENT:'validation',OUTBOUND_ENABLED:'true',GITHUB_TOKEN:'test-only'},video.id)).chunkIds;
  expect(disabled).toBe(true);
  expect(result).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(await rows(env,'SELECT status FROM chunks WHERE vod_id=?',video.id)).toEqual([{status:'pending'}]);
});

it('does not let newer recordings with only future work crowd ready recordings out of the bounded scheduler',async()=>{
  const {account,video:due}=await catalog();
  await statement(env,"UPDATE vods SET published_at='2020-01-01T00:00:00Z' WHERE id=?",due.id).run();
  for(const id of ['12345678901','12345678902','12345678903']) {
    const future=await saveVideo(env,{account_id:account.id,video:{source:'youtube',source_id:id,title:'The Bazaar scheduled',duration_seconds:100,bazaar_chapters:[0,100],published_at:'2026-09-01T00:00:00Z'}});
    await statement(env,'UPDATE chunks SET scheduled_for=? WHERE vod_id=?',new Date(Date.now()+86400_000).toISOString(),future.id).run();
  }
  expect(await pendingVideos(env,3,true)).toEqual([{id:due.id}]);
});

it('honors processing priority across sources before publication date',async()=>{
  const {video}=await catalog();
  await statement(env,"UPDATE vods SET published_at='2026-09-01T00:00:00Z' WHERE id=?",video.id).run();
  await statement(env,"INSERT INTO streamers(id,login) VALUES(1,'reviewed-streamer')").run();
  const twitch=(await one(env,"INSERT INTO vods(streamer_id,source_id,title,duration_seconds,published_at,bazaar_chapters,ready_for_processing) VALUES(1,'123','Earlier Twitch footage',100,'2020-01-01T00:00:00Z','[0,100]',1) RETURNING id"))!;
  await plan(env,twitch.id);
  expect(await pendingVideos(env,1)).toEqual([{id:twitch.id}]);
  await statement(env,'UPDATE chunks SET priority=100 WHERE vod_id=?',video.id).run();
  expect(await pendingVideos(env,1)).toEqual([{id:video.id}]);
});
