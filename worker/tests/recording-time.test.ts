import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { plan } from '../processing';
import { Twitch } from '../twitch';
import { saveVideo, upsertAccount } from '../platforms';
import { nativeRoute } from '../native-api';
import { one, rows, statement } from '../http';

beforeEach(async () => {
  await env.DB.exec("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]')");
});
afterEach(() => vi.restoreAllMocks());

it('never invents a recording time for non-Twitch videos: current templates and null v1 recordedAt', async () => {
  const account = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + 'a'.repeat(22), display_name: 'Y', processing_enabled: true });
  const saved = await saveVideo(env, { account_id: account.id, video: { source: 'youtube', source_id: 'abcdefghijk', title: 'Old reupload',
    duration_seconds: 100, published_at: '2025-01-01T00:00:00Z', recorded_at: null, bazaar_chapters: [0, 100] } });
  expect(await one(env, 'SELECT old_templates FROM vod_processing_context WHERE id=?', saved.id)).toEqual({ old_templates: 0 });
  const chunk = (await plan(env, saved.id))[0];
  await env.DB.exec("INSERT INTO search_names(name,gram_count) VALUES('opp',1)");
  await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,frame_time_seconds,confidence,igd,storage_path) VALUES('d1',?,?,'Opp','opp',10,0.97,1,'p/1.jpg')`, chunk.id, saved.id).run();
  expect(await one(env, 'SELECT recorded_timestamp FROM video_detections')).toEqual({ recorded_timestamp: null });
  const response = await nativeRoute(new Request('http://local/api/v1/matchups/1'), env);
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).matchup.recordedAt).toBeNull();
});

it('sets recorded_at from the publish time on the Twitch path, on insert and on update', async () => {
  await env.DB.exec("INSERT INTO streamers(id,login,eventsub_subscription_id) VALUES(1,'creator','sub')");
  const twitch = new Twitch({ ...env, JOBS: { send: vi.fn() } as unknown as Queue });
  const video = { id: '100', title: 'The Bazaar', lengthSeconds: 3600, publishedAt: '2025-01-01T00:00:00Z', game: { id: 'bazaar' }, moments: { edges: [] } };
  vi.spyOn(twitch, 'gameId').mockResolvedValue('bazaar');
  vi.spyOn(twitch, 'helix').mockImplementation(async endpoint => {
    if (endpoint === 'users') return { data: [{ id: '1', login: 'creator' }] };
    if (endpoint === 'streams') return { data: [] };
    return { data: [{ id: '100', created_at: video.publishedAt }], pagination: {} };
  });
  vi.spyOn(twitch, 'gql').mockImplementation(async () => ({ video }));
  await twitch.catalog(1);
  expect(await one(env, "SELECT published_at,recorded_at FROM vods WHERE source_id='100'")).toEqual({ published_at: '2025-01-01T00:00:00.000Z', recorded_at: '2025-01-01T00:00:00.000Z' });
  expect(await one(env, "SELECT old_templates FROM vod_processing_context WHERE source_id='100'")).toEqual({ old_templates: 1 });
  video.publishedAt = '2026-01-01T00:00:00Z';
  await twitch.catalog(1);
  expect(await one(env, "SELECT recorded_at FROM vods WHERE source_id='100'")).toEqual({ recorded_at: '2026-01-01T00:00:00.000Z' });
  expect(await one(env, "SELECT old_templates FROM vod_processing_context WHERE source_id='100'")).toEqual({ old_templates: 0 });
  expect(await rows(env, 'SELECT id FROM vods')).toHaveLength(1);
});
