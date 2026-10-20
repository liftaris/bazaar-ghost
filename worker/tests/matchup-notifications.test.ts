import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeMatchups } from '../coalesce';
import { one, rows, statement } from '../http';
import { handleJob, processPending } from '../jobs';
import { MAX_DELIVERY_ATTEMPTS, notify } from '../notifications';
import { moveRecording } from '../sessions';

const prod = { ...env, ENVIRONMENT: 'production', OUTBOUND_ENABLED: 'true', PUBLIC_SITE_URL: 'https://site.example', DISCORD_BOT_TOKEN: 'x' } as Env;
const how = { actor: 'tester', evidence: 'same fight' };
let counter = 0, calls: { url: string; body: any }[] = [], respond: (url: string) => Response | Promise<Response>;

beforeEach(async () => {
  calls = [];
  respond = (url) => Response.json(url.endsWith('/messages') ? { id: 'm' } : { id: 'dm-channel' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return respond(url);
  });
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'example','Example Streamer')"),
    statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('yt','youtube','UCabcdefghijklmnopqrstuv','Channel One'),('bb','bilibili','12345','Channel Two')"),
    statement(env, "UPDATE platform_settings SET notifications_enabled=1 WHERE source='youtube'"),
    statement(env, "INSERT INTO notification_subscriptions(discord_user_id,username,username_lower,notify_type) VALUES('u1','Opponent','opponent','dm')"),
  ]);
});
afterEach(() => vi.unstubAllGlobals());

async function recording(source = 'youtube', notifications = 1) {
  const id = ++counter;
  await env.DB.batch([
    source === 'twitch' ? statement(env, 'INSERT INTO vods(id,streamer_id,source_id,duration_seconds,notifications_enabled) VALUES(?,1,?,900,?)', id, `t${id}`, notifications)
      : statement(env, 'INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,notifications_enabled) VALUES(?,?,?,?,900,?)', id, source,
        source === 'bilibili' ? `BV1${String(id).padStart(9, 'x')}` : `abcdefghi${String(id).padStart(2, '0')}`, source === 'bilibili' ? 'bb' : 'yt', notifications),
    statement(env, 'INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,?,0,900,0)', `chunk-${id}`, id),
  ]);
  return id;
}
async function detect(vod: number, seconds: number, name = 'Opponent') {
  await statement(env, 'INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,1)', name.toLowerCase()).run();
  await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,storage_path)
    VALUES(?,?,?,?,?,0.95,?,'/detections/x.jpg')`, crypto.randomUUID(), `chunk-${vod}`, vod, name, name.toLowerCase(), seconds).run();
  return (await one<{ id: number }>(env, 'SELECT id FROM matchup_anchors WHERE vod_id=? AND anchor_seconds=?', vod, seconds))!.id;
}
const outbox = () => rows(env, 'SELECT matchup_id,sent_at,suppressed_reason FROM notification_outbox_v2 ORDER BY matchup_id');
const due = () => env.DB.prepare("UPDATE notification_outbox_v2 SET eligible_at='2000-01-01T00:00:00.000Z' WHERE sent_at IS NULL").run();
const messages = () => calls.filter((c) => c.url.endsWith('/messages'));

it('queues one row per new Matchup after the grace window, and a coalesced second Recording adds none', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await detect(a, 100);
  const [row] = await rows(env, 'SELECT eligible_at FROM notification_outbox_v2');
  const wait = Date.parse(row.eligible_at) - Date.now();
  expect(wait).toBeGreaterThan(110_000);
  expect(wait).toBeLessThanOrEqual(120_500);
  await env.DB.prepare("INSERT INTO processing_config(key,value) VALUES('coalesce_grace_seconds','30')").run();
  await detect(b, 5);
  const grace = Date.parse((await one(env, 'SELECT eligible_at FROM notification_outbox_v2 WHERE matchup_id!=?', x))!.eligible_at) - Date.now();
  expect(grace).toBeLessThanOrEqual(30_500);
  const sess = (await one(env, 'SELECT session_id FROM vods WHERE id=?', a))!.session_id;
  await moveRecording(env, b, sess, 95, how);
  expect(await rows(env, 'SELECT matchup_id FROM notification_outbox_v2 WHERE sent_at IS NULL AND suppressed_reason IS NULL')).toEqual([{ matchup_id: x }]);
});

it('notifies once per Matchup, naming the Streamer and linking the site; later Sources do not notify again', async () => {
  const a = await recording('twitch');
  await env.DB.prepare("UPDATE platform_settings SET notifications_enabled=1 WHERE source='twitch'").run();
  const x = await detect(a, 100);
  await due();
  await notify(prod, x);
  expect(messages()).toHaveLength(1);
  expect(messages()[0].body.content).toContain('**Example Streamer** vs **Opponent**');
  expect(messages()[0].body.content).toContain(`https://site.example/matchups/${x}`);
  expect(await outbox()).toEqual([{ matchup_id: x, sent_at: expect.any(String), suppressed_reason: null }]);
  expect(await one(env, 'SELECT notification_count FROM notification_subscriptions')).toEqual({ notification_count: 1 });
  const b = await recording();
  const sess = (await one(env, 'SELECT session_id FROM vods WHERE id=?', a))!.session_id;
  await detect(b, 101);
  await moveRecording(env, b, sess, -1, how);
  await due();
  await handleJob({ ...prod, JOBS: { send: vi.fn() } as unknown as Queue }, { type: 'notify', id: x });
  await processPending({ ...prod, JOBS: { send: vi.fn() } as unknown as Queue });
  expect(messages()).toHaveLength(1);
});

it('names the publishing Channel when the Session has no Streamer', async () => {
  const x = await detect(await recording(), 100);
  await due();
  await notify(prod, x);
  expect(messages()[0].body.content).toContain('**Channel One** vs');
});

it('suppresses a merged loser when the winner already notified, and the winner when the loser did', async () => {
  const [a, b] = [await recording(), await recording()];
  const [x, y] = [await detect(a, 100), await detect(b, 500)];
  await due();
  await notify(prod, x);
  await mergeMatchups(env, x, y, how);
  expect(await outbox()).toEqual([
    { matchup_id: x, sent_at: expect.any(String), suppressed_reason: null },
    { matchup_id: y, sent_at: null, suppressed_reason: 'merged' }]);
  const [c, d] = [await recording(), await recording()];
  const [p, q] = [await detect(c, 100), await detect(d, 500)];
  await due();
  await notify(prod, q);
  await mergeMatchups(env, p, q, how);
  expect(await rows(env, 'SELECT matchup_id,sent_at IS NULL AS unsent,suppressed_reason FROM notification_outbox_v2 WHERE matchup_id IN(?,?) ORDER BY matchup_id', p, q))
    .toEqual([{ matchup_id: p, unsent: 1, suppressed_reason: 'merged' }, { matchup_id: q, unsent: 0, suppressed_reason: null }]);
  expect(messages()).toHaveLength(2);
  await due();
  await notify(prod, p);
  expect(messages()).toHaveLength(2);
});

it('retries a Discord 5xx and delivers exactly once', async () => {
  const x = await detect(await recording(), 100);
  await due();
  respond = (url) => url.endsWith('/messages') ? new Response('boom', { status: 502 }) : Response.json({ id: 'dm' });
  await notify(prod, x);
  expect(await rows(env, 'SELECT status,attempts FROM notification_deliveries_v2')).toEqual([{ status: 'failed', attempts: 1 }]);
  expect((await outbox())[0].sent_at).toBeNull();
  respond = (url) => Response.json(url.endsWith('/messages') ? { id: 'm' } : { id: 'dm' });
  await notify(prod, x);
  await notify(prod, x);
  expect(await rows(env, 'SELECT matchup_id,destination,status,attempts FROM notification_deliveries_v2')).toEqual([{ matchup_id: x, destination: 'dm:u1', status: 'sent', attempts: 2 }]);
  expect(messages()).toHaveLength(2);
  expect(messages()[0].body.nonce).toBe(messages()[1].body.nonce);
  expect((await outbox())[0].sent_at).toBeTruthy();
});

it('caps retries of failed deliveries and surfaces them', async () => {
  const x = await detect(await recording(), 100);
  await due();
  respond = (url) => url.endsWith('/messages') ? new Response('boom', { status: 500 }) : Response.json({ id: 'dm' });
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) await notify(prod, x);
  expect(messages()).toHaveLength(MAX_DELIVERY_ATTEMPTS);
  expect((await outbox())[0].sent_at).toBeTruthy();
  const problems = await (await SELF.fetch('http://local/api/admin/notifications/problems', { headers: { Authorization: `Bearer ${env.ADMIN_KEY}` } })).json<any[]>();
  expect(problems).toEqual([expect.objectContaining({ matchup_id: x, status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS })]);
});

it('surfaces an uncertain outcome and never resends it', async () => {
  const x = await detect(await recording(), 100);
  await due();
  respond = (url) => { if (url.endsWith('/messages')) throw new TypeError('network lost'); return Response.json({ id: 'dm' }); };
  await notify(prod, x);
  respond = (url) => Response.json(url.endsWith('/messages') ? { id: 'm' } : { id: 'dm' });
  await notify(prod, x);
  expect(messages()).toHaveLength(1);
  expect((await outbox())[0].sent_at).toBeTruthy();
  const problems = await (await SELF.fetch('http://local/api/admin/notifications/problems', { headers: { Authorization: `Bearer ${env.ADMIN_KEY}` } })).json<any[]>();
  expect(problems).toEqual([expect.objectContaining({ matchup_id: x, status: 'uncertain' })]);
});

it('treats a delivery interrupted mid-call as uncertain', async () => {
  const x = await detect(await recording(), 100);
  await due();
  await env.DB.prepare("INSERT INTO notification_deliveries_v2(matchup_id,subscription_id,destination,status,attempts) SELECT ?,id,'dm:u1','pending',1 FROM notification_subscriptions").bind(x).run();
  await notify(prod, x);
  expect(messages()).toHaveLength(0);
  expect(await rows(env, 'SELECT status FROM notification_deliveries_v2')).toEqual([{ status: 'uncertain' }]);
});

it('is silent for imports, disabled platforms and recordings flagged silent; Twitch is not special', async () => {
  const silent = await recording('youtube', 0), bili = await recording('bilibili');
  await detect(silent, 100); await detect(bili, 100);
  expect(await rows(env, 'SELECT * FROM notification_outbox_v2')).toEqual([]);
  await env.DB.prepare("UPDATE platform_settings SET notifications_enabled=0 WHERE source='twitch'").run();
  const tw = await recording('twitch');
  await detect(tw, 100);
  expect(await rows(env, 'SELECT * FROM notification_outbox_v2')).toEqual([]);
  await env.DB.prepare("UPDATE platform_settings SET notifications_enabled=1 WHERE source IN('twitch','bilibili')").run();
  await detect(tw, 200); await detect(bili, 200);
  expect(await rows(env, 'SELECT count(*) AS n FROM notification_outbox_v2')).toEqual([{ n: 2 }]);
  await env.DB.prepare('DELETE FROM detections WHERE vod_id=? AND frame_time_seconds=200').bind(bili).run();
  const again = await detect(bili, 200); // re-ingestion of an existing anchor founds no Matchup
  expect(await rows(env, 'SELECT count(*) AS n FROM notification_outbox_v2')).toEqual([{ n: 2 }]);
  expect(again).toBeGreaterThan(0);
});

it('does not notify for hidden Matchups, and a non-production environment never calls Discord', async () => {
  const x = await detect(await recording(), 100), y = await detect(await recording(), 200);
  await due();
  await env.DB.prepare("UPDATE matchups SET status='hidden' WHERE id=?").bind(x).run();
  await notify(prod, x);
  await notify({ ...prod, ENVIRONMENT: 'validation' } as Env, y);
  expect(calls).toHaveLength(0);
  expect(await outbox()).toEqual([
    { matchup_id: x, sent_at: null, suppressed_reason: 'hidden' },
    { matchup_id: y, sent_at: expect.any(String), suppressed_reason: null }]);
});
