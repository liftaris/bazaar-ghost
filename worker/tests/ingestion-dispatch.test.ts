import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatchIngestion, finishIngestionRunner, hasDueIngestionDispatch, INGESTION_RUNNING_MINUTES, startIngestionRunner } from '../platform-ingestion-dispatch';
import { catalogRoute, claimJob, enqueueJob, finishJob, saveVideo, upsertAccount } from '../platforms';
import { handleJob, scheduled } from '../jobs';
import { one, rows, statement } from '../http';
import { claim, updateChunk } from '../processing';
import { publish, upload } from '../detections';

const runtime = () => ({ ...env, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'offline-dispatch-fixture' });
const owner = (ticket: string, run = '12345', attempt = '1') => ({ ticket_id: ticket, run_id: run, run_attempt: attempt, expected_environment: 'validation' });
const snapshot = () => one(env, 'SELECT * FROM platform_ingestion_dispatch');
async function candidate(index = 1, account?: string) {
  return enqueueJob(env, { source: 'youtube', kind: 'video', source_id: 'YT' + String(index).padStart(9, '0'), account_id: account });
}
async function queued() {
  await candidate();
  await dispatchIngestion(runtime());
  return (await snapshot())!.ticket_id as string;
}
async function expireDispatch() {
  await statement(env, "UPDATE platform_ingestion_dispatch SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
}
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'dispatch fixture','[0,0,1,1]')").run();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not initialize dispatch/discovery on an empty install or for future/disabled work', async () => {
  expect(await hasDueIngestionDispatch(runtime())).toBe(false);
  expect(await dispatchIngestion(runtime())).toEqual({ dispatched: false });
  expect(await snapshot()).toBeNull();
  expect(await rows(env, 'SELECT * FROM platform_ingestion_jobs')).toEqual([]);
  const account = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + 'a'.repeat(22), display_name: 'Disabled' });
  await candidate(1, account.id);
  const future = await candidate(2);
  await statement(env, "UPDATE platform_ingestion_jobs SET next_attempt_at='2999-01-01T00:00:00Z' WHERE id=?", future).run();
  expect(await hasDueIngestionDispatch(runtime())).toBe(false);
  expect(await dispatchIngestion(runtime())).toEqual({ dispatched: false });
  expect(await snapshot()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the existing provider cadence, including requested discovery, but never the auth minute or outbound-off path', async () => {
  await enqueueJob(env, { source: 'bilibili', kind: 'discovery', source_id: 'bazaar' });
  const send = vi.fn().mockResolvedValue(undefined), context = { ...runtime(), JOBS: { send } as unknown as Queue };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await scheduled({ cron: '* * * * *' } as ScheduledController, context);
  await scheduled({ cron: '*/3 * * * *' } as ScheduledController, { ...context, OUTBOUND_ENABLED: 'false' });
  expect(send).not.toHaveBeenCalled();
  await scheduled({ cron: '*/3 * * * *' } as ScheduledController, context);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'platform-ingestion' });
  await handleJob(context, send.mock.calls[0][0]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await rows(env, 'SELECT source,kind FROM platform_ingestion_jobs')).toEqual([{ source: 'bilibili', kind: 'discovery' }]);
  log.mockRestore();
});

it.each([['validation', 'migration/cloudflare'], ['dev', 'dev'], ['production', 'main']])('dispatches exact bounded %s workflow inputs and coalesces concurrent delivery', async (environment, branch) => {
  await candidate();
  const context = { ...runtime(), ENVIRONMENT: environment };
  const outcomes = await Promise.all([dispatchIngestion(context), dispatchIngestion(context), dispatchIngestion(context)]);
  expect(outcomes.filter(result => result.dispatched)).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('https://api.github.com/repos/liftaris/bazaar-ghost/actions/workflows/ingest-platforms.yml/dispatches');
  const data = JSON.parse(init!.body as string);
  expect(data).toEqual({ ref: branch, inputs: { environment, dispatch_ticket: (await snapshot())!.ticket_id,
    source: 'none', identity: '', discovery: 'false', dispatch: 'true', limit: '30', seconds: '1200' } });
  expect((await snapshot())!.outcome).toBe('accepted');
  expect(await hasDueIngestionDispatch(context)).toBe(false);
});

it('rechecks account eligibility after the scheduling read and refuses unknown environments/missing credentials', async () => {
  const account = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + 'a'.repeat(22), display_name: 'Creator', processing_enabled: true });
  expect(await hasDueIngestionDispatch(runtime())).toBe(true);
  await statement(env, 'UPDATE platform_accounts SET processing_enabled=0 WHERE id=?', account.id).run();
  expect(await dispatchIngestion(runtime())).toEqual({ dispatched: false });
  await expect(dispatchIngestion({ ...runtime(), ENVIRONMENT: 'unexpected' })).rejects.toMatchObject({ status: 400 });
  await expect(dispatchIngestion({ ...runtime(), OUTBOUND_ENABLED: 'false' })).rejects.toMatchObject({ status: 503 });
  await expect(dispatchIngestion({ ...runtime(), GITHUB_TOKEN: '' })).rejects.toMatchObject({ status: 503 });
  expect(await snapshot()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['transport', 'unexpected200'])('retains %s ambiguity and waits before dispatching again', async mode => {
  await candidate();
  vi.mocked(fetch).mockImplementation(async () => { if (mode === 'transport') throw new Error('private upstream URL/token'); return new Response(null, { status: 200 }); });
  await expect(dispatchIngestion(runtime())).rejects.toMatchObject({ status: 503, message: 'Ingestion workflow delivery is unconfirmed; retry is scheduled' });
  const before = (await snapshot())!;
  expect(before.state).toBe('queued'); expect(before.outcome).toBe('delivery_unconfirmed'); expect(before.delivery_failures).toBe(1);
  expect(JSON.stringify(before)).not.toContain('private');
  expect(await dispatchIngestion(runtime())).toEqual({ dispatched: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await startIngestionRunner(runtime(), owner(before.ticket_id))).toEqual({ started: true });
  expect((await snapshot())!.delivery_failures).toBe(0);
});

it('caps repeated delivery backoff and replaces expired tickets using database time', async () => {
  await candidate();
  vi.mocked(fetch).mockRejectedValue(new Error('offline failure'));
  await expect(dispatchIngestion(runtime())).rejects.toMatchObject({ status: 503 });
  const first = (await snapshot())!.ticket_id;
  await expireDispatch();
  await expect(startIngestionRunner(runtime(), owner(first))).resolves.toEqual({ started: false });
  await expect(dispatchIngestion(runtime())).rejects.toMatchObject({ status: 503 });
  const next = (await snapshot())!;
  expect(next.ticket_id).not.toBe(first); expect(next.delivery_failures).toBe(2);
  expect((await one(env, "SELECT round((julianday(next_attempt_at)-julianday('now'))*86400) AS seconds FROM platform_ingestion_dispatch"))!.seconds).toBeGreaterThanOrEqual(599);
  await expireDispatch();
  await statement(env, 'UPDATE platform_ingestion_dispatch SET delivery_failures=10').run();
  await expect(dispatchIngestion(runtime())).rejects.toMatchObject({ status: 503 });
  expect((await snapshot())!.delivery_failures).toBe(10);
  const seconds = (await one(env, "SELECT round((julianday(next_attempt_at)-julianday('now'))*86400) AS seconds FROM platform_ingestion_dispatch"))!.seconds;
  expect(seconds).toBeGreaterThanOrEqual(3599); expect(seconds).toBeLessThanOrEqual(3600);
});

it.each(['accepted', 'lost'])('does not downgrade a fast runner when its dispatch response is %s', async outcome => {
  await candidate();
  let started: any;
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const ticket = JSON.parse(init!.body as string).inputs.dispatch_ticket;
    expect(await startIngestionRunner(runtime(), owner(ticket))).toEqual({ started: true });
    started = await snapshot();
    if (outcome === 'lost') throw new Error('response lost');
    return new Response(null, { status: 204 });
  });
  if (outcome === 'lost') await expect(dispatchIngestion(runtime())).rejects.toMatchObject({ status: 503 });
  else expect(await dispatchIngestion(runtime())).toEqual({ dispatched: true });
  expect(await snapshot()).toEqual(started);
});

it('rejects stale response writes after a ticket replacement', async () => {
  await candidate();
  let replacement: any;
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await expireDispatch();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await dispatchIngestion(runtime());
    replacement = await snapshot();
    return new Response(null, { status: 204 });
  });
  await dispatchIngestion(runtime());
  expect(await snapshot()).toEqual(replacement);
});

it('binds start to a run/attempt, keeps retry deadline fixed, and rejects expired/invalid/cross-environment starts', async () => {
  const ticket = await queued();
  for (const input of [{ source: 'youtube' }, { identity: '@caller' }, { identity: 0 }, { discovery: true }, { discovery: 'true' }])
    await expect(startIngestionRunner(runtime(), { ...owner(ticket), ...input })).rejects.toMatchObject({ status: 400 });
  await expect(startIngestionRunner(runtime(), { ...owner(ticket), expected_environment: 'production' })).rejects.toMatchObject({ status: 400 });
  await expect(startIngestionRunner(runtime(), { ...owner(ticket), run_attempt: '0' })).rejects.toMatchObject({ status: 400 });
  expect(await startIngestionRunner(runtime(), owner(ticket))).toEqual({ started: true });
  const started = await snapshot();
  expect(INGESTION_RUNNING_MINUTES).toBe(40);
  expect(await startIngestionRunner(runtime(), owner(ticket))).toEqual({ started: true });
  expect(await snapshot()).toEqual(started);
  await expect(startIngestionRunner(runtime(), owner(ticket, 'different'))).rejects.toMatchObject({ status: 400 });
  await expireDispatch();
  expect(await startIngestionRunner(runtime(), owner(ticket))).toEqual({ started: false });
});

it('makes finish response retries read-only while fencing different outcomes and replacement owners', async () => {
  const ticket = await queued();
  await startIngestionRunner(runtime(), owner(ticket));
  expect(await startIngestionRunner(runtime(), owner(ticket, '12346'))).toEqual({ started: false });
  expect(await startIngestionRunner(runtime(), owner(ticket, '12345', '2'))).toEqual({ started: false });
  const input = { ...owner(ticket), outcome: 'success' };
  expect(await finishIngestionRunner(runtime(), input)).toEqual({ finished: true });
  const finished = await snapshot();
  expect(await finishIngestionRunner(runtime(), input)).toEqual({ finished: true });
  expect(await snapshot()).toEqual(finished);
  expect(await finishIngestionRunner(runtime(), { ...input, outcome: 'failure' })).toEqual({ finished: false });
  await dispatchIngestion(runtime());
  const replacement = await snapshot();
  expect(await startIngestionRunner(runtime(), owner(ticket))).toEqual({ started: false });
  expect(await finishIngestionRunner(runtime(), input)).toEqual({ finished: false });
  expect(await snapshot()).toEqual(replacement);
});

it('reclaims lost runners without stealing their unexpired job leases or accepting stale claims/finishes', async () => {
  const ticket = await queued();
  await startIngestionRunner(runtime(), owner(ticket));
  const first = (await claimJob(runtime(), { ...owner(ticket), include_discovery: true }))[0];
  await candidate(2);
  await expireDispatch();
  await expect(claimJob(runtime(), owner(ticket))).rejects.toMatchObject({ status: 409 });
  expect(await finishIngestionRunner(runtime(), { ...owner(ticket), outcome: 'success' })).toEqual({ finished: false });
  await dispatchIngestion(runtime());
  const current = (await snapshot())!.ticket_id;
  await startIngestionRunner(runtime(), owner(current, '12346'));
  const second = (await claimJob(runtime(), owner(current, '12346')))[0];
  expect(second.id).not.toBe(first.id);
  expect(await claimJob(runtime(), owner(current, '12346'))).toEqual([]);
  await statement(env, "UPDATE platform_ingestion_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", first.id).run();
  const fresh = (await claimJob(runtime(), owner(current, '12346')))[0];
  expect(fresh.id).toBe(first.id); expect(fresh.lease_token).not.toBe(first.lease_token);
  expect(await finishJob(env, { id: first.id, token: first.lease_token, status: 'completed' })).toBe(false);
});

it('requires catalog authentication for lifecycle callbacks', async () => {
  for (const path of ['runner/start', 'runner/finish']) {
    const response = await SELF.fetch('http://local/api/catalog/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.PROCESSOR_KEY}` }, body: '{}' });
    expect(response.status).toBe(401);
  }
  expect((await SELF.fetch('http://local/rest/v1/platform_ingestion_dispatch')).status).toBe(401);
});

it('connects a requested candidate through catalog planning, workflow dispatch, chunk completion and scheduled tail continuation', async () => {
  const ticket = await queued();
  await startIngestionRunner(runtime(), owner(ticket));
  const job = (await claimJob(runtime(), owner(ticket)))[0];
  const fence = { job_id: job.id, lease_token: job.lease_token };
  const account = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + 'a'.repeat(22), display_name: 'Verified owner', processing_enabled: true, ...fence });
  await catalogRoute(new Request('http://local/api/catalog/jobs/attach-account', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: job.id, token: job.lease_token, account_id: account.id }) }), env);
  const video = await saveVideo(env, { account_id: account.id, video: { source: 'youtube', source_id: job.source_id,
    title: 'The Bazaar fixture', duration_seconds: 19800, bazaar_chapters: [0, 19800] }, ...fence });
  await finishJob(env, { id: job.id, token: job.lease_token, status: 'completed' });
  await finishIngestionRunner(runtime(), { ...owner(ticket), outcome: 'success' });
  // Keep the new account's next poll in the future; test OCR tail independently.
  await statement(env, "UPDATE platform_ingestion_jobs SET next_attempt_at='2999-01-01T00:00:00Z' WHERE kind='account'").run();
  const pending: any[] = [], context = { ...runtime(), JOBS: { send: async (value: any) => { pending.push(value); } } as unknown as Queue };
  let imagePath: string | undefined;
  for (const expected of [10, 1]) {
    await scheduled({ cron: '*/3 * * * *' } as ScheduledController, context);
    expect(pending).toEqual([{ type: 'process', id: video.id }]);
    await handleJob(context, pending.shift());
    const request = JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string);
    expect(request.inputs.source).toBe('youtube'); expect(request.ref).toBe('migration/cloudflare');
    const ids = JSON.parse(request.inputs.chunk_uuids); expect(ids).toHaveLength(expected);
    for (const id of ids) {
      const token = (await claim(env, id, request.inputs.queued_at)).claim_token!;
      if (!imagePath) {
        const image = await upload(env, new Request('http://local', { method: 'PUT', headers: { 'X-Claim-Token': token, 'Content-Type': 'image/jpeg' },
          body: new Uint8Array([255, 216, 255, 217]) }), id, 12, 'detection');
        imagePath = image.storage_path;
        await publish(env, id, token, [{ id: crypto.randomUUID(), username: 'Fixture opponent', confidence: 0.95, rank: 'gold',
          frame_time_seconds: 12, storage_path: imagePath }]);
      }
      await updateChunk(env, id, token, { status: 'completed', frames_processed: 900 });
    }
  }
  expect((await one(env, 'SELECT status FROM vods WHERE id=?', video.id))!.status).toBe('completed');
  expect(await rows(env, "SELECT status,count(*) AS n FROM chunks GROUP BY status")).toEqual([{ status: 'completed', n: 11 }]);
  expect((await one(env, 'SELECT source,source_id,username FROM video_detections'))).toEqual({ source: 'youtube', source_id: job.source_id, username: 'Fixture opponent' });
  expect((await SELF.fetch('http://local' + imagePath)).status).toBe(200);
});
