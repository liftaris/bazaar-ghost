import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { createStreamer, linkChannel, listStreamers, renameStreamer, resolveStreamer, unlinkChannel } from '../streamers';
import { updateAccount, upsertAccount } from '../platforms';
import { pendingVideos } from '../processing';
import { one, rows } from '../http';

const operator = { method: 'operator', actor: 'tester' };
const ucid = (c: string) => 'UC' + c.repeat(22);
const admin = (path: string, method: string, data?: unknown) => SELF.fetch(`http://local${path}`, {
  method, headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });

beforeEach(async () => {
  await env.DB.exec("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]')");
});

it('seeds a Twitch Channel, identity with the Twitch ID and legacy-link ownership for each streamer', async () => {
  await env.DB.exec("INSERT INTO streamers(id,login,display_name,profile_image_url) VALUES(4242,'Alpha','Alpha Prime','https://img/a.png')");
  const channel = (await one(env, "SELECT * FROM platform_accounts WHERE source='twitch'"))!;
  expect(channel).toMatchObject({ source_id: '4242', display_name: 'Alpha Prime', login: 'Alpha', avatar_url: 'https://img/a.png', legacy_creator_id: 'twitch:4242' });
  expect(channel.id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(await one(env, 'SELECT id,display_name FROM streamer_identities')).toEqual({ id: 4242, display_name: 'Alpha Prime' });
  expect(await rows(env, 'SELECT channel_id,streamer_id,method,actor,ended_at FROM channel_ownership'))
    .toEqual([{ channel_id: channel.id, streamer_id: 4242, method: 'legacy-link', actor: 'trigger:streamers', ended_at: null }]);
  await env.DB.exec("INSERT INTO vods(streamer_id,source_id,duration_seconds,bazaar_chapters) VALUES(4242,'v1',60,'[0,60]')");
  expect((await one(env, "SELECT platform_account_id FROM vods WHERE source_id='v1'"))!.platform_account_id).toBe(channel.id);
  expect((await one(env, "SELECT channel_streamer_id FROM public_recordings WHERE source_id='v1'"))!.channel_streamer_id).toBe(4242);
});

it('mirrors streamer settings and names onto the Twitch Channel', async () => {
  await env.DB.exec("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(2,'q','[0,0,1,1]'); INSERT INTO streamers(id,login,display_name) VALUES(7,'seven','Seven')");
  await env.DB.exec("UPDATE streamers SET processing_enabled=0,sfde_profile_id=2,display_name='Seven!' WHERE id=7");
  expect(await one(env, "SELECT processing_enabled,sfde_profile_id,display_name FROM platform_accounts WHERE source='twitch'"))
    .toEqual({ processing_enabled: 0, sfde_profile_id: 2, display_name: 'Seven!' });
});

it('does not schedule a Twitch VOD whose streamer is disabled, even though it now has a Channel', async () => {
  await env.DB.exec(`INSERT INTO streamers(id,login,processing_enabled) VALUES(1,'on',1),(2,'off',0);
    INSERT INTO vods(id,streamer_id,source_id,duration_seconds,bazaar_chapters,ready_for_processing,published_at) VALUES(1,1,'a',60,'[0,60]',1,'2026-10-01T00:00:00Z'),(2,2,'b',60,'[0,60]',1,'2026-10-01T00:00:00Z')`);
  expect((await pendingVideos(env)).map(r => r.id)).toEqual([1]);
  expect(await rows(env, 'SELECT id,processing_enabled,effective_profile_id FROM vod_processing_context ORDER BY id'))
    .toEqual([{ id: 1, processing_enabled: 1, effective_profile_id: 1 }, { id: 2, processing_enabled: 0, effective_profile_id: 1 }]);
  // Even if the Channel row drifted, the legacy streamer record stays authoritative.
  await env.DB.exec("UPDATE platform_accounts SET processing_enabled=1 WHERE source_id='2'");
  expect((await pendingVideos(env)).map(r => r.id)).toEqual([1]);
});

it('supports a Streamer with only YouTube Channels, two on one platform', async () => {
  const streamer = await createStreamer(env, { display_name: 'Yt Only' });
  expect(streamer.id).toBeGreaterThan(1_000_000_000_000);
  const a = await upsertAccount(env, { source: 'youtube', source_id: ucid('a'), display_name: 'Main' });
  const b = await upsertAccount(env, { source: 'youtube', source_id: ucid('b'), display_name: 'Clips' });
  await linkChannel(env, streamer.id, a.id, operator);
  const resolved = await linkChannel(env, streamer.id, b.id, operator);
  expect(resolved.channels.map((c: any) => [c.platform, c.display_name])).toEqual([['youtube', 'Clips'], ['youtube', 'Main']]);
  expect((await listStreamers(env, { limit: 10 })).map(s => s.id)).toEqual([streamer.id]);
});

it('records link history, rejects a competing owner with 409 and allows relinking after unlink', async () => {
  const one_ = await createStreamer(env, { display_name: 'One' }), two = await createStreamer(env, { display_name: 'Two' });
  const channel = await upsertAccount(env, { source: 'youtube', source_id: ucid('c'), display_name: 'C' });
  await linkChannel(env, one_.id, channel.id, { ...operator, evidence: 'ticket 1' });
  await linkChannel(env, one_.id, channel.id, operator);
  expect(await rows(env, 'SELECT id FROM channel_ownership')).toHaveLength(1);
  await expect(linkChannel(env, two.id, channel.id, operator)).rejects.toMatchObject({ status: 409 });
  await expect(env.DB.exec(`INSERT INTO channel_ownership(channel_id,streamer_id,method,actor) VALUES('${channel.id}',${two.id},'operator','x')`)).rejects.toThrow();
  await unlinkChannel(env, one_.id, channel.id, { actor: 'tester', reason: 'wrong person' });
  await expect(unlinkChannel(env, one_.id, channel.id, { actor: 'tester' })).rejects.toMatchObject({ status: 404 });
  await linkChannel(env, two.id, channel.id, operator);
  const history = (await resolveStreamer(env, one_.id, true)).history!;
  expect(history).toMatchObject([{ method: 'operator', actor: 'tester', evidence: 'ticket 1', ended_by: 'tester', end_reason: 'wrong person' }]);
  expect(history[0].ended_at).toBeTruthy();
  expect((await resolveStreamer(env, two.id)).channels).toHaveLength(1);
});

it('rejects proven-login and legacy-link from code paths until they are implemented', async () => {
  const s = await createStreamer(env, { display_name: 'S' });
  const channel = await upsertAccount(env, { source: 'youtube', source_id: ucid('d'), display_name: 'D' });
  for (const method of ['proven-login', 'legacy-link', 'guess'])
    await expect(linkChannel(env, s.id, channel.id, { method, actor: 'x' })).rejects.toMatchObject({ status: 400 });
  expect((await admin(`/api/admin/streamers/${s.id}/channels`, 'POST', { channel_id: channel.id, method: 'proven-login' })).status).toBe(400);
  expect(await rows(env, 'SELECT id FROM channel_ownership')).toEqual([]);
});

it('routes the legacy account streamer_id through ownership instead of the deprecated column', async () => {
  await env.DB.exec("INSERT INTO streamers(id,login) VALUES(5,'five')");
  const account = await upsertAccount(env, { source: 'youtube', source_id: ucid('e'), display_name: 'E', streamer_id: 5 });
  expect(account.streamer_id).toBe(5);
  expect((await one(env, 'SELECT streamer_id FROM platform_accounts WHERE id=?', account.id))!.streamer_id).toBeNull();
  expect(await rows(env, 'SELECT streamer_id,method FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL', account.id)).toEqual([{ streamer_id: 5, method: 'operator' }]);
  await env.DB.exec("INSERT INTO streamers(id,login) VALUES(6,'six')");
  await expect(updateAccount(env, account.id, { streamer_id: 6 })).rejects.toMatchObject({ status: 409 });
  expect((await updateAccount(env, account.id, { streamer_id: null })).streamer_id).toBeNull();
  expect((await updateAccount(env, account.id, { streamer_id: 6 })).streamer_id).toBe(6);
});

it('bumps search and cache revisions when ownership or a Streamer changes', async () => {
  const revision = async () => (await one(env, 'SELECT (SELECT revision FROM public_search_state) s,(SELECT revision FROM public_cache_state) c'))!;
  const s = await createStreamer(env, { display_name: 'R' });
  const channel = await upsertAccount(env, { source: 'youtube', source_id: ucid('f'), display_name: 'F' });
  let before = await revision();
  await linkChannel(env, s.id, channel.id, operator);
  let after = await revision();
  expect(after.s).toBeGreaterThan(before.s as number); expect(after.c).toBeGreaterThan(before.c as number);
  before = after;
  await unlinkChannel(env, s.id, channel.id, { actor: 'x' });
  after = await revision();
  expect(after.s).toBeGreaterThan(before.s as number);
  before = after;
  await renameStreamer(env, s.id, { display_name: 'Renamed' });
  expect((await revision()).c).toBeGreaterThan(before.c as number);
});

it('serves admin routes and the additive public v1 endpoints', async () => {
  expect((await SELF.fetch('http://local/api/admin/streamers', { method: 'POST', body: '{}' })).status).toBe(401);
  const created = await (await admin('/api/admin/streamers', 'POST', { display_name: 'Route Streamer' })).json() as any;
  const channel = await upsertAccount(env, { source: 'bilibili', source_id: '12345', display_name: 'Bili' });
  expect((await admin(`/api/admin/streamers/${created.id}`, 'PATCH', { display_name: 'Renamed Route' })).status).toBe(200);
  expect((await admin(`/api/admin/streamers/${created.id}/channels`, 'POST', { channel_id: channel.id, actor: 'op' })).status).toBe(200);
  const list = await (await SELF.fetch('http://local/api/v1/streamers')).json() as any;
  expect(list.items).toEqual([]); // the public list only has Streamers with public Matchups
  expect(await (await SELF.fetch(`http://local/api/v1/streamers/${created.id}`)).json() as any).toEqual({ id: created.id, displayName: 'Renamed Route', avatarUrl: null,
    channels: [{ id: channel.id, platform: 'bilibili', sourceId: '12345', displayName: 'Bili', login: null, avatarUrl: null, url: 'https://space.bilibili.com/12345', streamerId: created.id }] });
  expect((await SELF.fetch('http://local/api/v1/streamers/999')).status).toBe(404);
  expect((await admin(`/api/admin/streamers/${created.id}/channels/${channel.id}`, 'DELETE')).status).toBe(200);
  expect((await (await SELF.fetch(`http://local/api/v1/streamers/${created.id}`)).json() as any).channels).toEqual([]);
  expect((await admin('/api/admin/streamers/abc', 'PATCH', {})).status).toBe(404);
});
