import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { plan } from "../processing";
import { Twitch } from "../twitch";
import { one, rows } from "../http";
import { dispatchCatalog, requestCatalog, runCatalogBatch, type CatalogBatch } from "../catalog-work";

beforeEach(async () => {
  await env.DB.prepare("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'catalog','[0,0,1,1]')").run();
  await env.DB.prepare("INSERT INTO streamers(id,login,eventsub_subscription_id) VALUES(1,'creator','sub')").run();
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const send = vi.fn(async (job: { type: string; id?: number }) => {
    if (job.type === "plan") await plan(env, job.id!);
  });
  const runtime = { ...env, JOBS: { send } as unknown as Queue };
  const twitch = new Twitch(runtime);
  const video = { id: '100', title: 'The Bazaar', lengthSeconds: 3600,
    publishedAt: '2026-10-17T00:00:00Z', game: { id: 'bazaar' }, moments: { edges: [] } };
  vi.spyOn(twitch, 'gameId').mockResolvedValue('bazaar');
  const helix = vi.spyOn(twitch, 'helix').mockImplementation(async endpoint => {
    if (endpoint === 'users') return { data: [{ id: '1', login: 'creator' }] };
    if (endpoint === 'streams') return { data: [] };
    if (endpoint === 'videos') return { data: [{ id: '100' }], pagination: {} };
    throw new Error('Unexpected endpoint');
  });
  vi.spyOn(twitch, 'gql').mockImplementation(async () => ({ video }));
  return { twitch, video, send, runtime, helix };
}
async function chunks() {
  return rows(env, 'SELECT id,start_seconds,end_seconds,status FROM chunks ORDER BY start_seconds');
}

it('plans a new VOD and leaves completed chunks identical on repeated catalogs', async () => {
  const { twitch, send } = fixture();
  await twitch.catalog(1);
  expect(await chunks()).toHaveLength(2);
  await env.DB.prepare("UPDATE chunks SET status='completed'").run();
  const before = await chunks();
  send.mockClear();
  await twitch.catalog(1);
  await twitch.catalog(1);
  expect(await chunks()).toEqual(before);
  expect((await one(env, 'SELECT status FROM vods'))!.status).toBe('completed');
  expect(send).not.toHaveBeenCalled();
});

it('plans only the new tail when a previously complete VOD grows', async () => {
  const { twitch, video, send } = fixture();
  await twitch.catalog(1);
  await env.DB.prepare("UPDATE chunks SET status='completed'").run();
  const before = await chunks();
  video.lengthSeconds = 4000;
  await twitch.catalog(1);
  const after = await chunks();
  expect(after.slice(0, 2)).toEqual(before);
  expect(after[2]).toMatchObject({ start_seconds: 3600, end_seconds: 4000, status: 'pending' });
  expect((await one(env, 'SELECT status FROM vods'))!.status).toBe('partial');
  expect(send).toHaveBeenCalledTimes(2);
});

it('does not leave a complete VOD partial after metadata shrinks its eligible range', async () => {
  const { twitch, video } = fixture();
  await twitch.catalog(1);
  await env.DB.prepare("UPDATE chunks SET status='completed'").run();
  const before = await chunks();
  video.lengthSeconds = 3500;
  await twitch.catalog(1);
  expect(await chunks()).toEqual(before);
  expect((await one(env, 'SELECT status FROM vods'))!.status).toBe('completed');
});

it('repairs missing coverage even when the VOD metadata is unchanged', async () => {
  const { twitch } = fixture();
  await twitch.catalog(1);
  await env.DB.prepare("DELETE FROM chunks WHERE start_seconds=1800").run();
  await twitch.catalog(1);
  expect((await chunks()).map(c => [c.start_seconds, c.end_seconds])).toEqual([[0, 1800], [1800, 3600]]);
});

it('preserves processing disables and plans after re-enablement', async () => {
  const { twitch, send } = fixture();
  await env.DB.prepare("UPDATE streamers SET processing_enabled=0").run();
  await twitch.catalog(1);
  expect(await chunks()).toEqual([]);
  await env.DB.prepare("UPDATE streamers SET processing_enabled=1").run();
  await twitch.catalog(1);
  expect(await chunks()).toHaveLength(2);
  expect(send).toHaveBeenCalledTimes(1);
});

it('keeps dry runs free of catalog and chunk mutations', async () => {
  const { twitch, send } = fixture();
  const result = await twitch.catalog(1, undefined, true);
  expect(result.vodsWouldBeInserted).toBe(1);
  expect(await rows(env, 'SELECT id FROM vods')).toEqual([]);
  expect(await chunks()).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});

it('recovers a failed planning handoff after committing VOD metadata', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { twitch, runtime, send, video } = fixture();
  await twitch.catalog(1);
  await env.DB.prepare("UPDATE chunks SET status='completed'").run();
  video.lengthSeconds = 4000;
  send.mockClear();
  await requestCatalog(runtime, [{ id: 1 }]);
  await dispatchCatalog(runtime);
  const first = send.mock.calls[0][0] as CatalogBatch;
  send.mockRejectedValueOnce(new Error('Planning queue unavailable'));
  await runCatalogBatch(runtime, first, (id, checkpoint, cursor) => twitch.catalogWork(id, checkpoint, cursor));
  expect((await one(env, 'SELECT duration_seconds FROM vods'))!.duration_seconds).toBe(4000);
  expect(await chunks()).toHaveLength(2);
  await env.DB.prepare('UPDATE twitch_catalog_work SET due_at=0').run();
  await dispatchCatalog(runtime);
  const last = send.mock.calls.at(-1)![0] as CatalogBatch;
  await runCatalogBatch(runtime, last, (id, checkpoint, cursor) => twitch.catalogWork(id, checkpoint, cursor));
  expect(await chunks()).toHaveLength(3);
  expect((await one(env, 'SELECT state FROM twitch_catalog_work'))!.state).toBe('idle');
});

it('handles five archive pages using durable continuations without per-creator queue messages', async () => {
  const { twitch, helix, send } = fixture();
  await env.DB.prepare('UPDATE streamers SET processing_enabled=0').run();
  let page = 0;
  helix.mockImplementation(async endpoint => {
    if (endpoint === 'users') return { data: [{ id: '1', login: 'creator' }] };
    if (endpoint === 'streams') return { data: [] };
    return { data: [{ id: String(++page) }], pagination: { cursor: `page-${page}` } };
  });
  const checkpoint = vi.fn().mockResolvedValue(undefined);
  let cursor;
  do { cursor = await twitch.catalogWork(1, checkpoint, cursor); } while (cursor);
  expect(page).toBe(5);
  expect(checkpoint).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect((await one(env, 'SELECT num_vods FROM streamers'))!.num_vods).toBe(5);
});
