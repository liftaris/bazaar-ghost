import { atomic } from './atomic';
import { body, decodeRow, HttpError, integer, now, one, requireValue, rows, statement, uuid } from './http';
import { accountIdentity, ingestionPlatforms, listPlatforms, platform as platformEntry, requireIngestion, submissionIdentity, videoIdentity } from './platform-registry';
import { dispatch, normalizeRanges, pendingVideos, plan, recover } from './processing';
import { linkStatements, unlinkStatement } from './streamers';
import { renewSubscription } from './youtube-websub';
import { CLAIMABLE_INGESTION, finishIngestionRunner, runnerOwnership, startIngestionRunner } from './platform-ingestion-dispatch';

type Input = Record<string, any>;
export function jobChecks(data: Input, scope = "", scopeArgs: unknown[] = []) {
  if (data.job_id == null && data.lease_token == null) return [];
  uuid(data.job_id); uuid(data.lease_token);
  return [{sql: `SELECT EXISTS(SELECT 1 FROM platform_ingestion_jobs j WHERE j.id=? AND j.lease_token=? AND j.status='processing' AND j.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ${scope})`, args: [data.job_id,data.lease_token,...scopeArgs]}];
}
function text(value: unknown, label: string, max = 200) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
  return value.trim();
}
function date(value: unknown) {
  if (value == null) return null;
  requireValue(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'Expected timestamp with timezone');
  return new Date(value).toISOString();
}
function decoded(value: Input): Input {
  return { ...decodeRow(value), ...(typeof value.state === 'string' ? {state: JSON.parse(value.state)} : {}) };
}
function channelProfile(input: Input) {
  const fields: {avatar_url?: string | null; login?: string | null} = {};
  if (Object.hasOwn(input, 'avatar_url')) {
    if (input.avatar_url === null) fields.avatar_url = null;
    else {
      const value = text(input.avatar_url, 'avatar_url', 2000);
      requireValue(URL.canParse(value), 'Invalid avatar_url');
      const url = new URL(value);
      requireValue(url.protocol === 'https:' && !url.username && !url.password, 'Invalid avatar_url');
      fields.avatar_url = value;
    }
  }
  if (Object.hasOwn(input, 'login')) fields.login = input.login === null ? null : text(input.login, 'login');
  return fields;
}
function accountSettingChecks(id:string,input:Input) {
  const checks:Array<{sql:string;args:unknown[]}>=[];
  if(input.sfde_profile_id!=null) checks.push(
    {sql:'SELECT EXISTS(SELECT 1 FROM sfde_profiles WHERE id=?)',args:[input.sfde_profile_id]},
    {sql:`SELECT NOT EXISTS(SELECT 1 FROM vod_processing_context v JOIN chunks c ON c.vod_id=v.id
      WHERE v.platform_account_id=? AND v.sfde_profile_id IS NULL AND v.effective_profile_id<>?
      AND c.status IN('queued','processing'))`,args:[id,input.sfde_profile_id]},
  );
  return checks;
}
// Back-compat `streamer_id`: an operator ownership change, never a write to the deprecated column.
function accountLink(env:Env,id:string,input:Input) {
  if(!Object.hasOwn(input,'streamer_id')) return {checks:[],mutations:[]};
  if(input.streamer_id===null) return {checks:[],mutations:[unlinkStatement(env,id,'admin','operator unlink')]};
  return linkStatements(env,input.streamer_id,id,{method:'operator',actor:'admin'});
}
async function withOwner(env:Env,account:Input) {
  const owner=await one(env,'SELECT streamer_id FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL',account.id);
  return {...account,streamer_id:owner?.streamer_id??null};
}
export async function accounts(env: Env, params: URLSearchParams) {
  const found = params.has('id') ? await rows(env, 'SELECT * FROM platform_accounts WHERE id=?', uuid(params.get('id'))) : await (async()=>{
    const platform = requireIngestion(params.get('source'),'Twitch uses the streamer catalog').id;
    return rows(env, 'SELECT * FROM platform_accounts WHERE source=? AND source_id=?',platform,accountIdentity(platform,params.get('source_id')));
  })();
  return Promise.all(found.map(async row=>decoded(await withOwner(env,row))));
}
export async function upsertAccount(env: Env, input: Input) {
  const platform=requireIngestion(input.source,'Twitch uses the streamer catalog').id;
  const identity=accountIdentity(platform,input.source_id), name=text(input.display_name,'display name');
  const profile=channelProfile(input);
  requireValue(input.processing_enabled == null || typeof input.processing_enabled === 'boolean','Invalid enablement');
  requireValue(input.preserve_disabled == null || typeof input.preserve_disabled === 'boolean','Invalid preserve_disabled');
  if(input.sfde_profile_id != null) integer(input.sfde_profile_id,'profile ID',1);
  if(input.streamer_id != null) integer(input.streamer_id,'streamer ID',1);
  const automatic = input.job_id != null || input.lease_token != null;
  requireValue(!automatic || (!Object.hasOwn(input,'sfde_profile_id') && !Object.hasOwn(input,'streamer_id')), 'Automatic catalog cannot change operator profile/link settings');
  const previous=await one(env,'SELECT * FROM platform_accounts WHERE source=? AND source_id=?',platform,identity);
  const accountId=previous?.id??crypto.randomUUID();
  const checks=jobChecks(input, `AND j.source=? AND j.kind='video' AND (j.account_id IS NULL OR EXISTS(
    SELECT 1 FROM platform_accounts a WHERE a.id=j.account_id AND a.source=? AND a.source_id=?))`, [platform,platform,identity]);
  checks.push({sql:'SELECT NOT EXISTS(SELECT 1 FROM platform_accounts WHERE source=? AND source_id=? AND id<>?)',args:[platform,identity,accountId]});
  checks.push(...accountSettingChecks(accountId,input));
  const link=accountLink(env,accountId,input);
  checks.push(...link.checks);
  await atomic(env,checks,[statement(env,`INSERT INTO platform_accounts(id,source,source_id,display_name,processing_enabled,sfde_profile_id,avatar_url,login)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET display_name=excluded.display_name,
    avatar_url=CASE WHEN ? THEN excluded.avatar_url ELSE platform_accounts.avatar_url END,
    login=CASE WHEN ? THEN excluded.login ELSE platform_accounts.login END,
    processing_enabled=CASE WHEN ? OR ? IS NULL THEN platform_accounts.processing_enabled ELSE excluded.processing_enabled END,
    sfde_profile_id=coalesce(?,platform_accounts.sfde_profile_id)`,
    accountId,platform,identity,name,input.processing_enabled??false,input.sfde_profile_id??1,profile.avatar_url??null,profile.login??null,
    Object.hasOwn(profile,'avatar_url'),Object.hasOwn(profile,'login'),
    automatic || (input.preserve_disabled??false),input.processing_enabled,input.sfde_profile_id),
    ...link.mutations,
    enqueueStatement(env,{source:platform,kind:'account',source_id:identity,account_id:accountId},true)]);
  const account=(await one(env,'SELECT * FROM platform_accounts WHERE source=? AND source_id=?',platform,identity))!;
  return decoded(await withOwner(env,account));
}
export async function updateAccount(env: Env,id:string,input: Input) {
  uuid(id);
  const previous=await one(env,'SELECT * FROM platform_accounts WHERE id=?',id);
  if(!previous) throw new HttpError(404,'Account not found');
  const fields:Input={...channelProfile(input)};
  for(const key of ['catalog_cursor','archive_cursor','sfde_profile_id'])
    if(input[key]!=null) fields[key]=integer(input[key],key,1);
  if(Object.hasOwn(input,'streamer_id') && input.streamer_id!==null) integer(input.streamer_id,'streamer_id',1);
  if(input.processing_enabled!=null) {requireValue(typeof input.processing_enabled==='boolean','Invalid enablement'); fields.processing_enabled=input.processing_enabled;}
  if(input.display_name!=null) fields.display_name=text(input.display_name,'display name');
  if(input.last_cataloged_at!=null) fields.last_cataloged_at=date(input.last_cataloged_at);
  requireValue(Object.keys(fields).length>0||Object.hasOwn(input,'streamer_id'),'No account changes');
  requireValue(input.job_id == null && input.lease_token == null ||
    ['processing_enabled','sfde_profile_id','streamer_id'].every(key => !Object.hasOwn(input,key)), 'Automatic catalog cannot change operator settings');
  const checks=jobChecks(input, `AND j.kind='account' AND j.account_id=? AND EXISTS(
    SELECT 1 FROM platform_accounts a WHERE a.id=j.account_id AND a.source=j.source AND a.processing_enabled=1)`, [id]);
  checks.push({sql:'SELECT EXISTS(SELECT 1 FROM platform_accounts WHERE id=?)',args:[id]});
  checks.push(...accountSettingChecks(id,input));
  const link=accountLink(env,id,input);
  checks.push(...link.checks);
  await atomic(env,checks,[...(Object.keys(fields).length?[statement(env,`UPDATE platform_accounts SET ${Object.keys(fields).map(k=>`${k}=?`).join(',')} WHERE id=?`,...Object.values(fields),id)]:[]),
    ...link.mutations,
    ...(input.processing_enabled===true?[enqueueStatement(env,{source:previous.source,kind:'account',source_id:previous.source_id,account_id:id,wake:true},true)]:[])]);
  const account=await one(env,'SELECT * FROM platform_accounts WHERE id=?',id);
  if(!account) throw new HttpError(404,'Account not found');
  return decoded(await withOwner(env,account));
}
export async function updateVideoProfile(env:Env,id:number,input:Input) {
  integer(id,'video ID',1);
  requireValue(!Object.hasOwn(input,'job_id') && !Object.hasOwn(input,'lease_token'),'Automatic catalog cannot change video profile settings');
  requireValue(Object.keys(input).every(key=>['account_id','sfde_profile_id'].includes(key)),'Unknown video profile setting');
  requireValue(Object.hasOwn(input,'sfde_profile_id'),'Provide a video profile ID or null to clear it');
  const accountId=uuid(input.account_id),profileId=input.sfde_profile_id===null?null:integer(input.sfde_profile_id,'profile ID',1);
  const checks=[
    {sql:`SELECT EXISTS(SELECT 1 FROM vods WHERE id=? AND platform_account_id=? AND source IN(${ingestionPlatforms().map(()=>'?').join(',')}))`,args:[id,accountId,...ingestionPlatforms().map(entry=>entry.id)]},
    {sql:`SELECT NOT EXISTS(SELECT 1 FROM vod_processing_context v JOIN platform_accounts a ON a.id=v.platform_account_id
      JOIN chunks c ON c.vod_id=v.id WHERE v.id=? AND v.effective_profile_id<>coalesce(?,a.sfde_profile_id)
      AND c.status IN('queued','processing'))`,args:[id,profileId]},
    ...(profileId===null?[]:[{sql:'SELECT EXISTS(SELECT 1 FROM sfde_profiles WHERE id=?)',args:[profileId]}]),
  ];
  await atomic(env,checks,[statement(env,'UPDATE vods SET sfde_profile_id=?,updated_at=? WHERE id=? AND platform_account_id=?',profileId,now(),id,accountId)]);
  return decoded((await one(env,'SELECT * FROM vods WHERE id=?',id))!);
}
export async function saveVideo(env: Env,input: Input) {
  const video=input.video;
  requireValue(video && typeof video==='object' && !Array.isArray(video),'Expected video');
  requireValue(!Object.hasOwn(video,'sfde_profile_id'),'Use the manual video-profile endpoint to change operator settings');
  const platform=requireIngestion(video.source,'Twitch uses its chapter catalog').id;
  const identity=videoIdentity(platform,video.source_id), account=await one(env,'SELECT * FROM platform_accounts WHERE id=? AND source=?',uuid(input.account_id),platform);
  if(!account) throw new HttpError(404,'Platform account not found');
  const duration=integer(video.duration_seconds,'duration',1,604800), title=text(video.title,'title',1000);
  requireValue(input.explicit_ranges==null || typeof input.explicit_ranges==='boolean','Invalid explicit_ranges');
  requireValue(['auto','old','current'].includes(video.template_version??'auto'),'Invalid template version');
  requireValue(['archive','upload'].includes(video.content_kind??'archive'),'Invalid content kind');
  requireValue(Array.isArray(video.bazaar_chapters) && video.bazaar_chapters.length>0 && video.bazaar_chapters.length<=2000,'Expected gameplay ranges');
  for(const value of video.bazaar_chapters) integer(value,'chapter',0,duration);
  const chapters=JSON.stringify(normalizeRanges(video.bazaar_chapters,duration).flat());
  requireValue(chapters!=='[]','Empty gameplay ranges');
  const recorded=date(video.recorded_at),published=date(video.published_at),template=video.template_version??'auto';
  const parted=platformEntry(platform).recording.parts;
  const [bv,cid]=parted?identity.split(':'):[null,null];
  const part=parted?integer(video.source_part_index,'part index',1,10000):null;
  if(parted) requireValue(video.source_video_id===bv && video.source_part_id===cid,'Part identity mismatch');
  const checks=jobChecks(input, `AND j.source=? AND j.kind='video' AND j.source_id=? AND j.account_id=?
    AND EXISTS(SELECT 1 FROM platform_accounts a WHERE a.id=j.account_id AND a.source=j.source AND a.processing_enabled=1)`,
    [platform,parted?bv:identity,account.id]);
  // Check timeline/ownership in the same transaction as metadata mutation and competing planners.
  checks.push({sql:`SELECT NOT EXISTS(SELECT 1 FROM vods v WHERE v.source=? AND v.source_id=? AND (
    v.platform_account_id<>? OR (EXISTS(SELECT 1 FROM chunks WHERE vod_id=v.id) AND (v.duration_seconds<>? OR (? AND v.bazaar_chapters<>?) OR (? IS NOT NULL AND v.recorded_at IS NOT ?) OR (?<>'auto' AND v.template_version<>?)))))`,
    args:[platform,identity,account.id,duration,input.explicit_ranges??false,chapters,recorded,recorded,template,template]});
  await atomic(env,checks,[statement(env,`INSERT INTO vods(source,source_id,platform_account_id,title,duration_seconds,published_at,recorded_at,template_version,content_kind,bazaar_chapters,ready_for_processing,notifications_enabled,source_video_id,source_part_id,source_part_index,last_availability_check)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,0,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET
    title=excluded.title,duration_seconds=excluded.duration_seconds,published_at=excluded.published_at,
    recorded_at=coalesce(excluded.recorded_at,vods.recorded_at),template_version=CASE WHEN excluded.template_version='auto' THEN vods.template_version ELSE excluded.template_version END,
    content_kind=excluded.content_kind,bazaar_chapters=CASE WHEN ? THEN excluded.bazaar_chapters ELSE vods.bazaar_chapters END,
    source_part_index=excluded.source_part_index,availability='available',unavailable_since=NULL,last_availability_check=excluded.last_availability_check,ready_for_processing=1,updated_at=?`,
    platform,identity,account.id,title,duration,published,recorded,template,video.content_kind??'archive',chapters,bv,cid,part,now(),input.explicit_ranges??false,now())]);
  const saved=(await one(env,'SELECT * FROM vods WHERE source=? AND source_id=?',platform,identity))!;
  await plan(env,saved.id,checks);
  return decoded(saved);
}
function jobIdentity(input: Input) {
  const platform=requireIngestion(input.source,'Invalid ingestion source').id;
  requireValue(['account','video','discovery'].includes(input.kind),'Invalid ingestion kind');
  const identity=text(input.source_id,'ingestion identity',100);
  if(input.kind==='account') accountIdentity(platform,identity);
  else if(input.kind==='discovery') requireValue(identity==='bazaar','Invalid discovery identity');
  else submissionIdentity(platform,identity);
  if(input.account_id!=null) uuid(input.account_id);
  requireValue(input.kind!=='account'||input.account_id,'Account job requires account');
  requireValue(input.wake==null||typeof input.wake==='boolean','Invalid wake');
  return {platform,identity};
}
export function enqueueStatement(env: Env,input: Input, onlyEnabledAccount = false) {
  const {platform,identity}=jobIdentity(input), time=now(),cutoff=new Date(Date.now()-86400_000).toISOString();
  const insert = onlyEnabledAccount
    ? `SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM platform_accounts WHERE id=? AND processing_enabled=1)`
    : `VALUES(?,?,?,?,?)`;
  return statement(env,`INSERT INTO platform_ingestion_jobs(id,source,kind,source_id,account_id) ${insert}
    ON CONFLICT(source,kind,source_id) DO UPDATE SET account_id=coalesce(platform_ingestion_jobs.account_id,excluded.account_id),
    status=CASE WHEN status<>'processing' AND (? OR (status IN('completed','skipped') AND completed_at<?)) THEN 'pending' ELSE status END,
    next_attempt_at=CASE WHEN ? OR (status IN('completed','skipped') AND completed_at<?) THEN ? ELSE next_attempt_at END,
    rerun_requested=rerun_requested OR (? AND status='processing')`,crypto.randomUUID(),platform,input.kind,identity,input.account_id,...(onlyEnabledAccount?[input.account_id]:[]),input.wake??false,cutoff,input.wake??false,cutoff,time,input.wake??false);
}
export async function enqueueJob(env: Env,input: Input) {
  const {platform,identity}=jobIdentity(input),checks=jobChecks(input, `AND j.source=? AND (
    (j.kind='discovery' AND ?='video' AND ? IS NULL) OR
    (j.kind='account' AND ?='video' AND j.account_id=? AND EXISTS(
      SELECT 1 FROM platform_accounts a WHERE a.id=j.account_id AND a.processing_enabled=1)) OR
    (j.kind='video' AND ?='account' AND (j.account_id IS NULL OR j.account_id=?) AND EXISTS(
      SELECT 1 FROM platform_accounts a WHERE a.id=? AND a.source=j.source AND a.source_id=? AND a.processing_enabled=1)))`,
    [platform,input.kind,input.account_id,input.kind,input.account_id,input.kind,input.account_id,input.account_id,identity]);
  if(input.account_id) checks.push({sql:`SELECT EXISTS(SELECT 1 FROM platform_accounts WHERE id=? AND source=? ${input.kind==='account'?'AND source_id=?':''})`,args:[input.account_id,platform,...(input.kind==='account'?[identity]:[])]});
  // Reject a conflicting owner, including races between global discovery and account notifications.
  if(input.account_id) checks.push({sql:'SELECT NOT EXISTS(SELECT 1 FROM platform_ingestion_jobs WHERE source=? AND kind=? AND source_id=? AND account_id IS NOT NULL AND account_id<>?)',args:[platform,input.kind,identity,input.account_id]});
  await atomic(env,checks,[enqueueStatement(env,input)]);
  return (await one(env,'SELECT id FROM platform_ingestion_jobs WHERE source=? AND kind=? AND source_id=?',platform,input.kind,identity))!.id;
}
export async function claimJob(env: Env,input: Input) {
  requireValue(input.include_discovery==null||typeof input.include_discovery==='boolean','Invalid discovery flag');
  const owner=runnerOwnership(env,input);
  const checks=owner.automatic?[{sql:`SELECT ${owner.sql}`,args:owner.args}]:[];
  const result=await atomic(env,checks,[statement(env,`UPDATE platform_ingestion_jobs SET status='processing',lease_token=?,
    lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1200 seconds'),last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),attempts=attempts+1 WHERE id=(
    SELECT j.id FROM platform_ingestion_jobs j LEFT JOIN platform_accounts a ON a.id=j.account_id
    WHERE ${CLAIMABLE_INGESTION} AND (? OR j.kind<>'discovery') ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT 1)
    AND ${owner.sql} RETURNING *`,crypto.randomUUID(),input.include_discovery??true,...owner.args)]);
  const job=result[checks.length].results[0];
  return job?[decoded(job)]:[];
}
export async function finishJob(env: Env,input: Input) {
  uuid(input.id);uuid(input.token);
  requireValue(['waiting','completed','skipped'].includes(input.status),'Invalid job status');
  const delay=integer(input.delay_seconds??900,'delay',30,604800),state=input.state??{};
  requireValue(state && typeof state==='object'&&!Array.isArray(state)&&JSON.stringify(state).length<=64000,'Invalid job state');
  requireValue(input.error==null||typeof input.error==='string','Invalid error');
  const time=now();
  const result=await one(env,`UPDATE platform_ingestion_jobs SET status=CASE WHEN rerun_requested THEN 'pending' ELSE ? END,
    next_attempt_at=CASE WHEN rerun_requested THEN ? ELSE ? END,completed_at=?,last_error=?,state=?,attempts=CASE WHEN ? IS NULL THEN 0 ELSE attempts END,
    lease_token=NULL,lease_expires_at=NULL,rerun_requested=0 WHERE id=? AND lease_token=? AND status='processing' AND lease_expires_at>? RETURNING id`,
    input.status,time,new Date(Date.now()+delay*1000).toISOString(),['completed','skipped'].includes(input.status)?time:null,input.error?.slice(0,1000),JSON.stringify(state),input.error,input.id,input.token,time);
  return Boolean(result);
}
export async function catalogRoute(req:Request,env:Env) {
  const url=new URL(req.url),path=url.pathname.slice('/api/catalog'.length);
  if(path==='/accounts'&&req.method==='GET') return Response.json(await accounts(env,url.searchParams));
  if(!['POST','PATCH'].includes(req.method)) throw new HttpError(405,'Method not allowed');
  const data=await body(req);
  let result:unknown;
  if(path==='/accounts/upsert'&&req.method==='POST') result=await upsertAccount(env,data);
  else if(/^\/accounts\/[^/]+$/.test(path)&&req.method==='PATCH') result=await updateAccount(env,path.split('/')[2],data);
  else if(/^\/videos\/\d+$/.test(path)&&req.method==='PATCH') result=await updateVideoProfile(env,Number(path.split('/')[2]),data);
  else if(path==='/videos') result=await saveVideo(env,data);
  else if(path==='/jobs/enqueue') result=await enqueueJob(env,data);
  else if(path==='/jobs/claim') result=await claimJob(env,data);
  else if(path==='/jobs/finish') result=await finishJob(env,data);
  else if(path==='/runner/start'&&req.method==='POST') result=await startIngestionRunner(env,data);
  else if(path==='/runner/finish'&&req.method==='POST') result=await finishIngestionRunner(env,data);
  else if(path==='/jobs/attach-account') {
    uuid(data.id);uuid(data.token);uuid(data.account_id);
    const checks=jobChecks({job_id:data.id,lease_token:data.token}, `AND j.kind='video' AND (j.account_id IS NULL OR j.account_id=?)
      AND EXISTS(SELECT 1 FROM platform_accounts a WHERE a.id=? AND a.source=j.source)
      AND NOT EXISTS(SELECT 1 FROM vods v WHERE v.source=j.source AND (v.source_id=j.source_id OR v.source_video_id=j.source_id) AND v.platform_account_id<>?)`,
      [data.account_id,data.account_id,data.account_id]);
    await atomic(env,checks,[statement(env,`UPDATE platform_ingestion_jobs SET account_id=? WHERE id=?`,data.account_id,data.id)]);
    result=true;
  } else if(path==='/subscriptions/renew') {
    const accountId=uuid(data.account_id);
    const push=listPlatforms().filter(entry=>entry.adapters.push==='websub').map(entry=>entry.id);
    result=await renewSubscription(env,accountId,jobChecks(data,
      `AND j.source IN(${push.map(()=>'?').join(',')}) AND j.kind='account' AND j.account_id=? AND EXISTS(
        SELECT 1 FROM platform_accounts a WHERE a.id=j.account_id AND a.processing_enabled=1)`, [...push,accountId]));
  } else if(path==='/dispatch') {
    requireValue(data.expected_environment===env.ENVIRONMENT,'Environment mismatch');
    requireValue(data.dry_run==null||typeof data.dry_run==='boolean','Invalid dry_run');
    const limit=integer(data.limit??3,'limit',1,3);
    await recover(env);
    const due=await pendingVideos(env,limit,true);
    let count=0;
    for(const v of due) {if(data.dry_run) await plan(env,v.id);else if((await dispatch(env,v.id)).length) count++;}
    result={dispatched:count};
  } else if(path==='/maintenance') {
    // WebSub has no signed timestamp. Keep digest tombstones for the account lifetime.
    result={cleaned:true,delivery_receipts_retained:true};
  } else throw new HttpError(404,'Unknown catalog endpoint');
  return Response.json(result);
}
