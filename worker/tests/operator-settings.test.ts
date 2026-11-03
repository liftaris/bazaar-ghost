import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogRoute, saveVideo, updateAccount, updateVideoProfile, upsertAccount } from '../platforms';
import { dispatch, manualRun, vodDetails } from '../processing';
import { one, rows, statement } from '../http';

const channel='UC'+'a'.repeat(22), sourceId='abcdefghijk';
let account:Record<string,any>,video:Record<string,any>;
const recording=()=>({source:'youtube',source_id:sourceId,title:'The Bazaar reviewed recording',duration_seconds:100,bazaar_chapters:[0,100]});
const profile=(value:number|null)=>({account_id:account.id,sfde_profile_id:value});

beforeEach(async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unexpected network');}));
  for(const id of [1,2,3]) await statement(env,'INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(?,?,?)',id,`profile-${id}`,'[0,0,1,1]').run();
  await statement(env,"INSERT INTO streamers(id,login,sfde_profile_id) VALUES(1,'original-creator',3)").run();
  account=await upsertAccount(env,{source:'youtube',source_id:channel,display_name:'Verified uploader',processing_enabled:true,sfde_profile_id:2,streamer_id:1});
  video=await saveVideo(env,{account_id:account.id,video:recording()});
});
afterEach(()=>vi.unstubAllGlobals());

function afterDatabaseRead(fragment:string,action:()=>Promise<unknown>) {
  return new Proxy(env.DB,{
    get(target,key) {
      if(key==='prepare') return (sql:string)=>{
        const prepared=target.prepare(sql);
        if(!sql.includes(fragment)) return prepared;
        const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{
          get(stmt,method) {
            if(method==='bind') return (...args:unknown[])=>wrap(stmt.bind(...args));
            if(method==='first') return async()=>{
              const result=await stmt.first();
              await action();
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
}

it('clears a manual account link and its existing recording links without changing the Twitch catalog',async()=>{
  await statement(env,"INSERT INTO vods(streamer_id,source_id,duration_seconds) VALUES(1,'123',100)").run();
  const response=await catalogRoute(new Request(`https://local/api/catalog/accounts/${account.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({streamer_id:null})}),env);
  expect((await response.json() as Record<string,any>).streamer_id).toBeNull();
  expect((await one(env,'SELECT streamer_id FROM vods WHERE id=?',video.id))!.streamer_id).toBeNull();
  expect((await one(env,"SELECT streamer_id FROM vods WHERE source='twitch'"))!.streamer_id).toBe(1);
  expect((await vodDetails(env,sourceId,'youtube')).profile.id).toBe(2);
});

it('distinguishes omitted and explicitly cleared links in account upserts',async()=>{
  const input={source:'youtube',source_id:channel,display_name:'Still verified'};
  expect((await upsertAccount(env,input)).streamer_id).toBe(1);
  expect((await upsertAccount(env,{...input,streamer_id:null})).streamer_id).toBeNull();
  expect((await one(env,'SELECT streamer_id FROM vods WHERE id=?',video.id))!.streamer_id).toBeNull();
  expect((await upsertAccount(env,{...input,streamer_id:1})).streamer_id).toBe(1);
  expect((await one(env,'SELECT streamer_id FROM vods WHERE id=?',video.id))!.streamer_id).toBeNull();
});

it('sets and clears a per-video override while preserving account profile precedence',async()=>{
  const response=await catalogRoute(new Request(`https://local/api/catalog/videos/${video.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(profile(3))}),env);
  expect((await response.json() as Record<string,any>).sfde_profile_id).toBe(3);
  expect((await vodDetails(env,sourceId,'youtube')).profile.id).toBe(3);
  await saveVideo(env,{account_id:account.id,video:recording()});
  expect((await vodDetails(env,sourceId,'youtube')).profile.id).toBe(3);
  await updateVideoProfile(env,video.id,profile(null));
  expect((await vodDetails(env,sourceId,'youtube')).profile.id).toBe(2);
  expect((await one(env,'SELECT sfde_profile_id FROM platform_accounts WHERE id=?',account.id))!.sfde_profile_id).toBe(2);
});

it('rejects wrong owners and unknown profiles without changing the recording',async()=>{
  const other=await upsertAccount(env,{source:'bilibili',source_id:'12345',display_name:'Other uploader'});
  await expect(updateVideoProfile(env,video.id,{account_id:other.id,sfde_profile_id:3})).rejects.toMatchObject({status:409});
  await expect(updateVideoProfile(env,video.id,profile(999))).rejects.toMatchObject({status:409});
  expect((await one(env,'SELECT sfde_profile_id FROM vods WHERE id=?',video.id))!.sfde_profile_id).toBeNull();
});

it('rejects automatic set/clear requests and preserves manual overrides during ordinary recataloging',async()=>{
  const id=crypto.randomUUID(),token=crypto.randomUUID();
  await statement(env,"INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,account_id,status,lease_token,lease_expires_at) VALUES(?,'youtube','video',?,?,'processing',?,?)",id,sourceId,account.id,token,new Date(Date.now()+600_000).toISOString()).run();
  const fence={job_id:id,lease_token:token};
  for(const value of [3,null]) {
    await expect(updateVideoProfile(env,video.id,{...profile(value),...fence})).rejects.toMatchObject({status:400});
    await expect(saveVideo(env,{account_id:account.id,video:{...recording(),sfde_profile_id:value},...fence})).rejects.toMatchObject({status:400});
    await expect(upsertAccount(env,{source:'youtube',source_id:channel,display_name:'Automatic',sfde_profile_id:value,...fence})).rejects.toMatchObject({status:400});
  }
  await expect(upsertAccount(env,{source:'youtube',source_id:channel,display_name:'Automatic',streamer_id:null,...fence})).rejects.toMatchObject({status:400});
  const job=(await one(env,"SELECT id FROM platform_ingestion_jobs WHERE kind='account'"))!;
  await statement(env,"UPDATE platform_ingestion_jobs SET status='processing',lease_token=?,lease_expires_at=? WHERE id=?",token,new Date(Date.now()+600_000).toISOString(),job.id).run();
  await expect(updateAccount(env,account.id,{catalog_cursor:2,streamer_id:null,job_id:job.id,lease_token:token})).rejects.toMatchObject({status:400});
  await updateVideoProfile(env,video.id,profile(3));
  await saveVideo(env,{account_id:account.id,video:recording(),...fence});
  expect((await vodDetails(env,sourceId,'youtube')).profile.id).toBe(3);
});

it('allows effective-profile no-ops while queued, but rejects changes from account patch/upsert or video settings',async()=>{
  await updateVideoProfile(env,video.id,profile(2));
  await statement(env,"UPDATE chunks SET status='queued' WHERE vod_id=?",video.id).run();
  await updateVideoProfile(env,video.id,profile(null)); // Still account profile 2.
  await updateAccount(env,account.id,{sfde_profile_id:2});
  await expect(updateVideoProfile(env,video.id,profile(3))).rejects.toMatchObject({status:409});
  await expect(updateAccount(env,account.id,{sfde_profile_id:3,display_name:'Must roll back'})).rejects.toMatchObject({status:409});
  await expect(upsertAccount(env,{source:'youtube',source_id:channel,display_name:'Must roll back',sfde_profile_id:3})).rejects.toMatchObject({status:409});
  expect((await one(env,'SELECT display_name FROM platform_accounts WHERE id=?',account.id))!.display_name).toBe('Verified uploader');
});

it('allows changing an account profile when active work has an independent video override',async()=>{
  await updateVideoProfile(env,video.id,profile(3));
  await statement(env,"UPDATE chunks SET status='processing' WHERE vod_id=?",video.id).run();
  await updateAccount(env,account.id,{sfde_profile_id:1,streamer_id:null});
  expect((await vodDetails(env,sourceId,'youtube')).profile.id).toBe(3);
  await expect(updateVideoProfile(env,video.id,profile(null))).rejects.toMatchObject({status:409});
});

it('does not queue a stale profile when the account changes after dispatch loads its profile',async()=>{
  let changed=false;
  const database=afterDatabaseRead('SELECT * FROM sfde_profiles WHERE id=?',async()=>{
    await updateAccount(env,account.id,{sfde_profile_id:3});
    changed=true;
  });
  expect(await dispatch({...env,DB:database,ENVIRONMENT:'validation',OUTBOUND_ENABLED:'true',GITHUB_TOKEN:'test-only'},video.id, manualRun(env))).toEqual([]);
  expect(changed).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(await rows(env,'SELECT status FROM chunks WHERE vod_id=?',video.id)).toEqual([{status:'pending'}]);
});

it('does not restore a cleared creator link when cataloging resumes from an older account read',async()=>{
  let changed=false;
  const database=afterDatabaseRead('SELECT * FROM platform_accounts WHERE id=? AND source=?',async()=>{
    await updateAccount(env,account.id,{streamer_id:null});
    changed=true;
  });
  const saved=await saveVideo({...env,DB:database},{account_id:account.id,video:{...recording(),source_id:'12345678901'}});
  expect(changed).toBe(true);
  expect(saved.streamer_id).toBeNull();
  expect(await rows(env,'SELECT streamer_id FROM vods WHERE platform_account_id=?',account.id)).toEqual([{streamer_id:null},{streamer_id:null}]);
});
