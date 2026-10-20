import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { one, rows, statement } from '../http';
import { acceptProposal, DEFAULT_PROPOSAL, evaluatePair, proposeForRecording, rejectProposal, sweepProposals, type ProposalAnchor } from '../session-proposals';

const admin = (path: string, method = 'GET', data?: unknown) => SELF.fetch(`http://local${path}`, {
  method, headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });

beforeEach(async () => {
  await env.DB.batch([
    statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]')"),
    statement(env, "INSERT INTO streamers(id,login) VALUES(1,'example'),(2,'other')"),
    statement(env, "INSERT INTO platform_accounts(id,source,source_id,display_name) VALUES('yt','youtube','UCabcdefghijklmnopqrstuv','Creator'),('bb','bilibili','12345','Creator')"),
  ]);
});
let counter = 100;
async function recording(source = 'youtube', streamer: number | null = null) {
  const id = ++counter;
  await env.DB.batch([
    source === 'twitch' ? statement(env, 'INSERT INTO vods(id,streamer_id,source_id,duration_seconds,status) VALUES(?,?,?,3000,\'completed\')', id, streamer ?? 1, `t${id}`)
      : statement(env, "INSERT INTO vods(id,source,source_id,platform_account_id,duration_seconds,status) VALUES(?,?,?,?,3000,'completed')", id, source,
        source === 'bilibili' ? `BV1${String(id).padStart(9, 'x')}` : `abcdefgh${String(id).padStart(3, '0')}`, source === 'bilibili' ? 'bb' : 'yt'),
    statement(env, 'INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES(?,?,0,3000,0)', `chunk-${id}`, id),
  ]);
  return id;
}
async function anchor(vod: number, seconds: number, name: string) {
  await statement(env, 'INSERT OR IGNORE INTO search_names(name,gram_count) VALUES(?,1)', name.toLowerCase()).run();
  const id = crypto.randomUUID();
  await statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,storage_path)
    VALUES(?,?,?,?,?,0.95,?,'/detections/x.jpg')`, id, `chunk-${vod}`, vod, name, name.toLowerCase(), seconds).run();
  return id;
}
const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
/** Recording A and B show the same fights; B's clock runs `shift` seconds behind A's. */
async function rebroadcast(shift = 40, names = NAMES) {
  const [a, b] = [await recording(), await recording('bilibili')];
  for (const [i, name] of names.entries()) { await anchor(a, 100 + i * 100, name); await anchor(b, 100 + i * 100 - shift, name); }
  return [a, b] as const;
}
const session = async (vod: number) => (await one<{ session_id: string }>(env, 'SELECT session_id FROM vods WHERE id=?', vod))!.session_id;
const canonicalCount = async () => (await one<{ n: number }>(env, 'SELECT count(*) AS n FROM matchups WHERE merged_into IS NULL'))!.n;

const point = (id: number, name: string, t: number): ProposalAnchor => ({ id, det: `d${id}`, name, t });
const config = DEFAULT_PROPOSAL;

it('evaluates a re-upload: repeated opponents elsewhere are not conflicts', () => {
  const names = ['a1', 'b2', 'c3', 'd4', 'e5', 'a1', 'b2', 'a1'];
  const a = names.map((n, i) => point(i, n, 300 + i * 150)), b = names.map((n, i) => point(100 + i, n, 300 + i * 150));
  const result = evaluatePair(a, b, config, 3, 0.8)!;
  expect(result).toMatchObject({ offset: 0, distinct_names: 5, eligible: true, coverage: 1 });
  expect(result.support).toHaveLength(8);
  expect(result.conflicts).toEqual([]);
});
it('finds the constant offset and reports the Session timeline direction', () => {
  const a = NAMES.map((n, i) => point(i, n, 100 + i * 100)), b = NAMES.map((n, i) => point(10 + i, n, 60 + i * 100));
  expect(evaluatePair(a, b, config, 3, 0.8)).toMatchObject({ offset: 40, eligible: true });
});
it('counts a conflict only when a different name sits at the mapped time', () => {
  const a = [...NAMES, 'zulu'].map((n, i) => point(i, n, 100 + i * 100)), b = [...NAMES, 'yankee'].map((n, i) => point(10 + i, n, 100 + i * 100));
  const result = evaluatePair(a, b, config, 3, 0.8)!;
  expect(result.support).toHaveLength(5);
  expect(result.conflicts).toHaveLength(1);
  expect(result.eligible).toBe(true);
  const many = evaluatePair([...a, point(50, 'x1', 900), point(51, 'x2', 1000), point(52, 'x3', 1100)], [...b, point(60, 'y1', 900), point(61, 'y2', 1000), point(62, 'y3', 1100)], config, 3, 0.8)!;
  expect(many.conflicts).toHaveLength(4);
  expect(many.eligible).toBe(false);
});
it('rejects chance clusters: three hits among many anchors fail the coverage guard', () => {
  const a: ProposalAnchor[] = [], b: ProposalAnchor[] = [];
  for (let i = 0; i < 60; i++) { a.push(point(i, `pool${i % 7}`, 100 + i * 150)); b.push(point(200 + i, `pool${(i * 3 + 1) % 7}`, 100 + i * 140)); }
  for (const [i, n] of ['hit1', 'hit2', 'hit3'].entries()) { a.push(point(500 + i, n, 20000 + i * 300)); b.push(point(600 + i, n, 20000 + i * 300 - 2900)); }
  const result = evaluatePair(a, b, config, 3, 0.8)!;
  expect(result.support.length).toBeGreaterThanOrEqual(3);
  expect(result.eligible).toBe(false);
});
it('needs three distinct names: one repeated opponent is never enough', () => {
  const a = [0, 1, 2, 3].map(i => point(i, 'same', 100 + i * 100)), b = [0, 1, 2, 3].map(i => point(10 + i, 'same', 100 + i * 100));
  const result = evaluatePair(a, b, config, 3, 0.8)!;
  expect(result.support).toHaveLength(4);
  expect(result.distinct_names).toBe(1);
  expect(result.eligible).toBe(false);
});
it('excludes previously rejected pairs before counting', () => {
  const a = NAMES.map((n, i) => point(i, n, 100 + i * 100)), b = NAMES.map((n, i) => point(10 + i, n, 100 + i * 100));
  expect(evaluatePair(a, b, config, 3, 0.8, new Set(['d0:d10', 'd1:d11', 'd2:d12']))!.eligible).toBe(false);
  expect(evaluatePair(a, b, config, 3, 0.8, new Set(['d0:d10']))!.eligible).toBe(true);
});

it('proposes once for a re-broadcast, from either Recording, and stores evidence', async () => {
  const [a, b] = await rebroadcast();
  expect(await canonicalCount()).toBe(10);
  const [made] = await proposeForRecording(env, b);
  expect(made).toMatchObject({ support: 5, accepted: false });
  expect(await proposeForRecording(env, a)).toEqual([]);
  expect(await proposeForRecording(env, b)).toEqual([]);
  const proposal = await one(env, 'SELECT * FROM session_link_proposals');
  const [sa, sb] = [await session(a), await session(b)];
  expect(proposal).toMatchObject({ status: 'pending', support: 5, distinct_names: 5, conflicts: 0, coverage: 1, tolerance: 3, decided_by_rule: 0 });
  expect(proposal!.session_a).toBe(sa < sb ? sa : sb);
  expect(Math.abs(proposal!.offset_seconds)).toBe(40);
  expect((await rows(env, 'SELECT kind FROM proposal_evidence')).length).toBe(5);
  // Nothing takes effect without an operator.
  expect(await session(a)).toBe(sa);
  expect(await canonicalCount()).toBe(10);
});
it('accepting moves both Recordings into one Session and coalescing merges exactly the matching fights', async () => {
  const [a, b] = await rebroadcast();
  await anchor(a, 2000, 'unique-a'); await anchor(b, 2500, 'unique-b');
  await proposeForRecording(env, a);
  const pending = await one<{ id: string }>(env, "SELECT id FROM session_link_proposals WHERE status='pending'");
  const accepted = await acceptProposal(env, pending!.id, { actor: 'op', note: 'Same stream, verified' });
  expect(await session(a)).toBe(await session(b));
  expect(accepted.proposal).toMatchObject({ status: 'accepted', decided_by: 'op', decided_by_rule: 0 });
  expect(await canonicalCount()).toBe(7);
  expect(await one(env, "SELECT count(*) n FROM recording_alignments WHERE method='proposal' AND proposal_id=? AND revoked_at IS NULL", pending!.id)).toMatchObject({ n: 1 });
  await expect(acceptProposal(env, pending!.id, { actor: 'op' })).rejects.toMatchObject({ status: 409 });
});
it('remembers rejected evidence and proposes again only with new support', async () => {
  const [a, b] = await rebroadcast(40, NAMES.slice(0, 3));
  await proposeForRecording(env, a);
  const first = await one<{ id: string }>(env, "SELECT id FROM session_link_proposals WHERE status='pending'");
  await rejectProposal(env, first!.id, { actor: 'op', note: 'Different streams' });
  expect(await proposeForRecording(env, a)).toEqual([]);
  expect(await proposeForRecording(env, b)).toEqual([]);
  expect(await rows(env, "SELECT status FROM session_link_proposals")).toEqual([{ status: 'rejected' }]);
  await rejectProposal(env, first!.id, { actor: 'op' }).catch(error => expect(error.status).toBe(409));
  // Three new pairs make a new proposal; the rejected ones are not counted again.
  for (const [i, name] of ['foxtrot', 'golf', 'hotel'].entries()) { await anchor(a, 1000 + i * 100, name); await anchor(b, 960 + i * 100, name); }
  const [made] = await proposeForRecording(env, a);
  expect(made.support).toBe(3);
  expect((await rows(env, 'SELECT status FROM session_link_proposals ORDER BY created_at,rowid')).map(r => r.status)).toEqual(['rejected', 'pending']);
});
it('does not propose consecutive sessions sharing a few names among many anchors', async () => {
  const [a, b] = [await recording('twitch'), await recording('twitch')];
  for (let i = 0; i < 40; i++) { await anchor(a, 50 + i * 70, `pool${i % 6}`); await anchor(b, 50 + i * 71, `pool${(i * 5 + 2) % 6}`); }
  await anchor(a, 2900, 'hit1'); await anchor(b, 2800, 'hit1'); await anchor(a, 2850, 'hit2'); await anchor(b, 2750, 'hit2'); await anchor(a, 2950, 'hit3'); await anchor(b, 2850, 'hit3');
  expect(await proposeForRecording(env, a)).toEqual([]);
  expect(await one(env, 'SELECT count(*) n FROM session_link_proposals')).toEqual({ n: 0 });
});
it('refuses different Streamers on accept until one is chosen', async () => {
  const [a, b] = [await recording('twitch', 1), await recording('twitch', 2)];
  for (const [i, name] of NAMES.entries()) { await anchor(a, 100 + i * 100, name); await anchor(b, 100 + i * 100, name); }
  expect(await proposeForRecording(env, a)).toEqual([]);
  // Same pair filed manually bypasses the generator filter, so the accept guard is exercised directly.
  await env.DB.batch([statement(env, "UPDATE sessions SET streamer_id=NULL WHERE id IN(?,?)", await session(a), await session(b))]);
  const [made] = await proposeForRecording(env, a);
  await env.DB.batch([statement(env, 'UPDATE sessions SET streamer_id=? WHERE id=?', 1, await session(a)), statement(env, 'UPDATE sessions SET streamer_id=? WHERE id=?', 2, await session(b))]);
  const response = await admin(`/api/admin/session-proposals/${made.id}/accept`, 'POST', { actor: 'op' });
  expect(response.status).toBe(409);
  expect(await one(env, 'SELECT status FROM session_link_proposals WHERE id=?', made.id)).toEqual({ status: 'pending' });
  const ok = await admin(`/api/admin/session-proposals/${made.id}/accept`, 'POST', { actor: 'op', streamer_id: 1 });
  expect(ok.status).toBe(200);
  expect(await session(a)).toBe(await session(b));
});
it('supersedes pending proposals when a Recording moves or the Sessions merge', async () => {
  const [a, b] = await rebroadcast();
  await proposeForRecording(env, a);
  const { moveRecording } = await import('../sessions');
  const other = await recording('twitch');
  await moveRecording(env, b, await session(other), 0, { actor: 'op', evidence: 'Moved elsewhere for the test' });
  await sweepProposals(env, 0);
  expect(await rows(env, 'SELECT status FROM session_link_proposals')).toEqual([{ status: 'superseded' }]);
});
it('ships the auto-accept rule disabled and honours it when enabled', async () => {
  const [a] = await rebroadcast();
  const [made] = await proposeForRecording(env, a);
  expect(made.accepted).toBe(false);
  const [c, d] = [await recording('twitch', 1), await recording('twitch', 1)];
  for (let i = 0; i < 8; i++) { await anchor(c, 100 + i * 100, `auto${i}`); await anchor(d, 80 + i * 100, `auto${i}`); }
  await env.DB.prepare("INSERT INTO processing_config(key,value) VALUES('session_auto_accept',?)")
    .bind(JSON.stringify({ enabled: true, min_support: 8, min_distinct_names: 5, max_conflict_ratio: 0, require_same_streamer: true })).run();
  const [auto] = await proposeForRecording(env, c);
  expect(auto.accepted).toBe(true);
  expect(await session(c)).toBe(await session(d));
  expect(await one(env, 'SELECT status,decided_by,decided_by_rule FROM session_link_proposals WHERE id=?', auto.id)).toEqual({ status: 'accepted', decided_by: 'auto-rule', decided_by_rule: 1 });
  expect(await one(env, "SELECT method FROM recording_alignments WHERE proposal_id=? AND revoked_at IS NULL", auto.id)).toEqual({ method: 'auto-rule' });
});
it('serves the admin API: list, detail with evidence, reject', async () => {
  const [a] = await rebroadcast();
  const [made] = await proposeForRecording(env, a);
  const list = await (await admin('/api/admin/session-proposals?status=pending')).json() as any[];
  expect(list.map(p => p.id)).toEqual([made.id]);
  const detail = await (await admin(`/api/admin/session-proposals/${made.id}`)).json() as any;
  expect(detail.evidence).toHaveLength(5);
  expect(detail.evidence[0]).toMatchObject({ kind: 'support', screenshot_a: '/detections/x.jpg' });
  expect((await SELF.fetch(`http://local/api/admin/session-proposals/${made.id}`)).status).toBe(401);
  expect((await admin(`/api/admin/session-proposals/${made.id}/reject`, 'POST', { actor: 'op', note: 'Not the same stream' })).status).toBe(200);
  expect((await admin('/api/admin/session-proposals?status=bogus')).status).toBe(400);
  expect((await admin('/api/admin/appearances/link', 'POST', {})).status).toBe(404);
});
