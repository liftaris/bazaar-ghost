import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { one, rows } from '../http';
import { mergeSessions } from '../sessions';
import { upsertAccount, updateAccount } from '../platforms';

const BB1 = '11111111-1111-4111-8111-111111111111', BB2 = '22222222-2222-4222-8222-222222222222', YT1 = '33333333-3333-4333-8333-333333333333';
const admin = (path: string, method: string, data?: unknown) => SELF.fetch(`http://local${path}`, {
  method, headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
const pub = (path: string) => SELF.fetch(`http://local${path}`);
const owner = (channel: string) => one(env, 'SELECT o.streamer_id,o.actor,i.display_name,i.provisional_channel_id FROM channel_ownership o JOIN streamer_identities i ON i.id=o.streamer_id WHERE o.channel_id=? AND o.ended_at IS NULL', channel);
const video = (id: number, channel: string, availability = 'available') => env.DB.exec(
  channel === YT1
    ? `INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,bazaar_chapters,availability) VALUES(${id},'youtube','abcdefg${String(id).padStart(4, '0')}','${channel}',60,'[0,60]','${availability}')`
    : `INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,bazaar_chapters,availability,source_video_id,source_part_id,source_part_index) VALUES(${id},'bilibili','BV${id}:1','${channel}',60,'[0,60]','${availability}','BV${id}','1',1)`);
const detect = (vod: number) => env.DB.exec(`INSERT OR IGNORE INTO search_names(name,gram_count) VALUES('opp',1); INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('c${vod}',${vod},0,60,0); INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,rank,storage_path) VALUES(${vod},'c${vod}',${vod},'Opp','opp',0.95,10,'gold','/d.jpg')`);

beforeEach(async () => {
  await env.DB.exec(`INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]');
    INSERT INTO platform_accounts(id,source,source_id,display_name,avatar_url) VALUES('${BB1}','bilibili','111','Bili One','https://img/1.png'),('${BB2}','bilibili','222','Reuploader',NULL),('${YT1}','youtube','UCaaaaaaaaaaaaaaaaaaaaaa','Kripp YT',NULL)`);
});

it('provisions a Streamer on the first available Recording and attributes its Session', async () => {
  await video(1, BB1, 'unavailable');
  expect(await owner(BB1)).toBeNull();
  await env.DB.exec("UPDATE vods SET availability='available' WHERE id=1");
  const o = (await owner(BB1))!;
  expect(o).toMatchObject({ actor: 'system:provisional', display_name: 'Bili One', provisional_channel_id: BB1 });
  expect(o.streamer_id).toBeGreaterThan(1_000_000_000_000);
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=(SELECT session_id FROM vods WHERE id=1)'))!.streamer_id).toBe(o.streamer_id);
  await video(2, BB1);
  expect((await one(env, 'SELECT count(*) AS n FROM streamer_identities'))!.n).toBe(1);
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=(SELECT session_id FROM vods WHERE id=2)'))!.streamer_id).toBe(o.streamer_id);
});

it('keeps the provisional name and avatar in sync with the Channel', async () => {
  await video(1, BB1);
  await env.DB.exec(`UPDATE platform_accounts SET display_name='Renamed',avatar_url='https://img/2.png' WHERE id='${BB1}'`);
  expect(await one(env, 'SELECT display_name,avatar_url FROM streamer_identities')).toEqual({ display_name: 'Renamed', avatar_url: 'https://img/2.png' });
});

it('persists catalog avatars, preserves absent values, and exposes provisional avatars publicly', async () => {
  await video(1, BB1);
  await detect(1);
  const face='https://i2.hdslb.com/bfs/face/avatar.jpg';
  const input={source:'bilibili',source_id:'111',display_name:'Bili One'};
  const created=await upsertAccount(env,{...input,source_id:'333',avatar_url:face});
  expect(created.avatar_url).toBe(face);
  await env.DB.exec(`INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(2,'custom','[0,0,1,1]'); UPDATE platform_accounts SET sfde_profile_id=2 WHERE id='${BB1}'`);
  const before=await one(env,'SELECT sfde_profile_id,processing_enabled FROM platform_accounts WHERE id=?',BB1);
  const ownership=await owner(BB1);
  await upsertAccount(env,{...input,avatar_url:face});
  for(const value of [undefined,null,'']) await upsertAccount(env,{...input,avatar_url:value});
  expect(await one(env,'SELECT avatar_url FROM platform_accounts WHERE id=?',BB1)).toEqual({avatar_url:face});
  expect(await one(env,'SELECT avatar_url FROM streamer_identities WHERE provisional_channel_id=?',BB1)).toEqual({avatar_url:face});
  const updated=face.replace('avatar','updated');
  await updateAccount(env,BB1,{avatar_url:updated});
  expect(await one(env,'SELECT avatar_url FROM streamer_identities WHERE provisional_channel_id=?',BB1)).toEqual({avatar_url:updated});
  expect(await owner(BB1)).toEqual(ownership);
  expect(await one(env,'SELECT sfde_profile_id,processing_enabled FROM platform_accounts WHERE id=?',BB1)).toEqual(before);
  expect(await rows(env,'SELECT * FROM platform_ingestion_jobs')).toEqual([]);
  const response=await (await pub('/api/v1/streamers?platform=bilibili')).json();
  expect(response).toMatchObject({items:[{avatarUrl:updated,channels:[{avatarUrl:updated}]}]});
});

it('refreshes a linked channel without replacing its curated Streamer avatar or profile', async () => {
  await env.DB.exec("INSERT INTO streamers(id,login,display_name,profile_image_url) VALUES(4242,'curated','Curated','https://img/curated.png')");
  await updateAccount(env,BB2,{streamer_id:4242});
  const identity=await one(env,'SELECT * FROM streamer_identities WHERE id=4242');
  const ownership=await owner(BB2);
  await updateAccount(env,BB2,{avatar_url:'https://i2.hdslb.com/bfs/face/channel.jpg'});
  expect(await one(env,'SELECT * FROM streamer_identities WHERE id=4242')).toEqual(identity);
  expect(await owner(BB2)).toEqual(ownership);
  await expect(updateAccount(env,BB2,{avatar_url:'javascript:alert(1)'})).rejects.toMatchObject({status:400});
});

it('backfills existing Channels with public content, once, and attributes their Sessions', async () => {
  await video(1, BB1); await video(2, YT1, 'unavailable');
  await env.DB.exec("UPDATE sessions SET streamer_id=NULL; DELETE FROM channel_ownership; UPDATE streamer_identities SET provisional_channel_id=NULL; DELETE FROM streamer_identities");
  expect(await owner(BB1)).toBeNull();
  const backfill = env.TEST_MIGRATIONS.find(m => m.name.startsWith('0021'))!.queries.map(q => q.replace(/^(\s*--.*\n)+/, '').trim()).filter(q => /^(INSERT|UPDATE)/.test(q));
  for (let run = 0; run < 2; run++) for (const query of backfill) await env.DB.exec(query.replace(/\n/g, ' '));
  expect((await rows(env, 'SELECT provisional_channel_id FROM streamer_identities')).map(r => r.provisional_channel_id)).toEqual([BB1]);
  const o = (await owner(BB1))!;
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=(SELECT session_id FROM vods WHERE id=1)'))!.streamer_id).toBe(o.streamer_id);
});

it('lists, finds and filters a provisional Bilibili Streamer', async () => {
  await video(1, BB1);
  await detect(1);
  const id = (await owner(BB1))!.streamer_id;
  const listed = await (await admin('/api/admin/streamers?provisional=1', 'GET')).json() as any[];
  expect(listed.map(s => [s.id, s.channels[0].platform])).toEqual([[id, 'bilibili']]);
  const sessions = await (await pub(`/api/v1/sessions?streamerId=${id}`)).json() as any;
  expect(JSON.stringify(sessions)).toContain('Bili One');
  const streamers = await (await pub('/api/v1/streamers?platform=bilibili')).json() as any;
  expect(JSON.stringify(streamers)).toContain(String(id));
});

it('merges a provisional Streamer into the real one, moving Channels and Sessions', async () => {
  await env.DB.exec("INSERT INTO streamers(id,login,display_name) VALUES(4242,'nl_kripp','nl_Kripp')");
  await video(1, YT1);
  const prov = (await owner(YT1))!.streamer_id;
  expect((await admin(`/api/admin/streamers/${prov}/merge`, 'POST', { into: 4242, actor: 'op' })).status).toBe(200);
  expect(await owner(YT1)).toMatchObject({ streamer_id: 4242, actor: 'op' });
  expect(await one(env, 'SELECT 1 FROM streamer_identities WHERE id=?', prov)).toBeNull();
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=(SELECT session_id FROM vods WHERE id=1)'))!.streamer_id).toBe(4242);
  await video(2, YT1);
  expect((await one(env, 'SELECT count(*) AS n FROM streamer_identities WHERE provisional_channel_id IS NOT NULL'))!.n).toBe(0);
  expect((await admin('/api/admin/streamers/4242/merge', 'POST', { into: 4242 })).status).toBe(400);
  expect((await admin('/api/admin/streamers/4242/merge', 'POST', { into: prov })).status).toBe(409);
});

it('lets a Session of a provisional Streamer merge into a real Streamer\'s Session without choosing', async () => {
  await env.DB.exec("INSERT INTO streamers(id,login,display_name) VALUES(4242,'nl_kripp','nl_Kripp'); INSERT INTO vods(id,streamer_id,source_id,duration_seconds,bazaar_chapters) VALUES(1,4242,'t1',60,'[0,60]')");
  await video(2, YT1);
  const session = async (id: number) => (await one(env, 'SELECT session_id FROM vods WHERE id=?', id))!.session_id as string;
  await mergeSessions(env, await session(1), await session(2), 0, { method: 'operator', actor: 'op' });
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=?', await session(1)))!.streamer_id).toBe(4242);
});
