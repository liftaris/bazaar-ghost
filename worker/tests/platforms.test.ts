import { env, SELF } from 'cloudflare:test';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { upsertAccount,saveVideo,enqueueJob,claimJob,finishJob } from '../platforms';
import { one,rows,statement } from '../http';
import { plan,claim,owned,dispatch,manualRun } from '../processing';
import { linkDetections,unlinkDetection } from './link-fixture';
import { publish,upload } from '../detections';
import { dispatchBranch } from '../platform-ingestion-dispatch';

beforeEach(async()=>{
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unexpected external request');}));
 await statement(env,"INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'platform-test','[0,0,1,1]')").run();
});
afterEach(()=>vi.unstubAllGlobals());
async function account(platform='youtube') { return upsertAccount(env,{source:platform,source_id:platform==='youtube'?'UCabcdefghijklmnopqrstuv':'12345',display_name:'Creator',processing_enabled:true}); }
function video(source='youtube',id='abcdefghijk') {return {source,source_id:id,title:'The Bazaar fixture',duration_seconds:3661,published_at:'2026-09-07T10:00:00Z',recorded_at:null,template_version:'auto',content_kind:'upload',bazaar_chapters:[0,3661]};}
async function catalog(source='youtube') { const a=await account(source);const v=video(source,source==='youtube'?'abcdefghijk':'BV1234567890:123'); return saveVideo(env,{account_id:a.id,video:{...v,...(source==='bilibili'?{source_video_id:'BV1234567890',source_part_id:'123',source_part_index:2}:{})}}); }
async function detect(vodId:number,name='Opponent') {
 const chunks=await plan(env,vodId),chunk=chunks[0],lease=await claim(env,chunk.id),token=lease.claim_token!;
 const id=crypto.randomUUID();
 const img=await upload(env,new Request('http://local',{method:'PUT',headers:{'X-Claim-Token':token,'Content-Type':'image/jpeg'},body:new Uint8Array([255,216,255,217])}),chunk.id,12,'detection');
 await publish(env,chunk.id,token,[{id,username:name,confidence:0.95,rank:'gold',frame_time_seconds:12,storage_path:img.storage_path,igd:9}]);
 return {id,path:img.storage_path};
}
it('creates independent YouTube and Bilibili timelines and claims both through normalized profiles',async()=>{
 const yt=await catalog(),bi=await catalog('bilibili');
 for(const v of [yt,bi]) {
  const chunks=await plan(env,v.id);
  expect(chunks.map(c=>[c.start_seconds,c.end_seconds])).toEqual([[0,1800],[1800,3600],[3600,3661]]);
  expect(chunks.every(c=>c.priority===-10)).toBe(true);
  const lease=await claim(env,chunks[0].id);expect(lease.claimed).toBe(true);
  expect((await owned(env,chunks[0].id,lease.claim_token)).source).toBe(v.source);
  const response=await SELF.fetch(`http://local/api/processor/vod?source=${v.source}&source_id=${v.source_id}`,{headers:{Authorization:`Bearer ${env.PROCESSOR_KEY}`}});
  const result=await response.json() as any;expect(result.profile.crop_region).toEqual([0,0,1,1]);expect(result.old_templates).toBe(false);
 }
});
it('keeps the Twitch player contract free of non-Twitch identities and exposes platform links separately',async()=>{
 const v=await catalog('bilibili'),d=await detect(v.id);
 expect(d.path).toContain('/detections/bilibili/BV1234567890:123/');
 const publicRow=(await one(env,'SELECT * FROM public_sources'))!;
 expect(publicRow.source_part_id).toBe('123');const source=((await(await SELF.fetch('http://local/api/v1/search')).json()) as any).items[0].sources[0];expect(source.watchUrl).toContain('?p=2&t=12');expect(source.embedUrl).toContain('cid=123');expect(publicRow.recorded_timestamp).toBeNull();expect(publicRow.igd).toBe(9);
 expect(await rows(env,'SELECT * FROM notification_outbox_v2')).toEqual([]);
 const image=await SELF.fetch(`http://local${d.path}`);expect(image.status).toBe(200);
});
it('rejects metadata timeline rewrites once chunks exist while allowing part position refresh',async()=>{
 const v=await catalog('bilibili');
 const current={...video('bilibili','BV1234567890:123'),source_video_id:'BV1234567890',source_part_id:'123',source_part_index:3};
 await expect(saveVideo(env,{account_id:v.platform_account_id,video:{...current,duration_seconds:4000}})).rejects.toMatchObject({status:409});
 await expect(saveVideo(env,{account_id:v.platform_account_id,explicit_ranges:true,video:{...current,bazaar_chapters:[0,3000]}})).rejects.toMatchObject({status:409});
 const saved=await saveVideo(env,{account_id:v.platform_account_id,video:current});expect(saved.id).toBe(v.id);expect(saved.source_part_index).toBe(3);
 expect((await rows(env,'SELECT * FROM chunks WHERE vod_id=?',v.id)).length).toBe(3);
});
it('preserves disables during discovered account upsert',async()=>{
 const a=await account();
 await statement(env,'UPDATE platform_accounts SET processing_enabled=0 WHERE id=?',a.id).run();
 const result=await upsertAccount(env,{source:'youtube',source_id:a.source_id,display_name:'Renamed',processing_enabled:true,preserve_disabled:true});
 expect(result.id).toBe(a.id);expect(result.processing_enabled).toBe(false);
 const v=await saveVideo(env,{account_id:a.id,video:video()});expect(await plan(env,v.id)).toEqual([]);
});
it('atomically claims ingestion once, fences stale results and preserves notifications arriving during work',async()=>{
 const id=await enqueueJob(env,{source:'youtube',kind:'video',source_id:'abcdefghijk'});
 const [a,b]=await Promise.all([claimJob(env,{}),claimJob(env,{})]);expect(a.length+b.length).toBe(1);
 const job=(a[0]||b[0]);
 await enqueueJob(env,{source:'youtube',kind:'video',source_id:'abcdefghijk',wake:true});
 expect(await finishJob(env,{id,token:job.lease_token,status:'completed'})).toBe(true);
 expect((await one(env,'SELECT status FROM platform_ingestion_jobs WHERE id=?',id))!.status).toBe('pending');
 const next=(await claimJob(env,{}))[0];expect(next.lease_token).not.toBe(job.lease_token);
 expect(await finishJob(env,{id,token:job.lease_token,status:'completed'})).toBe(false);
 await expect(enqueueJob(env,{source:'youtube',kind:'video',source_id:'12345678901',job_id:id,lease_token:job.lease_token})).rejects.toMatchObject({status:409});
 expect(await rows(env,'SELECT * FROM mutation_checks')).toEqual([]);
});
it('requires catalog credentials and never exposes private platform job/subscription tables',async()=>{
 for(const path of ['/api/catalog/jobs/claim','/api/catalog/accounts/upsert']) {
  const r=await SELF.fetch('http://local'+path,{method:'POST',headers:{Authorization:`Bearer ${env.PROCESSOR_KEY}`,'Content-Type':'application/json'},body:'{}'});expect(r.status).toBe(401);
 }
 for(const table of ['platform_ingestion_jobs','youtube_websub_subscriptions','youtube_websub_deliveries','matchup_overrides'])expect((await SELF.fetch(`http://local/rest/v1/${table}`)).status).toBe(401);
});
it('groups reviewed appearances before pagination and retains every surviving platform copy',async()=>{
 const search=async(q='')=>(await(await SELF.fetch('http://local/api/v1/search'+q)).json() as any).items;
 const a=await catalog(),b=await catalog('bilibili'),da=await detect(a.id),db=await detect(b.id);
 const group=await linkDetections(env,[da.id,db.id],'Reviewed identical opponent frame and surrounding game sequence');
 const result=await search('?platform=youtube&limit=1');
 expect(result.length).toBe(1);expect(result[0].sources.length).toBe(2);expect(String(result[0].id)).toBe(group.matchup_id);
 await statement(env,"UPDATE vods SET availability='unavailable' WHERE id=?",a.id).run();
 const remaining=await search();expect(remaining.length).toBe(1);expect(remaining[0].sources.map((s:any)=>[s.platform,s.available])).toEqual([['bilibili',true],['youtube',false]]);
 await unlinkDetection(env,db.id,'Reversing reviewed test linkage for audit');
 expect((await rows(env,"SELECT action FROM matchup_overrides WHERE revoked_at IS NULL")).map(r=>r.action)).toEqual(['unlink']);
 expect((await rows(env,"SELECT 1 FROM matchup_overrides WHERE action='link' AND revoked_at IS NOT NULL")).length).toBe(1);
 expect((await search()).map((r:any)=>r.sources.length)).toEqual([1]);
});
it('dispatches validation jobs only from the validation branch and rejects unrecognized environments',async()=>{
 expect(dispatchBranch('validation')).toBe('migration/cloudflare');expect(()=>dispatchBranch('test')).toThrow();
 const v=await catalog();
 const fetchMock=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(null,{status:204}));vi.stubGlobal('fetch',fetchMock);
 await dispatch({...env,ENVIRONMENT:'validation',OUTBOUND_ENABLED:'true',GITHUB_TOKEN:'test'},v.id, manualRun(env));
 const payload=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
 expect(payload.ref).toBe('migration/cloudflare');expect(payload.inputs.source).toBe('youtube');expect(payload.inputs.environment).toBe('validation');
});
