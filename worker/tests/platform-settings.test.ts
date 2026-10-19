import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hasDueIngestionDispatch } from '../platform-ingestion-dispatch';
import { claimJob, enqueueJob, upsertAccount } from '../platforms';
import { handleJob } from '../jobs';
import { dispatchCatalog, requestCatalog } from '../catalog-work';
import { pendingVideos } from '../processing';
import { isPlatformEnabled, platformSettings, updatePlatformSettings } from '../platform-settings';
import { one, rows, statement } from '../http';

const runtime = () => ({ ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'offline-dispatch-fixture' });
const set = (source: string, values: Record<string, 0 | 1>) => statement(env,
  `UPDATE platform_settings SET ${Object.keys(values).map(key => `${key}=?`).join(',')} WHERE source=?`, ...Object.values(values), source).run();
const claimed = async () => (await claimJob(env, {})).map(job => `${job.source}:${job.kind}:${job.source_id}`);

beforeEach(async () => {
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'settings fixture','[0,0,1,1]')").run();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('migration seeds every current platform and a missing row is fully off', async () => {
  expect((await platformSettings(env)).map(row => row.source)).toEqual(['bilibili', 'twitch', 'youtube']);
  await statement(env, "DELETE FROM platform_settings WHERE source='bilibili'").run();
  expect(await isPlatformEnabled(env, 'bilibili', 'ingestion_enabled')).toBe(false);
  expect((await platformSettings(env))[0]).toEqual({ source: 'bilibili', ingestion_enabled: false,
    discovery_enabled: false, processing_enabled: false, updated_at: null });
  const account = await upsertAccount(env, { source: 'bilibili', source_id: '2561817', display_name: 'tony', processing_enabled: true });
  await enqueueJob(env, { source: 'bilibili', kind: 'account', source_id: '2561817', account_id: account.id });
  expect(await claimed()).toEqual([]);
});

it('gates ingestion and discovery claims per platform independently', async () => {
  const bili = await upsertAccount(env, { source: 'bilibili', source_id: '2561817', display_name: 'tony', processing_enabled: true });
  await enqueueJob(env, { source: 'bilibili', kind: 'account', source_id: '2561817', account_id: bili.id });
  await enqueueJob(env, { source: 'bilibili', kind: 'video', source_id: 'BV1K114BiE7t', account_id: bili.id });
  await enqueueJob(env, { source: 'bilibili', kind: 'discovery', source_id: 'bazaar' });
  await enqueueJob(env, { source: 'bilibili', kind: 'video', source_id: 'BV1FfL5zPEbH' });
  await enqueueJob(env, { source: 'youtube', kind: 'video', source_id: 'YT000000001' });
  // Bilibili ingestion only: enrolled account polls and owned videos, never discovery or unowned candidates.
  await set('bilibili', { ingestion_enabled: 1, discovery_enabled: 0 });
  await set('youtube', { ingestion_enabled: 0, discovery_enabled: 0 });
  const seen = [];
  for (let job; (job = await claimed()).length;) seen.push(...job);
  expect(seen.sort()).toEqual(['bilibili:account:2561817', 'bilibili:video:BV1K114BiE7t']);
  await statement(env, "UPDATE platform_ingestion_jobs SET status='pending',lease_token=NULL,lease_expires_at=NULL").run();
  await set('bilibili', { ingestion_enabled: 0, discovery_enabled: 1 });
  const discovered = [];
  for (let job; (job = await claimed()).length;) discovered.push(...job);
  expect(discovered.sort()).toEqual(['bilibili:discovery:bazaar', 'bilibili:video:BV1FfL5zPEbH']);
});

it('only requests a GitHub ingestion run for work an enabled platform may claim', async () => {
  await enqueueJob(env, { source: 'youtube', kind: 'video', source_id: 'YT000000001' });
  await set('youtube', { discovery_enabled: 0 });
  expect(await hasDueIngestionDispatch(runtime())).toBe(false);
  await set('youtube', { discovery_enabled: 1 });
  expect(await hasDueIngestionDispatch(runtime())).toBe(true);
});

it('gates automatic processing per platform', async () => {
  const account = await upsertAccount(env, { source: 'bilibili', source_id: '2561817', display_name: 'tony', processing_enabled: true });
  await statement(env, "INSERT INTO streamers(id,login) VALUES(1,'twitch fixture')").run();
  await statement(env, "INSERT INTO vods(streamer_id,source_id,duration_seconds,published_at,bazaar_chapters,ready_for_processing) VALUES(1,'111',12,'2026-10-16T00:00:00Z','[0,12]',1)").run();
  await statement(env, `INSERT INTO vods(source,source_id,source_video_id,source_part_id,source_part_index,platform_account_id,duration_seconds,published_at,bazaar_chapters,ready_for_processing)
    VALUES('bilibili','BV1K114BiE7t:33726794861','BV1K114BiE7t','33726794861',1,?,12,'2026-10-17T00:00:00Z','[0,12]',1)`, account.id).run();
  const sources = async () => (await Promise.all((await pendingVideos(env, 10)).map(v => one(env, 'SELECT source FROM vods WHERE id=?', v.id)))).map(v => v!.source).sort();
  expect(await sources()).toEqual(['bilibili', 'twitch']);
  await set('bilibili', { processing_enabled: 0 });
  expect(await sources()).toEqual(['twitch']);
});

it('keeps Twitch catalog requests durable while ingestion is off and skips discovery when off', async () => {
  const send = vi.fn().mockResolvedValue(undefined), context = { ...env, JOBS: { send } as unknown as Queue };
  await requestCatalog(context, [{ id: 7 }]);
  await set('twitch', { ingestion_enabled: 0, discovery_enabled: 0 });
  expect(await dispatchCatalog(context)).toBe(0);
  expect(await one(env, 'SELECT state FROM twitch_catalog_work WHERE streamer_id=7')).toEqual({ state: 'pending' });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await handleJob(context, { type: 'discover' });
  expect(fetch).not.toHaveBeenCalled();
  await set('twitch', { ingestion_enabled: 1 });
  expect(await dispatchCatalog(context)).toBe(1);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'catalog-batch', ids: [7], token: expect.any(String) });
});

it('lets an administrator list and change one platform without touching the others', async () => {
  const before = await platformSettings(env);
  const after = await updatePlatformSettings(env, { source: 'youtube', ingestion_enabled: false });
  expect(after.find(row => row.source === 'youtube')).toMatchObject({ ingestion_enabled: false, discovery_enabled: true, processing_enabled: true });
  expect(after.filter(row => row.source !== 'youtube').map(({ updated_at, ...row }) => row))
    .toEqual(before.filter(row => row.source !== 'youtube').map(({ updated_at, ...row }) => row));
  for (const input of [{ source: 'youtube' }, { source: 'kick', ingestion_enabled: true }, { source: 'youtube', ingestion_enabled: 'yes' }, { ingestion_enabled: false }])
    await expect(updatePlatformSettings(env, input)).rejects.toThrow();
  const response = await SELF.fetch('http://local/api/admin/platforms', { method: 'POST', headers: {
    Authorization: `Bearer ${env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'bilibili', discovery_enabled: false }) });
  expect(response.status).toBe(200);
  expect((await response.json() as any[]).find(row => row.source === 'bilibili')).toMatchObject({ ingestion_enabled: true, discovery_enabled: false });
  expect((await SELF.fetch('http://local/api/admin/platforms', { method: 'POST', body: '{}' })).status).toBe(401);
  expect(await rows(env, "SELECT source FROM platform_settings WHERE source='kick'")).toEqual([]);
});
