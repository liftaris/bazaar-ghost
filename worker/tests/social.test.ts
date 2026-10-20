import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { clearChunk, publish, upload } from '../detections';
import { claim } from '../processing';
import { socialRoute } from '../social';
import { csrf, signature, type AuthEnv } from '../auth/security';
import { one, rows, statement } from '../http';

const socialEnv: AuthEnv = { ...env, PUBLIC_URL: 'http://localhost:8787', CORS_ORIGINS: 'http://localhost:3000',
  ENVIRONMENT: 'local', AUTH_ENABLED: 'true', AUTH_SECRET: 'test-social-secret-is-longer-than-thirty-two-characters' };
interface User { id: string; session: string; cookie: string; csrf: string }
let alice: User, bob: User, clip: number, detection: string;
async function seedUser(name: string): Promise<User> {
  const id = crypto.randomUUID(), session = crypto.randomUUID(), token = crypto.randomUUID(), date = new Date().toISOString();
  await statement(env, 'INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)', id, name, `${name}@private.invalid`, date, date).run();
  await statement(env, 'INSERT INTO user_accounts(id,providerId,accountId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)', crypto.randomUUID(), 'discord', `private-${id}`, id, date, date).run();
  await statement(env, 'INSERT INTO user_sessions(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)', session, id, token, new Date(Date.now() + 86_400_000).toISOString(), date, date).run();
  const hmac = await signature(socialEnv.AUTH_SECRET!, token), bytes = new Uint8Array(hmac.match(/../g)!.map(value => parseInt(value, 16)));
  return { id, session, cookie: `bazaarghost_session=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...bytes))}`)}`, csrf: await csrf(socialEnv, id, session) };
}
async function api(path: string, method = 'GET', data?: unknown, user?: User, options: { admin?: boolean; headers?: Record<string, string>; environment?: AuthEnv } = {}) {
  return socialRoute(new Request(`http://localhost:8787${path}`, { method, headers: {
    ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(user ? { Cookie: user.cookie, Origin: 'http://localhost:3000', 'X-CSRF-Token': user.csrf } : {}),
    ...(options.admin ? { Authorization: `Bearer ${env.ADMIN_KEY}` } : {}), ...options.headers,
  }, body: data === undefined ? undefined : JSON.stringify(data) }), options.environment || socialEnv);
}
async function addDetection(seconds: number, name = 'Opponent') {
  const id = crypto.randomUUID();
  await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,storage_path,igd)
    VALUES(?,'00000000-0000-4000-8000-000000000001',1,?,'opponent',0.95,?,'/detections/current.jpg',12)`, id, name, seconds).run();
  return id;
}
const likes = async (id = clip) => (await one<{ n: number }>(env, "SELECT count(DISTINCT l.user_id) AS n FROM matchup_likes l JOIN app_users u ON u.id=l.user_id WHERE l.matchup_id=? AND u.status='active'", id))!.n;
async function createComment(user = alice, text = 'Good game', id = crypto.randomUUID()) {
  const response = await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: text }, user);
  expect(response.status, await response.clone().text()).toBe(200);
  return id;
}
async function moderation(kind: string, target: string | number, status: string, id = crypto.randomUUID(), reason = 'Reviewed the report') {
  return api(`/api/admin/social/${kind}/${target}`, 'PUT', { request_id: id, status, reason }, undefined, { admin: true });
}
beforeEach(async () => {
  await env.DB.batch([statement(env, 'DELETE FROM app_users'), statement(env, 'DELETE FROM social_moderation_audit')]);
  await statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'test','[0,0,1,1]')").run();
  await statement(env, "INSERT INTO streamers(id,login) VALUES(1,'example')").run();
  await statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds) VALUES(1,1,'123',900)").run();
  await statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('00000000-0000-4000-8000-000000000001',1,0,900,0)").run();
  await statement(env, "INSERT INTO search_names(name,gram_count) VALUES('opponent',8)").run();
  detection = await addDetection(12);
  clip = (await one<{ id: number }>(env, 'SELECT id FROM matchup_anchors WHERE current_detection_id=?', detection))!.id;
  alice = await seedUser('Alice'); bob = await seedUser('Bob');
});

it('keeps bookmarks private to the caller and rejects anonymous or malformed requests', async () => {
  expect((await api(`/api/v1/matchups/${clip}/favorite`, 'PUT', undefined, alice)).status).toBe(200);
  const mine = await api(`/api/v1/matchups/${clip}/me`, 'GET', undefined, alice);
  expect(mine.headers.get('Cache-Control')).toBe('no-store');
  expect(JSON.stringify(await mine.json())).not.toMatch(/Alice|private-|@private|session|token/);
  expect((await api('/api/v1/me/favorites')).status).toBe(401);
  expect((await api('/api/v1/me/favorites?limit=1000', 'GET', undefined, alice)).status).toBe(400);
  expect((await api(`/api/v1/matchups/${clip}/me`)).status).toBe(401);
});

it('keeps likes as unique desired state and heart/favorite as one private bookmark', async () => {
  const path = `/api/v1/matchups/${clip}`;
  expect((await api(`${path}/like`, 'PUT', undefined, alice)).status).toBe(200);
  expect((await api(`${path}/like`, 'PUT', undefined, alice)).status).toBe(200);
  expect((await api(`${path}/like`, 'PUT', undefined, bob)).status).toBe(200);
  expect(await likes()).toBe(2);
  await api(`${path}/heart`, 'PUT', undefined, alice);
  await api(`${path}/favorite`, 'PUT', undefined, alice);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_favorites')).toEqual({ n: 1 });
  expect(await (await api(`${path}/me`, 'GET', undefined, alice)).json()).toEqual({ matchup_id: clip, liked: true, favorite: true });
  expect(await (await api(`${path}/me`, 'GET', undefined, bob)).json()).toEqual({ matchup_id: clip, liked: true, favorite: false });
  expect(await (await api('/api/v1/me/favorites', 'GET', undefined, bob)).json()).toMatchObject({ items: [] });
  expect(await (await api('/api/v1/me/favorites', 'GET', undefined, alice)).json()).toMatchObject({ items: [{ id: clip, sources: [expect.anything()], opponent: expect.anything() }], nextCursor: null });
  await api(`${path}/like`, 'DELETE', undefined, alice); await api(`${path}/like`, 'DELETE', undefined, alice);
  await api(`${path}/heart`, 'DELETE', undefined, alice);
  expect(await likes()).toBe(1);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_favorites')).toEqual({ n: 0 });
});

it('preserves social state across OCR deletion and reconnects only an exact anchor', async () => {
  const comment = await createComment();
  await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice);
  await api(`/api/v1/matchups/${clip}/favorite`, 'PUT', undefined, bob);
  await statement(env, 'DELETE FROM detections WHERE id=?', detection).run();
  expect(await likes()).toBe(1);
  const adjacent = await addDetection(14);
  expect(await one(env, 'SELECT current_detection_id FROM matchup_anchors WHERE id=?', clip)).toEqual({ current_detection_id: null });
  await expect(statement(env, 'UPDATE matchup_anchors SET current_detection_id=? WHERE id=?', adjacent, clip).run()).rejects.toThrow('exact anchor');
  const replacement = await addDetection(12, 'Corrected OCR');
  expect(await one(env, 'SELECT current_detection_id FROM matchup_anchors WHERE id=?', clip)).toEqual({ current_detection_id: replacement });
  expect(await likes()).toBe(1);
  expect(await one(env, 'SELECT id FROM matchup_comments WHERE id=?', comment)).toEqual({ id: comment });
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_favorites WHERE matchup_id=?', clip)).toEqual({ n: 1 });
});

it('normalizes Unicode, accepts full-length emoji and rejects controls, empty text and extra ownership fields', async () => {
  const id = await createComment(alice, ' Cafe\u0301\n<script>literal text</script> ');
  const body = await one(env, 'SELECT body FROM matchup_comments WHERE id=?', id);
  expect(body).toEqual({ body: 'Café\n<script>literal text</script>' });
  await createComment(bob, '😀'.repeat(2000));
  for (const text of ['', '  ', '\u200d', '\u200d \u200d', '\u0301', 'a\u0000b', 'a\u202Eb', 'a\ud800b', '😀'.repeat(2001)])
    expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id: crypto.randomUUID(), body: text }, alice)).status).toBe(400);
  expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id: crypto.randomUUID(), body: 'Text', author_id: bob.id }, alice)).status).toBe(400);
  const response = await api(`/api/v1/matchups/${clip}/comments`);
  const serialized = await response.text();
  expect(serialized).not.toMatch(/private-|@private|original_body_hash|emailVerified|session|token|reporter/);
  expect(serialized).toContain('Alice');
});

it('deduplicates simultaneous comment creation and rejects client UUID payload or owner reuse', async () => {
  const id = crypto.randomUUID();
  const results = await Promise.all([alice, alice].map(user => api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: 'Same text' }, user)));
  expect(results.map(response => response.status)).toEqual([200, 200]);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_comments WHERE id=?', id)).toEqual({ n: 1 });
  expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: 'Different text' }, alice)).status).toBe(409);
  expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: 'Same text' }, bob)).status).toBe(409);
});

it('enforces comment ownership and version CAS without reviving edits or deleted comments on retries', async () => {
  const id = await createComment();
  expect((await api(`/api/v1/comments/${id}`, 'PATCH', { version: 1, body: 'Stolen' }, bob)).status).toBe(404);
  expect((await api(`/api/v1/comments/${id}`, 'DELETE', { version: 1 }, bob)).status).toBe(404);
  const concurrent = await Promise.all(['Edit one', 'Edit two'].map(body => api(`/api/v1/comments/${id}`, 'PATCH', { version: 1, body }, alice)));
  expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
  expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: 'Good game' }, alice)).status).toBe(200);
  expect(await one(env, 'SELECT version,body FROM matchup_comments WHERE id=?', id)).toMatchObject({ version: 2, body: expect.stringMatching(/^Edit /) });
  const deletion = await Promise.all([1, 2].map(() => api(`/api/v1/comments/${id}`, 'DELETE', { version: 2 }, alice)));
  expect(deletion.map(response => response.status)).toEqual([200, 200]);
  expect((await api(`/api/v1/comments/${id}`, 'DELETE', { version: 2 }, alice)).status).toBe(200);
  expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: 'Good game' }, alice)).status).toBe(200);
  expect(await one(env, 'SELECT version,body,status FROM matchup_comments WHERE id=?', id)).toEqual({ version: 3, body: null, status: 'deleted' });
  expect(await (await api(`/api/v1/matchups/${clip}/comments`)).json()).toMatchObject({ items: [] });
  expect((await moderation('comments', id, 'visible')).status).toBe(404);
});

it('requires trusted Origin and matching CSRF even with a valid signed user session', async () => {
  const invalidHeaders: Record<string, string>[] = [{ Origin: 'https://attacker.invalid' }, { Origin: '' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': bob.csrf }];
  for (const headers of invalidHeaders)
    expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice, { headers })).status).toBe(403);
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT')).status).toBe(401);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_likes')).toEqual({ n: 0 });
});

it('fences a session revoked after authentication but before the D1 write transaction', async () => {
  let intercepted = false, socialWritePrepared = false;
  const database = new Proxy(env.DB, { get(target, prop) {
    if (prop === 'prepare') return (sql: string) => {
      if (sql.includes('INSERT INTO social_rate_limits')) socialWritePrepared = true;
      return target.prepare(sql);
    };
    if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (socialWritePrepared && !intercepted) { intercepted = true; await statement(env, 'DELETE FROM user_sessions WHERE id=?', alice.session).run(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const response = await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice, { environment: { ...socialEnv, DB: database } });
  expect(response.status).toBe(409);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_likes')).toEqual({ n: 0 });
  expect(await one(env, 'SELECT count(*) AS n FROM social_rate_limits')).toEqual({ n: 0 });
});

it('limits mutation throughput transactionally and bounds counter storage per user', async () => {
  await statement(env, "INSERT INTO social_rate_limits(user_id,category,window_start,count) VALUES(?,'reaction',CAST(unixepoch()/60 AS INTEGER),120)", alice.id).run();
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice)).status).toBe(429);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_likes')).toEqual({ n: 0 });
  await statement(env, 'UPDATE social_rate_limits SET window_start=window_start-1 WHERE user_id=?', alice.id).run();
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice)).status).toBe(200);
  expect(await rows(env, 'SELECT count FROM social_rate_limits WHERE user_id=?', alice.id)).toEqual([{ count: 1 }]);
});

it('paginates comments and private favorites without exposing hidden rows', async () => {
  const extra: number[] = [];
  for (const time of [20, 30]) extra.push((await one<{ id: number }>(env, 'SELECT id FROM matchup_anchors WHERE current_detection_id=?', await addDetection(time)))!.id);
  for (const id of [clip, ...extra]) await api(`/api/v1/matchups/${id}/favorite`, 'PUT', undefined, alice);
  const first = await (await api('/api/v1/me/favorites?limit=2', 'GET', undefined, alice)).json<{ nextCursor: string; items: { id: number }[] }>();
  expect(first.items.map(item => item.id)).toEqual([extra[1], extra[0]]);
  expect(await (await api(`/api/v1/me/favorites?cursor=${first.nextCursor}`, 'GET', undefined, alice)).json()).toMatchObject({ items: [{ id: clip }], nextCursor: null });
  await createComment(); await createComment(bob, 'Second');
  const comments = await (await api(`/api/v1/matchups/${clip}/comments?limit=1`)).json<{ items: unknown[]; next_after: number }>();
  expect(comments.items).toHaveLength(1);
  expect(await (await api(`/api/v1/matchups/${clip}/comments?after=${comments.next_after}`)).json()).toMatchObject({ items: [expect.anything()] });
  expect((await moderation('matchups', clip, 'hidden')).status).toBe(200);
  expect((await api(`/api/v1/matchups/${clip}/comments`)).status).toBe(404);
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, bob)).status).toBe(409);
  const favorites = await (await api('/api/v1/me/favorites', 'GET', undefined, alice)).json<{ items: { id: number }[] }>();
  expect(favorites.items.map(item => item.id)).toEqual([extra[1], extra[0]]);
  expect((await moderation('matchups', clip, 'visible')).status).toBe(200);
  expect((await (await api('/api/v1/me/favorites', 'GET', undefined, alice)).json<{ items: { id: number }[] }>()).items.map(item => item.id)).toContain(clip);
});

it('separates admin moderation from cookies, hides comments and records retry-safe decisions', async () => {
  const id = await createComment(), requestId = crypto.randomUUID();
  expect((await api(`/api/admin/social/comments/${id}`, 'PUT', { request_id: requestId, status: 'hidden', reason: 'Reason' }, alice)).status).toBe(401);
  expect((await api(`/api/v1/comments/${id}`)).status).toBe(200);
  expect((await moderation('comments', id, 'hidden', requestId)).status).toBe(200);
  expect((await api(`/api/v1/comments/${id}`)).status).toBe(404);
  expect(await (await api(`/api/v1/matchups/${clip}/comments`)).json()).toMatchObject({ items: [] });
  expect((await api(`/api/v1/comments/${id}`, 'PATCH', { version: 2, body: 'Evade moderation' }, alice)).status).toBe(409);
  expect((await moderation('comments', id, 'visible')).status).toBe(200);
  expect((await moderation('comments', id, 'hidden', requestId)).status).toBe(200);
  expect(await one(env, 'SELECT status,version FROM matchup_comments WHERE id=?', id)).toEqual({ status: 'visible', version: 3 });
  expect((await moderation('comments', id, 'visible', requestId)).status).toBe(409);
  expect(await one(env, 'SELECT count(*) AS n FROM social_moderation_audit')).toEqual({ n: 2 });
  expect((await api('/api/admin/social/audit', 'GET', undefined, alice)).status).toBe(401);
  const audit = await api('/api/admin/social/audit', 'GET', undefined, undefined, { admin: true });
  expect(audit.status).toBe(200); expect(await audit.text()).not.toMatch(/@private|token|session/);
});

it('queues private reports with idempotency, audited resolution and no public report metadata', async () => {
  const comment = await createComment(), id = crypto.randomUUID(), payload = { id, comment_id: comment, reason: 'Please review this' };
  expect((await api('/api/v1/reports', 'POST', payload, bob)).status).toBe(200);
  expect((await api('/api/v1/reports', 'POST', payload, bob)).status).toBe(200);
  const canonical = await api('/api/v1/reports', 'POST', { ...payload, id: crypto.randomUUID() }, bob);
  expect(await canonical.json()).toEqual({ id, status: 'open' });
  expect(await one(env, 'SELECT count(*) AS n FROM social_reports')).toEqual({ n: 1 });
  expect((await api('/api/v1/reports', 'POST', { ...payload, reason: 'Changed' }, bob)).status).toBe(409);
  expect((await api('/api/v1/reports', 'POST', payload, alice)).status).toBe(409);
  expect((await api('/api/admin/social/reports', 'GET', undefined, bob)).status).toBe(401);
  expect(await (await api('/api/admin/social/reports', 'GET', undefined, undefined, { admin: true })).json()).toMatchObject({ items: [{ id, reporter_id: bob.id }] });
  expect((await moderation('reports', id, 'resolved')).status).toBe(200);
  expect(await (await api('/api/admin/social/reports', 'GET', undefined, undefined, { admin: true })).json()).toMatchObject({ items: [] });
  expect(await (await api(`/api/v1/matchups/${clip}/comments`)).text()).not.toContain('Please review this');
});

it('suspends users with immediate session revocation and restores visibility without reviving sessions', async () => {
  const id = await createComment(); await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice);
  expect((await moderation('users', alice.id, 'suspended')).status).toBe(200);
  expect(await one(env, 'SELECT count(*) AS n FROM user_sessions WHERE userId=?', alice.id)).toEqual({ n: 0 });
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice)).status).toBe(401);
  expect(await (await api(`/api/v1/matchups/${clip}/comments`)).json()).toMatchObject({ items: [] });
  expect(await likes()).toBe(0);
  expect((await moderation('users', alice.id, 'active')).status).toBe(200);
  expect(await (await api(`/api/v1/matchups/${clip}/comments`)).json()).toMatchObject({ items: [{ id }] });
  expect((await api(`/api/v1/matchups/${clip}/me`, 'GET', undefined, alice)).status).toBe(401);
});

it('deleting one account cascades only its social data and leaves shared clips and other comments', async () => {
  const aliceComment = await createComment(), bobComment = await createComment(bob, 'Other user comment');
  await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice);
  await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, bob);
  await api(`/api/v1/matchups/${clip}/favorite`, 'PUT', undefined, alice);
  await api('/api/v1/reports', 'POST', { id: crypto.randomUUID(), matchup_id: clip, reason: 'Review' }, alice);
  await statement(env, 'DELETE FROM app_users WHERE id=?', alice.id).run();
  expect(await one(env, 'SELECT id FROM matchup_comments WHERE id=?', aliceComment)).toBeNull();
  expect(await one(env, 'SELECT id FROM matchup_comments WHERE id=?', bobComment)).toEqual({ id: bobComment });
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_favorites')).toEqual({ n: 0 });
  expect(await one(env, 'SELECT count(*) AS n FROM social_reports')).toEqual({ n: 0 });
  expect(await likes()).toBe(1);
});

it('fences clip moderation that races an authenticated comment write', async () => {
  let prepared = false, hidden = false;
  const database = new Proxy(env.DB, { get(target, prop) {
    if (prop === 'prepare') return (sql: string) => {
      if (sql.includes('INSERT INTO social_rate_limits')) prepared = true;
      return target.prepare(sql);
    };
    if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (prepared && !hidden) { hidden = true; await statement(env, "UPDATE matchups SET status='hidden' WHERE id=?", clip).run(); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const response = await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id: crypto.randomUUID(), body: 'Racing comment' }, alice,
    { environment: { ...socialEnv, DB: database } });
  expect(response.status).toBe(409);
  expect(await one(env, 'SELECT count(*) AS n FROM matchup_comments')).toEqual({ n: 0 });
  expect(await one(env, 'SELECT count(*) AS n FROM social_rate_limits')).toEqual({ n: 0 });
});

it('keeps concurrent moderation retries from duplicating audit or overwriting a later decision', async () => {
  const id = crypto.randomUUID();
  const responses = await Promise.all([moderation('matchups', clip, 'hidden', id), moderation('matchups', clip, 'hidden', id)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(await one(env, 'SELECT count(*) AS n FROM social_moderation_audit WHERE request_id=?', id)).toEqual({ n: 1 });
  await moderation('matchups', clip, 'visible');
  await moderation('matchups', clip, 'hidden', id);
  expect(await one(env, 'SELECT status FROM matchups WHERE id=?', clip)).toEqual({ status: 'visible' });
});

it('preserves a hidden anchor through replacement and refuses low-confidence attachment', async () => {
  await moderation('matchups', clip, 'hidden');
  await statement(env, 'DELETE FROM detections WHERE id=?', detection).run();
  const replacement = await addDetection(12);
  expect(await one(env, 'SELECT m.status,a.current_detection_id FROM matchup_anchors a JOIN matchups m ON m.id=a.matchup_id WHERE a.id=?', clip)).toEqual({ status: 'hidden', current_detection_id: replacement });
  await statement(env, 'UPDATE detections SET confidence=0.6 WHERE id=?', replacement).run();
  expect(await one(env, 'SELECT m.status,a.current_detection_id FROM matchup_anchors a JOIN matchups m ON m.id=a.matchup_id WHERE a.id=?', clip)).toEqual({ status: 'hidden', current_detection_id: null });
  await statement(env, 'UPDATE detections SET confidence=0.95 WHERE id=?', replacement).run();
  expect(await one(env, 'SELECT m.status,a.current_detection_id FROM matchup_anchors a JOIN matchups m ON m.id=a.matchup_id WHERE a.id=?', clip)).toEqual({ status: 'hidden', current_detection_id: replacement });
  await expect(statement(env, 'UPDATE matchup_anchors SET anchor_seconds=13 WHERE id=?', clip).run()).rejects.toThrow('immutable');
});

it('keeps a shared clip through the real processor claim, screenshot clear, upload and publish retry', async () => {
  const chunk = '00000000-0000-4000-8000-000000000001';
  const comment = await createComment();
  await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice);
  await api(`/api/v1/matchups/${clip}/favorite`, 'PUT', undefined, bob);
  await statement(env, 'UPDATE vods SET ready_for_processing=1 WHERE id=1').run();
  await env.DETECTIONS.put('current.jpg', new Uint8Array([255, 216, 255, 217]));
  const lease = await claim(env, chunk);
  expect(lease.claimed).toBe(true);
  const token = lease.claim_token!;
  expect(await clearChunk(env, chunk, token)).toEqual({ deleted: 1 });
  expect(await env.DETECTIONS.head('current.jpg')).toBeNull();
  expect(await one(env, 'SELECT current_detection_id FROM matchup_anchors WHERE id=?', clip)).toEqual({ current_detection_id: null });
  const image = await upload(env, new Request('http://localhost/image', { method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg', 'X-Claim-Token': token }, body: new Uint8Array([255, 216, 255, 217]) }), chunk, 12, 'detection');
  const replacement = crypto.randomUUID();
  expect(await publish(env, chunk, token, [{ id: replacement, frame_time_seconds: 12,
    username: 'New OCR reading', confidence: 0.96, rank: 'gold', igd: 13, ...image }])).toEqual({ published: 1 });
  expect(await one(env, 'SELECT id,current_detection_id FROM matchup_anchors WHERE id=?', clip)).toEqual({ id: clip, current_detection_id: replacement });
  expect(await one(env, 'SELECT id FROM matchup_comments WHERE id=?', comment)).toEqual({ id: comment });
  expect(await (await api(`/api/v1/matchups/${clip}/me`, 'GET', undefined, bob)).json()).toMatchObject({ favorite: true });
  expect(await one(env, 'SELECT igd,storage_path FROM detections WHERE id=?', replacement)).toEqual({ igd: 13, storage_path: image.storage_path });
});

it('addresses social records by canonical Matchup ID', async () => {
  expect(await one(env, 'SELECT id,status,merged_into,origin FROM matchups WHERE id=?', clip)).toEqual({ id: clip, status: 'visible', merged_into: null, origin: 'auto' });
  expect(await one(env, 'SELECT matchup_id FROM matchup_anchors WHERE id=?', clip)).toEqual({ matchup_id: clip });
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice)).status).toBe(200);
  expect((await api(`/api/v1/matchups/${clip}/favorite`, 'PUT', undefined, bob)).status).toBe(200);
  expect(await likes()).toBe(1);
  expect(await (await api(`/api/v1/matchups/${clip}/me`, 'GET', undefined, bob)).json()).toEqual({ matchup_id: clip, liked: false, favorite: true });
  const id = crypto.randomUUID();
  expect((await api(`/api/v1/matchups/${clip}/comments`, 'POST', { id, body: 'Via matchup' }, alice)).status).toBe(200);
  expect(await one(env, 'SELECT matchup_id,origin_id FROM matchup_comments WHERE id=?', id)).toEqual({ matchup_id: clip, origin_id: clip });
  expect(await (await api(`/api/v1/matchups/${clip}/comments`)).json()).toMatchObject({ items: [{ id, matchup_id: clip }] });
  const report = crypto.randomUUID();
  expect((await api('/api/v1/reports', 'POST', { id: report, matchup_id: clip, reason: 'Check this' }, bob)).status).toBe(200);
  expect((await api('/api/v1/reports', 'POST', { id: crypto.randomUUID(), matchup_id: clip, reason: 'Check this' }, bob)).status).toBe(200);
  expect(await one(env, 'SELECT count(*) AS n FROM social_reports')).toEqual({ n: 1 });
  expect(await (await api('/api/admin/social/reports', 'GET', undefined, undefined, { admin: true })).json()).toMatchObject({ items: [{ id: report, origin_id: clip, matchup_id: clip }] });
  expect((await api('/api/v1/reports', 'POST', { id: crypto.randomUUID(), clip_id: clip, reason: 'Old field' }, alice)).status).toBe(400);
  expect((await api('/api/v1/reports', 'POST', { id: crypto.randomUUID(), matchup_id: clip, comment_id: id, reason: 'Both' }, alice)).status).toBe(400);
  expect((await api('/api/v1/matchups/999999/like', 'PUT', undefined, alice)).status).toBe(404);
  for (const path of ['/api/v1/clips', `/api/v1/clips/${clip}`, `/api/v1/clips/${clip}/like`]) expect((await api(path, 'PUT', undefined, alice)).status, path).toBe(404);
});

it('moderates a Matchup through the matchups route with matchup audit rows', async () => {
  expect((await moderation('matchups', clip, 'hidden')).status).toBe(200);
  expect((await api(`/api/v1/matchups/${clip}/comments`)).status).toBe(404);
  expect((await api(`/api/v1/matchups/${clip}/like`, 'PUT', undefined, alice)).status).toBe(409);
  expect((await moderation('matchups', clip, 'visible')).status).toBe(200);
  expect((await api(`/api/v1/matchups/${clip}/comments`)).status).toBe(200);
  expect((await moderation('matchups', 999999, 'hidden')).status).toBe(404);
  expect((await moderation('clips', clip, 'hidden')).status).toBe(404);
  expect(await rows(env, 'SELECT target_type,target_id,action FROM social_moderation_audit ORDER BY sequence')).toEqual([
    { target_type: 'matchup', target_id: String(clip), action: 'hidden' }, { target_type: 'matchup', target_id: String(clip), action: 'visible' }]);
});

it('follows merged_into for /matchups routes and hides every anchor of a hidden Matchup', async () => {
  const other = await addDetection(40), second = (await one<{ id: number }>(env, 'SELECT id FROM matchup_anchors WHERE current_detection_id=?', other))!.id;
  await statement(env, 'UPDATE matchup_anchors SET matchup_id=? WHERE id=?', clip, second).run();
  await statement(env, 'UPDATE matchups SET merged_into=? WHERE id=?', clip, second).run();
  expect((await api(`/api/v1/matchups/${second}/like`, 'PUT', undefined, alice)).status).toBe(200);
  expect(await one(env, 'SELECT matchup_id,origin_id FROM matchup_likes')).toEqual({ matchup_id: clip, origin_id: clip });
  expect((await moderation('matchups', second, 'hidden')).status).toBe(200);
  expect(await rows(env, 'SELECT detection_id FROM public_sources WHERE vod_id=1')).toEqual([]);
  expect((await api(`/api/v1/matchups/${second}/comments`)).status).toBe(404);
});
