import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { atomic } from '../atomic';
import { one, rows, statement } from '../http';
import { plan, vodDetails } from '../processing';
import { claimJob, enqueueJob, saveVideo, updateAccount, upsertAccount } from '../platforms';

const channel = `UC${'A'.repeat(22)}`;
const videoId = '12345678901';
let account: Record<string, any>;

beforeEach(async () => {
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'adversarial','[0,0,1,1]')").run();
  account = await upsertAccount(env, {source: 'youtube', source_id: channel, display_name: 'Example', processing_enabled: true});
});

function video(duration = 100) {
  return {source: 'youtube', source_id: videoId, title: 'Example footage', duration_seconds: duration, bazaar_chapters: [0, duration], template_version: 'current'};
}

async function unplannedVideo() {
  return (await one(env, `INSERT INTO vods(source,source_id,platform_account_id,title,duration_seconds,bazaar_chapters,ready_for_processing,template_version)
    VALUES('youtube',?,?,'Example footage',100,'[0,100]',1,'current') RETURNING *`, videoId, account.id))!;
}

/** Interleave a real D1 mutation immediately after a planner reads its snapshot. */
function afterPlanningSnapshot(action: () => Promise<unknown>) {
  let fired = false;
  const wrap = (prepared: D1PreparedStatement): D1PreparedStatement => new Proxy(prepared, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      if (property === 'first') return async (column?: string) => {
        const snapshot = column === undefined ? await target.first() : await target.first(column);
        if (!fired) { fired = true; await action(); }
        return snapshot;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const prepared = target.prepare(sql);
        return sql === 'SELECT * FROM vod_processing_context WHERE id=?' ? wrap(prepared) : prepared;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {runtime: {...env, DB: database}, fired: () => fired};
}

async function allowConflict(action: Promise<unknown>) {
  try { await action; } catch (error) { expect(error).toMatchObject({status: 409}); }
}

it('does not re-enable an account when discovery races an operator disabling it', async () => {
  await Promise.all([
    updateAccount(env, account.id, {processing_enabled: false}),
    upsertAccount(env, {source: 'youtube', source_id: channel, display_name: 'Discovered rename', processing_enabled: true, preserve_disabled: true}),
  ]);
  expect((await one(env, 'SELECT processing_enabled FROM platform_accounts WHERE id=?', account.id))!.processing_enabled).toBe(0);
  expect(await claimJob(env, {})).toEqual([]);
});

it('rolls back every mutation and removes assertion rows when a transaction fence fails', async () => {
  await expect(atomic(env,
    [{sql: 'SELECT 1', args: []}, {sql: 'SELECT 0', args: []}],
    [statement(env, "UPDATE platform_accounts SET display_name='Incorrect' WHERE id=?", account.id)],
  )).rejects.toMatchObject({status: 409});
  expect((await one(env, 'SELECT display_name FROM platform_accounts WHERE id=?', account.id))!.display_name).toBe('Example');
  expect(await rows(env, 'SELECT * FROM mutation_checks')).toEqual([]);
});

it('rejects an expired ingestion lease before changing video metadata', async () => {
  await statement(env,'DELETE FROM platform_ingestion_jobs').run();
  await enqueueJob(env,{source:'youtube',kind:'video',source_id:videoId,account_id:account.id});
  const [job] = await claimJob(env, {});
  await statement(env, "UPDATE platform_ingestion_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", job.id).run();
  await expect(saveVideo(env, {account_id: account.id, video: video(), job_id: job.id, lease_token: job.lease_token})).rejects.toMatchObject({status: 409});
  expect(await rows(env, 'SELECT * FROM vods')).toEqual([]);
});

it('does not plan stale time ranges when recataloging revises a video after the planning read', async () => {
  const vod = await unplannedVideo();
  const interleaved = afterPlanningSnapshot(() => saveVideo(env, {account_id: account.id, video: video(50), explicit_ranges: true}));
  await allowConflict(plan(interleaved.runtime, vod.id));
  expect(interleaved.fired()).toBe(true);
  expect((await one(env, 'SELECT duration_seconds FROM vods WHERE id=?', vod.id))!.duration_seconds).toBe(50);
  expect(await rows(env, 'SELECT start_seconds,end_seconds FROM chunks WHERE vod_id=? ORDER BY start_seconds', vod.id)).toEqual([{start_seconds: 0, end_seconds: 50}]);
});

it('does not create new work after an account is disabled between planning read and commit', async () => {
  const vod = await unplannedVideo();
  const interleaved = afterPlanningSnapshot(() => updateAccount(env, account.id, {processing_enabled: false}));
  await allowConflict(plan(interleaved.runtime, vod.id));
  expect(interleaved.fired()).toBe(true);
  expect(await rows(env, 'SELECT id FROM chunks WHERE vod_id=?', vod.id)).toEqual([]);
});

it('fences follow-up planning when a catalog lease expires after metadata has committed', async () => {
  await statement(env,'DELETE FROM platform_ingestion_jobs').run();
  await enqueueJob(env,{source:'youtube',kind:'video',source_id:videoId,account_id:account.id});
  const [job] = await claimJob(env, {});
  const interleaved = afterPlanningSnapshot(() => statement(env, "UPDATE platform_ingestion_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", job.id).run());
  await allowConflict(saveVideo(interleaved.runtime, {account_id: account.id, video: video(), job_id: job.id, lease_token: job.lease_token}));
  expect(interleaved.fired()).toBe(true);
  expect(await rows(env, 'SELECT id FROM vods')).toHaveLength(1);
  expect(await rows(env, 'SELECT id FROM chunks')).toEqual([]);
});

it('keeps equal Twitch and YouTube source IDs distinct in storage and processor lookup', async () => {
  await statement(env, "INSERT INTO streamers(id,login) VALUES(1,'same-id')").run();
  await statement(env, "INSERT INTO vods(source,source_id,streamer_id,title,duration_seconds,bazaar_chapters) VALUES('twitch',?,1,'Twitch version',100,'[0,100]')", videoId).run();
  const saved = await saveVideo(env, {account_id: account.id, video: video()});
  const twitch = await vodDetails(env, videoId, 'twitch');
  const youtube = await vodDetails(env, videoId, 'youtube');
  expect(twitch.title).toBe('Twitch version');
  expect(youtube.id).toBe(saved.id);
  expect(twitch.id).not.toBe(youtube.id);
});

it('rejects a conflicting video owner without replacing the account or title', async () => {
  const saved = await saveVideo(env, {account_id: account.id, video: video()});
  const other = await upsertAccount(env, {source: 'youtube', source_id: `UC${'B'.repeat(22)}`, display_name: 'Other', processing_enabled: false});
  await expect(saveVideo(env, {account_id: other.id, video: {...video(), title: 'Wrong owner'}})).rejects.toMatchObject({status: 409});
  expect(await one(env, 'SELECT platform_account_id,title FROM vods WHERE id=?', saved.id)).toEqual({platform_account_id: account.id, title: 'Example footage'});
  await expect(enqueueJob(env, {source: 'bilibili', kind: 'account', source_id: '123', account_id: account.id})).rejects.toMatchObject({status: 409});
});

it('does not expose platform lease, secret, assertion or account tables publicly', async () => {
  for (const table of ['platform_accounts', 'platform_ingestion_jobs', 'youtube_websub_subscriptions', 'youtube_websub_deliveries', 'mutation_checks', 'matchup_review_events']) {
    const response = await SELF.fetch(`http://local/rest/v1/${table}?select=*`);
    expect(response.status, table).toBe(401);
  }
});
