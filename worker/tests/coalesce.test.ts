import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { canonicalMatchup, coalesceConfig, coalesceSession, coalesceVod, computeAssignment, createUnlink, linkAnchors, mergeMatchups,
  namesMatch, reconcileDirtySessions, revokeOverride, splitMatchup } from '../coalesce';
import { one, rows, statement } from '../http';
import { moveRecording, mergeSessions, setAlignment, undoSessionEvent } from '../sessions';
import { socialRoute } from '../social';
import type { AuthEnv } from '../auth/security';

const how = { actor: 'tester', evidence: 'Reviewed the same fight in both recordings' };
const socialEnv: AuthEnv = { ...env, PUBLIC_URL: 'http://localhost:8787', CORS_ORIGINS: 'http://localhost:3000', ENVIRONMENT: 'local', AUTH_ENABLED: 'true',
  AUTH_SECRET: 'test-social-secret-is-longer-than-thirty-two-characters' };
const admin = (path: string, method = 'GET', data?: unknown) => SELF.fetch(`http://local${path}`, {
  method, headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });

beforeEach(async () => {
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login) VALUES(1,'example')"),
    statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('yt','youtube','UCabcdefghijklmnopqrstuv','Creator'),('bb','bilibili','12345','Creator')"),
  ]);
});
let counter = 0;
async function recording(source = 'youtube') {
  const id = ++counter;
  await env.DB.batch([
    source === 'twitch' ? statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds) VALUES(?,1,?,900)", id, `t${id}`)
      : statement(env, "INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds) VALUES(?,?,?,?,900)", id, source, source === 'bilibili' ? `BV1${String(id).padStart(9, 'x')}` : `abcdefghi${String(id).padStart(2, '0')}`, source === 'bilibili' ? 'bb' : 'yt'),
    statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,?,0,900,0)", `chunk-${id}`, id),
  ]);
  return id;
}
async function anchor(vod: number, seconds: number, name = 'Opponent') {
  await statement(env, 'INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,1)', name.toLowerCase()).run();
  await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,storage_path)
    VALUES(?,?,?,?,?,0.95,?,'/detections/x.jpg')`, crypto.randomUUID(), `chunk-${vod}`, vod, name, name.toLowerCase(), seconds).run();
  return (await one<{ id: number }>(env, 'SELECT id FROM matchup_anchors WHERE vod_id=? AND anchor_seconds=?', vod, seconds))!.id;
}
const session = async (vod: number) => (await one<{ session_id: string }>(env, 'SELECT session_id FROM vods WHERE id=?', vod))!.session_id;
async function together(a: number, b: number) { // puts recording b in a's Session at offset 0
  return moveRecording(env, b, await session(a), 0, how);
}
const matchupOf = async (anchorId: number) => (await one<{ matchup_id: number }>(env, 'SELECT matchup_id FROM matchup_anchors WHERE id=?', anchorId))!.matchup_id;
const canonicalCount = async () => (await one<{ n: number }>(env, 'SELECT count(*) AS n FROM matchups WHERE merged_into IS NULL'))!.n;
const revisions = () => one(env, 'SELECT (SELECT revision FROM public_cache_state) AS c,(SELECT revision FROM public_search_state) AS s');
async function user(id: string) {
  await statement(env, 'INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)', id, id, `${id}@x.invalid`, '2026-01-01', '2026-01-01').run();
}

it('merges anchors of two Recordings once an alignment puts them in one Session, keeping the lowest ID', async () => {
  const [a, b] = [await recording(), await recording('bilibili')];
  const x = await anchor(a, 100), y = await anchor(b, 101);
  expect(await canonicalCount()).toBe(2);
  const aligned = await together(a, b);
  expect((aligned.session as any).id).toBe(await session(a));
  expect(await matchupOf(y)).toBe(x);
  expect(await rows(env, 'SELECT id,merged_into,origin FROM matchups ORDER BY id')).toEqual([{ id: x, merged_into: null, origin: 'auto' }, { id: y, merged_into: x, origin: 'auto' }]);
  expect(await one(env, 'SELECT session_id,session_time FROM matchups WHERE id=?', x)).toEqual({ session_id: await session(a), session_time: 100 });
  expect(await canonicalMatchup(env, y)).toBe(x);
  expect(await one(env, "SELECT action,actor FROM matchup_events WHERE action='coalesce'")).toEqual({ action: 'coalesce', actor: 'tester' });
});

it('keeps the same name at different times as two Matchups', async () => {
  const [a, b] = [await recording(), await recording()];
  await anchor(a, 100); await anchor(b, 130);
  await together(a, b);
  expect(await canonicalCount()).toBe(2);
});

it('applies the offset when comparing times and the configured tolerance', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 50);
  await moveRecording(env, b, await session(a), 50, how);
  expect(await matchupOf(y)).toBe(x);
  await splitMatchup(env, x, [y], how);
  await revokeAll();
  await env.DB.exec("INSERT INTO processing_config(key,value) VALUES('coalesce_tolerance_seconds','0')");
  await setAlignment(env, await session(a), b, [{ rec_start: 0, rec_end: null, offset_seconds: 51 }], how);
  expect(await matchupOf(y)).toBe(y);
  await env.DB.exec("UPDATE processing_config SET value='2' WHERE key='coalesce_tolerance_seconds'");
  await coalesceSession(env, await session(a));
  expect(await matchupOf(y)).toBe(x);
  async function revokeAll() { await env.DB.exec("UPDATE matchup_overrides SET revoked_at='2026-01-01',revoked_by='t'"); }
});

it('reads tolerance and similarity defensively', async () => {
  expect(await coalesceConfig(env)).toEqual({ tolerance: 3, similarity: 0.8 });
  for (const bad of ['abc', '-1', '1000', '']) {
    await env.DB.exec(`DELETE FROM processing_config; INSERT INTO processing_config(key,value) VALUES('coalesce_tolerance_seconds','${bad}')`);
    expect((await coalesceConfig(env)).tolerance).toBe(3);
  }
  await env.DB.exec("DELETE FROM processing_config; INSERT INTO processing_config(key,value) VALUES('coalesce_tolerance_seconds','10'),('coalesce_name_similarity','0.9')");
  expect(await coalesceConfig(env)).toEqual({ tolerance: 10, similarity: 0.9 });
});

it('matches names exactly, case-insensitively, or by trigram similarity only for names of four or more characters', () => {
  expect(namesMatch('Opponent', 'opponent', 0.8)).toBe(true);
  expect(namesMatch('averylongusername1', 'averylongusername7', 0.8)).toBe(true);
  expect(namesMatch('opponent', 'opponent1', 0.8)).toBe(false);
  expect(namesMatch('abc', 'abd', 0.8)).toBe(false);
  expect(namesMatch('abc', 'ABC', 0.8)).toBe(true);
  expect(namesMatch(null, 'abcd', 0.8)).toBe(false);
});

it('merges OCR variants of a long name but not of a short one', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100, 'averylongusername1'), y = await anchor(b, 101, 'averylongusername7');
  const s = await anchor(a, 300, 'abc'), t = await anchor(b, 300, 'abd');
  await together(a, b);
  expect(await matchupOf(y)).toBe(x);
  expect(await matchupOf(t)).toBe(t);
  expect(await matchupOf(s)).toBe(s);
});

it('never joins two anchors of one Recording and prefers the closest pair', () => {
  const anchors = [
    { id: 1, vod_id: 1, matchup_id: 1, session_id: 's', t: 100, name: 'opponent' },
    { id: 2, vod_id: 1, matchup_id: 2, session_id: 's', t: 101, name: 'opponent' },
    { id: 3, vod_id: 2, matchup_id: 3, session_id: 's', t: 101, name: 'opponent' },
  ];
  const { canonical } = computeAssignment(anchors, [], { tolerance: 3, similarity: 0.8 });
  expect(canonical.get(3)).toBe(2);
  expect(canonical.get(2)).toBe(2);
  expect(canonical.get(1)).toBe(1);
});

it('lets a manual unlink beat an auto edge, and a manual link beat the tolerance', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 101), p = await anchor(a, 500, 'First'), q = await anchor(b, 560, 'Second');
  await together(a, b);
  expect(await matchupOf(y)).toBe(x);
  await createUnlink(env, x, y, how);
  expect(await matchupOf(y)).toBe(y);
  expect((await coalesceSession(env, await session(a))).changed).toBe(0);
  expect(await matchupOf(y)).toBe(y);
  await linkAnchors(env, [p, q], how);
  expect(await matchupOf(q)).toBe(p);
  expect((await coalesceSession(env, await session(a))).changed).toBe(0);
  const active = await rows(env, 'SELECT action,anchor_a,anchor_b FROM matchup_overrides WHERE revoked_at IS NULL ORDER BY action');
  expect(active).toEqual([{ action: 'link', anchor_a: p, anchor_b: q }, { action: 'unlink', anchor_a: x, anchor_b: y }]);
  await revokeOverride(env, (await one<{ id: string }>(env, "SELECT id FROM matchup_overrides WHERE action='unlink'"))!.id, { actor: 'tester' });
  expect(await matchupOf(y)).toBe(x);
});

it('rejects contradicting overrides on one pair and reports transitive conflicts', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 500);
  await linkAnchors(env, [x, y], how);
  await expect(createUnlink(env, x, y, how)).rejects.toMatchObject({ status: 409 });
  const result = computeAssignment([1, 2, 3].map(id => ({ id, vod_id: id, matchup_id: id, session_id: null, t: null, name: null })), [
    { id: 'l1', action: 'link', anchor_a: 1, anchor_b: 2, actor: 'u' }, { id: 'l2', action: 'link', anchor_a: 2, anchor_b: 3, actor: 'u' },
    { id: 'u1', action: 'unlink', anchor_a: 1, anchor_b: 3, actor: 'u' }], { tolerance: 3, similarity: 0.8 });
  expect(result.conflicts).toEqual([{ link: [2, 3], unlink: [1, 3] }]);
  expect([...result.canonical.values()]).toEqual([1, 1, 3]);
});

it('writes nothing on a second run', async () => {
  const [a, b] = [await recording(), await recording()];
  await anchor(a, 100); await anchor(b, 100);
  await together(a, b);
  const before = { rev: await revisions(), events: await rows(env, 'SELECT id FROM matchup_events'), matchups: await rows(env, 'SELECT * FROM matchups ORDER BY id') };
  const result = await coalesceSession(env, await session(a));
  expect(result).toEqual({ changed: 0, retired: 0, revived: 0, conflicts: [], event_id: null });
  expect({ rev: await revisions(), events: await rows(env, 'SELECT id FROM matchup_events'), matchups: await rows(env, 'SELECT * FROM matchups ORDER BY id') }).toEqual(before);
});

it('combines likes without duplicates and restores each record by origin on split', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 100);
  await Promise.all(['u1', 'u2'].map(user));
  await env.DB.exec(`INSERT INTO matchup_likes(matchup_id,origin_id,user_id) VALUES(${x},${x},'u1'),(${y},${y},'u1'),(${y},${y},'u2');
    INSERT INTO matchup_favorites(matchup_id,origin_id,user_id) VALUES(${y},${y},'u2');
    INSERT INTO matchup_comments(id,matchup_id,origin_id,author_id,body,original_body_hash) VALUES('c1',${x},${x},'u1','a','h'),('c2',${y},${y},'u2','b','h');
    INSERT INTO social_reports(id,reporter_id,matchup_id,origin_id,reason) VALUES('r1','u1',${x},${x},'bad'),('r2','u1',${y},${y},'bad again'),('r3','u2',${y},${y},'bad');`);
  await together(a, b);
  expect(await rows(env, 'SELECT matchup_id,origin_id,user_id FROM matchup_likes ORDER BY origin_id,user_id')).toHaveLength(3);
  expect((await one<{ n: number }>(env, 'SELECT count(DISTINCT user_id) AS n FROM matchup_likes WHERE matchup_id=?', x))!.n).toBe(2);
  expect((await rows(env, 'SELECT DISTINCT matchup_id FROM matchup_likes UNION SELECT DISTINCT matchup_id FROM matchup_comments UNION SELECT DISTINCT matchup_id FROM matchup_favorites')).map(r => r.matchup_id)).toEqual([x]);
  expect(await rows(env, 'SELECT id,status FROM social_reports ORDER BY id')).toEqual([{ id: 'r1', status: 'open' }, { id: 'r2', status: 'dismissed' }, { id: 'r3', status: 'open' }]);
  expect(await rows(env, 'SELECT id,matchup_id,origin_id FROM social_reports ORDER BY id')).toEqual([{ id: 'r1', matchup_id: x, origin_id: x }, { id: 'r2', matchup_id: x, origin_id: y }, { id: 'r3', matchup_id: x, origin_id: y }]);
  await splitMatchup(env, x, [y], how);
  expect(await rows(env, 'SELECT matchup_id,origin_id,user_id FROM matchup_likes ORDER BY origin_id,user_id')).toEqual([
    { matchup_id: x, origin_id: x, user_id: 'u1' }, { matchup_id: y, origin_id: y, user_id: 'u1' }, { matchup_id: y, origin_id: y, user_id: 'u2' }]);
  expect(await rows(env, 'SELECT id,matchup_id FROM matchup_comments ORDER BY id')).toEqual([{ id: 'c1', matchup_id: x }, { id: 'c2', matchup_id: y }]);
  expect(await rows(env, 'SELECT matchup_id FROM matchup_favorites')).toEqual([{ matchup_id: y }]);
  expect(await rows(env, 'SELECT id,matchup_id FROM social_reports ORDER BY id')).toEqual([{ id: 'r1', matchup_id: x }, { id: 'r2', matchup_id: y }, { id: 'r3', matchup_id: y }]);
});

it('revives the retired Matchup on split, refreshes its Session fields and keeps hiding', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 101);
  await together(a, b);
  await env.DB.exec(`UPDATE matchups SET status='hidden' WHERE id=${x}`);
  const split = await splitMatchup(env, x, [y], how);
  expect(split).toMatchObject({ changed: 1, retired: 0, revived: 1 });
  expect(await rows(env, 'SELECT id,merged_into,status,session_id IS NOT NULL AS s,session_time FROM matchups ORDER BY id')).toEqual([
    { id: x, merged_into: null, status: 'hidden', s: 1, session_time: 100 }, { id: y, merged_into: null, status: 'hidden', s: 1, session_time: 101 }]);
  await expect(splitMatchup(env, x, [x], how)).rejects.toMatchObject({ status: 400 });
});

it('hides the merged Matchup if either side was hidden, and flattens redirects across several merges', async () => {
  const [a, b, c] = [await recording(), await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 100), z = await anchor(c, 100);
  await env.DB.exec(`UPDATE matchups SET status='hidden' WHERE id=${y}`);
  await together(a, b);
  expect(await one(env, 'SELECT status FROM matchups WHERE id=?', x)).toEqual({ status: 'hidden' });
  await together(a, c);
  expect(await rows(env, 'SELECT id,merged_into FROM matchups ORDER BY id')).toEqual([{ id: x, merged_into: null }, { id: y, merged_into: x }, { id: z, merged_into: x }]);
  const direct = await mergeMatchups(env, x, z, how).catch(error => error);
  expect(direct.status).toBe(400);
});

it('merges and splits Matchups across Sessions through manual links (unaligned)', async () => {
  const [a, b] = [await recording(), await recording('bilibili')];
  const x = await anchor(a, 100), y = await anchor(b, 850);
  const merged = await mergeMatchups(env, y, x, how);
  expect(merged).toMatchObject({ changed: 1, matchup_id: x, merged: [y, x] });
  const detail = await (await admin(`/api/admin/matchups/${y}`)).json<any>();
  expect(detail).toMatchObject({ id: x, requested_id: y, unaligned: true, retired_ids: [y] });
  expect(detail.overrides).toHaveLength(1);
  expect((await admin(`/api/admin/matchups?multi=1`).then(r => r.json<any[]>())).map(m => [m.id, m.anchor_count, m.unaligned])).toEqual([[x, 2, 1]]);
  expect((await coalesceSession(env, await session(a))).changed).toBe(0);
  await splitMatchup(env, x, [y], how);
  expect(await canonicalCount()).toBe(2);
  expect((await coalesceSession(env, await session(b))).changed).toBe(0);
});

it('resolves retired Matchup IDs through every v1 route', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 100);
  await together(a, b);
  expect((await SELF.fetch(`http://local/api/v1/matchups/${y}`)).status).toBe(200);
  const detail = await (await SELF.fetch(`http://local/api/v1/matchups/${y}`)).json<any>();
  expect(detail.matchup.id).toBe(y);
  expect(detail.groupId).toBe(String(x));
  expect(detail.appearances.map((m: any) => m.id)).toEqual([x, y]);
  expect((await SELF.fetch(`http://local/api/v1/clips/${y}`)).status).toBe(200);
  const clip = await socialRoute(new Request(`http://localhost:8787/api/v1/clips/${y}`), socialEnv);
  expect(clip.status).toBe(200);
  expect((await clip.json<any>()).matchup_id).toBe(x);
  const viaMatchup = await socialRoute(new Request(`http://localhost:8787/api/v1/matchups/${y}/comments`), socialEnv);
  expect(viaMatchup.status).toBe(200);
});

it('lists a merged Matchup once in /clips and keeps filters', async () => {
  const [a, b, c] = [await recording(), await recording('bilibili'), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 100), z = await anchor(c, 500, 'Other');
  await together(a, b);
  const list = async (query = '') => (await (await socialRoute(new Request(`http://localhost:8787/api/v1/clips${query}`), socialEnv)).json<any>()).items.map((i: any) => i.id);
  expect(await list()).toEqual([x, z]);
  expect(await list('?source=bilibili')).toEqual([y]);
  expect(await list(`?vod_id=${b}`)).toEqual([y]);
  expect(await list(`?limit=1`)).toEqual([x]);
});

it('groups linked appearances in search and splits them again', async () => {
  const { appearanceSearch } = await import('../appearances');
  const { linkDetections, unlinkDetection } = await import('./link-fixture');
  const [a, b] = [await recording(), await recording('bilibili')];
  await anchor(a, 100); await anchor(b, 850);
  const [da, db] = (await rows<{ id: string }>(env, 'SELECT id FROM detections ORDER BY frame_time_seconds')).map(r => r.id);
  const group = await linkDetections(env, [da, db]);
  expect(await canonicalCount()).toBe(1);
  expect((await appearanceSearch(env, {}))[0]).toMatchObject({ matchup_id: group.matchup_id, total_count: 1 });
  expect(await linkDetections(env, [da, db])).toEqual(group);
  await unlinkDetection(env, db);
  expect(await canonicalCount()).toBe(2);
});

it('coalesces per Recording, and the scheduled reconcile picks up dirty Sessions', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 100);
  const sid = await session(a);
  await env.DB.exec(`INSERT INTO recording_alignments(session_id,vod_id,rec_start,offset_seconds,method,actor,revoked_at,revoked_by) VALUES('${sid}',${b},0,0,'operator','t','2026-01-01','t')`);
  await coalesceVod(env, a);
  expect(await matchupOf(y)).toBe(y); // singleton Sessions have nothing to match across
  await env.DB.batch([
    statement(env, 'UPDATE recording_alignments SET revoked_at=?,revoked_by=? WHERE vod_id=? AND revoked_at IS NULL', '2026-01-01', 't', b),
    statement(env, "INSERT INTO recording_alignments(session_id,vod_id,rec_start,offset_seconds,method,actor) VALUES(?,?,0,0,'operator','t')", sid, b),
    statement(env, 'UPDATE sessions SET coalesce_dirty=1 WHERE id=?', sid),
  ]);
  expect(await matchupOf(y)).toBe(y);
  expect(await reconcileDirtySessions(env)).toBe(1);
  expect(await matchupOf(y)).toBe(x);
  expect(await one(env, 'SELECT coalesce_dirty FROM sessions WHERE id=?', sid)).toEqual({ coalesce_dirty: 0 });
});

it('re-derives Matchups when alignments are undone or Sessions merge', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 100);
  const moved = await together(a, b);
  expect(await matchupOf(y)).toBe(x);
  await undoSessionEvent(env, moved.event_id, { actor: 'tester' });
  expect(await matchupOf(y)).toBe(y);
  expect(await canonicalCount()).toBe(2);
  await mergeSessions(env, await session(a), await session(b), 0, how);
  expect(await matchupOf(y)).toBe(x);
});

it('bumps public revisions when Matchups change but not when anchors are born', async () => {
  const [a, b] = [await recording(), await recording()];
  const before = await revisions();
  await anchor(a, 100); await anchor(b, 100);
  expect(await revisions()).toEqual(before);
  await together(a, b);
  const after = await revisions();
  expect(after!.c).toBeGreaterThan(before!.c as number);
  expect(after!.s).toBeGreaterThan(before!.s as number);
});

it('exposes override management through the admin API', async () => {
  const [a, b] = [await recording(), await recording()];
  const x = await anchor(a, 100), y = await anchor(b, 800);
  expect((await admin('/api/admin/matchups/link', 'POST', { anchor_ids: [x, y], evidence: 'too short' })).status).toBe(400);
  const linked = await admin('/api/admin/matchups/link', 'POST', { anchor_ids: [x, y], evidence: 'Confirmed on both streams', actor: 'op' });
  expect(linked.status).toBe(200);
  const overrides = await (await admin('/api/admin/matchups/overrides')).json<any[]>();
  expect(overrides).toHaveLength(1);
  expect((await admin(`/api/admin/matchups/overrides/${overrides[0].id}`, 'DELETE', { actor: 'op' })).status).toBe(200);
  expect(await canonicalCount()).toBe(2);
  expect((await admin('/api/admin/matchups/coalesce', 'POST', { session_id: await session(a) })).status).toBe(200);
  expect((await admin('/api/admin/matchups/nope')).status).toBe(404);
});
