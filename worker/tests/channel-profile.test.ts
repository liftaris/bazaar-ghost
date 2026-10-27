import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { upsertAccount, updateAccount, saveVideo } from '../platforms';
import { one, statement } from '../http';
import { nativeRoute } from '../native-api';

const channel = 'UC' + 'a'.repeat(22);
const identity = {source: 'youtube', source_id: channel, display_name: 'Uploader'};
const avatar = 'https://yt3.googleusercontent.com/avatar';

beforeEach(async () => {
  for (const id of [1, 2]) await statement(env,
    'INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(?,?,?)', id, `profile-${id}`, '[0,0,1,1]').run();
});

it('persists avatar and handle without changing disabled accounts or their profile', async () => {
  const account = await upsertAccount(env, {...identity, sfde_profile_id: 2});
  const updated = await upsertAccount(env, {...identity, avatar_url: avatar, login: 'Uploader'});
  expect(updated).toMatchObject({id: account.id, processing_enabled: false, sfde_profile_id: 2, avatar_url: avatar, login: 'Uploader'});
  const repeated = await upsertAccount(env, identity);
  expect(repeated).toMatchObject({avatar_url: avatar, login: 'Uploader', sfde_profile_id: 2});
});

it('refreshes provisional streamer and public channel metadata without merging identities', async () => {
  const account = await upsertAccount(env, {...identity, processing_enabled: true});
  await saveVideo(env, {account_id: account.id, video: {
    source: 'youtube', source_id: 'abcdefghijk', title: 'The Bazaar', duration_seconds: 100, bazaar_chapters: [0, 100],
  }});
  const owner = await one(env, 'SELECT streamer_id FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL', account.id);
  await statement(env, "INSERT INTO streamers(id,login,display_name,profile_image_url) VALUES(123,'other','Other','https://example.com/twitch')").run();
  await updateAccount(env, account.id, {avatar_url: avatar, login: 'Uploader', display_name: 'New name'});
  expect(await one(env, 'SELECT display_name,avatar_url FROM streamer_identities WHERE id=?', owner?.streamer_id))
    .toEqual({display_name: 'New name', avatar_url: avatar});
  expect(await one(env, 'SELECT streamer_id FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL', account.id)).toEqual(owner);
  expect(await one(env, 'SELECT display_name,avatar_url FROM streamer_identities WHERE id=123'))
    .toEqual({display_name: 'Other', avatar_url: 'https://example.com/twitch'});
  const response = await nativeRoute(new Request(`https://local/api/v1/channels/lookup?platform=youtube&sourceId=${channel}`), env);
  expect(await response.json()).toMatchObject({channel: {avatarUrl: avatar, login: 'Uploader'}, streamer: {avatarUrl: avatar}});
});

it('fences periodic metadata refresh and preserves operator settings', async () => {
  const account = await upsertAccount(env, {...identity, processing_enabled: true, sfde_profile_id: 2});
  const token = crypto.randomUUID();
  const job = await one(env, "SELECT id FROM platform_ingestion_jobs WHERE account_id=? AND kind='account'", account.id);
  await statement(env, "UPDATE platform_ingestion_jobs SET status='processing',lease_token=?,lease_expires_at=? WHERE id=?",
    token, new Date(Date.now() + 600000).toISOString(), job?.id).run();
  const fence = {job_id: job?.id, lease_token: token};
  await updateAccount(env, account.id, {...fence, avatar_url: avatar, login: 'Uploader'});
  expect(await one(env, 'SELECT processing_enabled,sfde_profile_id FROM platform_accounts WHERE id=?', account.id))
    .toEqual({processing_enabled: 1, sfde_profile_id: 2});
  await expect(updateAccount(env, account.id, {...fence, processing_enabled: false, avatar_url: null})).rejects.toMatchObject({status: 400});
  await expect(updateAccount(env, account.id, {...fence, lease_token: crypto.randomUUID(), avatar_url: 'https://example.com/stale'})).rejects.toMatchObject({status: 409});
  expect((await one(env, 'SELECT avatar_url FROM platform_accounts WHERE id=?', account.id))?.avatar_url).toBe(avatar);
});

it.each(['http://example.com/avatar', 'javascript:alert(1)', 'https://user:secret@example.com/avatar', 'https://'])
('rejects invalid avatar URL %s at both catalog boundaries', async avatar_url => {
  const account = await upsertAccount(env, identity);
  await expect(upsertAccount(env, {...identity, avatar_url})).rejects.toMatchObject({status: 400});
  await expect(updateAccount(env, account.id, {avatar_url})).rejects.toMatchObject({status: 400});
});
