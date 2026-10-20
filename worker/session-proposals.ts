import { coalesceConfig, namesMatch } from './coalesce';
import { body, HttpError, integer, now, one, requireValue, rows, statement } from './http';
import { mergeSessions } from './sessions';

/**
 * Session link proposals (SES-03). Two Recordings of different Sessions that show the same opponents at one constant
 * time offset are probably the same stream. A proposal never takes effect without an operator unless the
 * `session_auto_accept` rule is enabled (it ships disabled).
 */
export interface ProposalConfig { min_support: number; min_distinct_names: number; max_conflict_ratio: number; min_coverage: number; window_days: number }
export interface AutoAcceptConfig { enabled: boolean; min_support: number; min_distinct_names: number; max_conflict_ratio: number; require_same_streamer: boolean }
export interface ProposalAnchor { id: number; det: string; name: string; t: number }
export interface Evidence { a: string; b: string; delta: number; name: string }
export interface Evaluation {
  offset: number; support: Evidence[]; distinct_names: number; conflicts: Evidence[]; coverage: number; overlap_a: number; overlap_b: number; eligible: boolean;
}

export const DEFAULT_PROPOSAL: ProposalConfig = { min_support: 3, min_distinct_names: 3, max_conflict_ratio: 0.25, min_coverage: 0.3, window_days: 30 };
export const DEFAULT_AUTO_ACCEPT: AutoAcceptConfig = { enabled: false, min_support: 8, min_distinct_names: 5, max_conflict_ratio: 0, require_same_streamer: true };
const MAX_CANDIDATES = 20;
const hex = () => crypto.randomUUID().replaceAll('-', '');
const round = (n: number) => Math.round(n * 1000) / 1000;

async function configValue<T extends object>(env: Env, key: string, defaults: T): Promise<T> {
  const row = await one<{ value: string }>(env, 'SELECT value FROM processing_config WHERE key=?', key);
  let parsed: Record<string, unknown> = {};
  try { parsed = row ? JSON.parse(row.value) : {}; } catch { /* malformed settings fall back to defaults */ }
  const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [name, fallback] of Object.entries(defaults as Record<string, unknown>)) {
    const value = parsed?.[name];
    if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) result[name] = value;
  }
  return result as T;
}
export const proposalConfig = (env: Env) => configValue(env, 'session_proposal', DEFAULT_PROPOSAL);
export const autoAcceptConfig = (env: Env) => configValue(env, 'session_auto_accept', DEFAULT_AUTO_ACCEPT);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Pure. `a` and `b` are the anchors of two Recordings with times on their own Session timelines; the result is the offset
 * that maps B's Session timeline onto A's (t_a = t_b + offset). `excluded` holds "detA:detB" pairs rejected earlier.
 */
export function evaluatePair(a: ProposalAnchor[], b: ProposalAnchor[], config: ProposalConfig, tolerance: number, similarity: number,
  excluded: ReadonlySet<string> = new Set()): Evaluation | null {
  const cache = new Map<string, Set<string>>(), memo = new Map<string, boolean>();
  const same = (x: string, y: string) => {
    const key = `${x}\u0000${y}`;
    let hit = memo.get(key);
    if (hit === undefined) { hit = namesMatch(x, y, similarity, cache); memo.set(key, hit); }
    return hit;
  };
  const pairs: Array<{ x: ProposalAnchor; y: ProposalAnchor; delta: number }> = [];
  for (const x of a) for (const y of b)
    if (!excluded.has(`${x.det}:${y.det}`) && same(x.name, y.name)) pairs.push({ x, y, delta: x.t - y.t });
  if (!pairs.length) return null;
  pairs.sort((p, q) => p.delta - q.delta || p.x.id - q.x.id || p.y.id - q.y.id);
  // The densest window of width 2*tolerance, first one on ties; its median is the offset.
  let bestStart = 0, bestCount = 0;
  for (let lo = 0, hi = 0; lo < pairs.length; lo++) {
    while (hi < pairs.length && pairs[hi].delta - pairs[lo].delta <= 2 * tolerance) hi++;
    if (hi - lo > bestCount) { bestCount = hi - lo; bestStart = lo; }
  }
  const centre = median(pairs.slice(bestStart, bestStart + bestCount).map(p => p.delta));
  const window = pairs.filter(p => Math.abs(p.delta - centre) <= tolerance)
    .sort((p, q) => Math.abs(p.delta - centre) - Math.abs(q.delta - centre) || p.x.id - q.x.id || p.y.id - q.y.id);
  const usedA = new Set<number>(), usedB = new Set<number>(), matched: typeof window = [];
  for (const p of window) if (!usedA.has(p.x.id) && !usedB.has(p.y.id)) { usedA.add(p.x.id); usedB.add(p.y.id); matched.push(p); }
  const offset = round(median(matched.map(p => p.delta)));
  const support = matched.map(p => ({ a: p.x.det, b: p.y.det, delta: round(p.delta), name: p.x.name.toLowerCase() }))
    .sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0));
  // Overlap: the stretch of A's timeline in which both Recordings have anchors.
  const lo = Math.max(Math.min(...a.map(x => x.t)), Math.min(...b.map(y => y.t + offset)));
  const hi = Math.min(Math.max(...a.map(x => x.t)), Math.max(...b.map(y => y.t + offset)));
  const inA = a.filter(x => x.t >= lo && x.t <= hi), inB = b.filter(y => y.t + offset >= lo && y.t + offset <= hi);
  // A conflict is an anchor with a neighbour at its mapped time, none of which has its name. Repeated opponents elsewhere are not conflicts.
  const conflicts = new Map<string, Evidence>();
  const scan = (list: ProposalAnchor[], others: ProposalAnchor[], flip: boolean) => {
    for (const x of list) {
      const near = others.filter(y => Math.abs((flip ? y.t - offset : y.t + offset) - x.t) <= tolerance);
      if (!near.length || near.some(y => same(x.name, y.name))) continue;
      const y = near.reduce((best, c) => Math.abs((flip ? c.t - offset : c.t + offset) - x.t) < Math.abs((flip ? best.t - offset : best.t + offset) - x.t) ? c : best);
      const [da, db] = flip ? [y, x] : [x, y];
      conflicts.set(`${da.det}:${db.det}`, { a: da.det, b: db.det, delta: round(da.t - db.t), name: `${da.name}≠${db.name}` });
    }
  };
  scan(inA, b, false); scan(inB, a, true);
  const names = new Set(support.map(s => s.name)), coverage = support.length / Math.max(1, Math.min(inA.length, inB.length));
  const conflictList = [...conflicts.values()].sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : 1));
  return { offset, support, distinct_names: names.size, conflicts: conflictList, coverage: round(coverage), overlap_a: inA.length, overlap_b: inB.length,
    eligible: support.length >= config.min_support && names.size >= config.min_distinct_names
      && conflictList.length / Math.max(1, support.length) <= config.max_conflict_ratio && coverage >= config.min_coverage };
}

async function sha256(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const evidenceHash = (support: Evidence[]) => sha256([...support.map(s => `${s.a}:${s.b}`)].sort().join('\n'));

async function recordingAnchors(env: Env, vodId: number) {
  return rows<ProposalAnchor & { session_id: string }>(env, `SELECT a.id,a.current_detection_id AS det,d.username_lower AS name,a.anchor_seconds+g.offset_seconds AS t,g.session_id
    FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
    JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end)
    WHERE a.vod_id=? ORDER BY a.id`, vodId);
}
async function sessionOfVod(env: Env, vodId: number) {
  const found = await rows<{ session_id: string }>(env, 'SELECT DISTINCT session_id FROM recording_alignments WHERE vod_id=? AND revoked_at IS NULL', vodId);
  return found.length === 1 ? found[0].session_id : null;
}
/** The Streamer that makes a Session unlinkable to another's: provisional Streamers are placeholders, so they never block a proposal. */
async function realStreamerOf(env: Env, session: string) {
  return (await one<{ streamer_id: number | null }>(env, `SELECT s.streamer_id FROM sessions s JOIN streamer_identities i ON i.id=s.streamer_id
    WHERE s.id=? AND s.merged_into IS NULL AND i.provisional_channel_id IS NULL`, session))?.streamer_id ?? null;
}
async function streamerOf(env: Env, session: string) {
  return (await one<{ streamer_id: number | null }>(env, 'SELECT streamer_id FROM sessions WHERE id=? AND merged_into IS NULL', session))?.streamer_id ?? null;
}
async function rejectedPairs(env: Env, vodA: number, vodB: number) {
  return new Set((await rows<{ p: string }>(env, `SELECT e.detection_a||':'||e.detection_b AS p FROM proposal_evidence e JOIN session_link_proposals s ON s.id=e.proposal_id
    WHERE s.status='rejected' AND s.vod_a=? AND s.vod_b=? AND e.kind='support'`, vodA, vodB)).map(r => r.p));
}

export interface Created { id: string; vod_a: number; vod_b: number; support: number; accepted: boolean }

/** Evaluates every plausible counterpart of a Recording and files proposals for the eligible ones. */
export async function proposeForRecording(env: Env, vodId: number): Promise<Created[]> {
  integer(vodId, 'vod ID', 1);
  const [config, coalesce] = [await proposalConfig(env), await coalesceConfig(env)];
  const session = await sessionOfVod(env, vodId), made: Created[] = [];
  if (!session) return made;
  const mine = await recordingAnchors(env, vodId);
  await statement(env, 'UPDATE vods SET proposals_checked_at=? WHERE id=?', now(), vodId).run();
  if (mine.length < config.min_support) return made;
  const candidates = await rows<{ vod_id: number; n: number }>(env, `SELECT b.vod_id,count(DISTINCT db.username_lower) AS n
    FROM matchup_anchors a JOIN detections da ON da.id=a.current_detection_id
    JOIN detections db ON db.username_lower=da.username_lower AND db.vod_id!=a.vod_id
    JOIN matchup_anchors b ON b.current_detection_id=db.id
    JOIN recording_alignments g ON g.vod_id=b.vod_id AND g.revoked_at IS NULL AND g.session_id!=?2
    JOIN vods v ON v.id=b.vod_id JOIN vods me ON me.id=a.vod_id
    WHERE a.vod_id=?1 AND (v.recorded_at IS NULL OR me.recorded_at IS NULL OR abs(julianday(v.recorded_at)-julianday(me.recorded_at))<=?3)
    GROUP BY b.vod_id HAVING count(DISTINCT db.username_lower)>=?4 ORDER BY n DESC,b.vod_id LIMIT ?5`,
    vodId, session, config.window_days, config.min_distinct_names, MAX_CANDIDATES);
  for (const { vod_id: other } of candidates) {
    const otherSession = await sessionOfVod(env, other);
    if (!otherSession) continue;
    const [one1, two] = [await realStreamerOf(env, session), await realStreamerOf(env, otherSession)];
    if (one1 !== null && two !== null && one1 !== two) continue;
    // Orientation is fixed by Session ID so re-running from either Recording yields the same proposal.
    const mineIsA = session < otherSession;
    const [vodA, vodB, sessionA, sessionB] = mineIsA ? [vodId, other, session, otherSession] : [other, vodId, otherSession, session];
    const theirs = await recordingAnchors(env, other);
    const result = evaluatePair(mineIsA ? mine : theirs, mineIsA ? theirs : mine, config, coalesce.tolerance, coalesce.similarity, await rejectedPairs(env, vodA, vodB));
    if (!result || !result.eligible) {
      await statement(env, "UPDATE session_link_proposals SET status='superseded' WHERE vod_a=? AND vod_b=? AND status='pending'", vodA, vodB).run();
      continue;
    }
    const hash = await evidenceHash(result.support), id = hex();
    const evidence = [...result.support.map(s => ({ ...s, kind: 'support' })), ...result.conflicts.map(s => ({ ...s, kind: 'conflict' }))];
    const stale = statement(env, `UPDATE session_link_proposals SET status='superseded' WHERE vod_a=? AND vod_b=? AND status='pending' AND evidence_hash!=?`, vodA, vodB, hash);
    const insert = statement(env, `INSERT OR IGNORE INTO session_link_proposals(id,session_a,session_b,vod_a,vod_b,offset_seconds,support,distinct_names,conflicts,coverage,tolerance,evidence_hash,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending')`, id, sessionA, sessionB, vodA, vodB, result.offset, result.support.length, result.distinct_names,
      result.conflicts.length, result.coverage, coalesce.tolerance, hash);
    const items = statement(env, `INSERT OR IGNORE INTO proposal_evidence(proposal_id,detection_a,detection_b,delta,kind)
      SELECT ?1,json_extract(value,'$.a'),json_extract(value,'$.b'),json_extract(value,'$.delta'),json_extract(value,'$.kind') FROM json_each(?2)
      WHERE EXISTS(SELECT 1 FROM session_link_proposals WHERE id=?1)`, id, JSON.stringify(evidence));
    const [, inserted] = await env.DB.batch([stale, insert, items]);
    if (!inserted.meta.changes) continue;
    const created: Created = { id, vod_a: vodA, vod_b: vodB, support: result.support.length, accepted: false };
    created.accepted = await autoAccept(env, id).catch(error => {
      console.log(JSON.stringify({ event: 'session_auto_accept_failed', proposal: id, error: String(error) }));
      return false;
    });
    made.push(created);
  }
  return made;
}

/** Scheduled sweep: Recordings that finished processing and have not been evaluated since they last changed. */
export async function sweepProposals(env: Env, limit = 3) {
  await supersedeStale(env);
  const pending = await rows<{ id: number }>(env, `SELECT id FROM vods WHERE status='completed' AND (proposals_checked_at IS NULL OR proposals_checked_at<updated_at)
    AND EXISTS(SELECT 1 FROM matchup_anchors WHERE vod_id=vods.id) ORDER BY proposals_checked_at IS NOT NULL,proposals_checked_at,id LIMIT ?`, limit);
  for (const { id } of pending)
    await proposeForRecording(env, id).catch(error => console.log(JSON.stringify({ event: 'session_proposal_failed', vod_id: id, error: String(error) })));
  return pending.length;
}
/** Pending proposals whose Sessions merged or whose Recordings moved are no longer actionable. */
export async function supersedeStale(env: Env) {
  const result = await statement(env, `UPDATE session_link_proposals SET status='superseded' WHERE status='pending' AND (
    NOT EXISTS(SELECT 1 FROM recording_alignments g WHERE g.vod_id=vod_a AND g.session_id=session_a AND g.revoked_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM recording_alignments g WHERE g.vod_id=vod_b AND g.session_id=session_b AND g.revoked_at IS NULL)
    OR EXISTS(SELECT 1 FROM sessions s WHERE s.id IN(session_a,session_b) AND s.merged_into IS NOT NULL))`).run();
  return result.meta.changes;
}

async function proposal(env: Env, id: string) {
  requireValue(typeof id === 'string' && /^[0-9a-f]{32}$/.test(id), 'Invalid proposal ID');
  const row = await one(env, 'SELECT * FROM session_link_proposals WHERE id=?', id);
  if (!row) throw new HttpError(404, 'Proposal not found');
  return row;
}
async function decide(env: Env, id: string, status: 'accepted' | 'rejected', by: string, note: string | null, rule: boolean) {
  const result = await statement(env, `UPDATE session_link_proposals SET status=?,decided_by=?,decided_at=?,decision_note=?,decided_by_rule=? WHERE id=? AND status='pending'`,
    status, by, now(), note, rule ? 1 : 0, id).run();
  if (!result.meta.changes) throw new HttpError(409, 'Proposal is no longer pending');
}
function actor(value: unknown) {
  const text = value ?? 'admin';
  requireValue(typeof text === 'string' && text.length > 0 && text.length <= 200, 'Invalid actor');
  return text;
}
function note(value: unknown) {
  requireValue(value == null || (typeof value === 'string' && value.length <= 2000), 'Invalid note');
  return (value as string | null) ?? null;
}

/**
 * Accepts a pending proposal by merging Session B into Session A. mergeSessions refuses Streamer conflicts (D7) unless
 * `streamerId` names the Streamer to keep; the proposal then stays pending.
 */
export async function acceptProposal(env: Env, id: string, how: { actor: string; note?: string | null; streamerId?: number | null; rule?: boolean }) {
  const row = await proposal(env, id), by = actor(how.actor), text = note(how.note);
  if (row.status !== 'pending') throw new HttpError(409, 'Proposal is no longer pending');
  const [a, b] = [await sessionOfVod(env, row.vod_a), await sessionOfVod(env, row.vod_b)];
  if (a !== row.session_a || b !== row.session_b) {
    await supersedeStale(env);
    throw new HttpError(409, 'The Recordings moved since this proposal was made; it is superseded');
  }
  const evidence = `Session link proposal ${id}: ${row.support} matching appearances, offset ${row.offset_seconds}s${text ? `. ${text}` : ''}`.slice(0, 2000);
  const merged = await mergeSessions(env, row.session_a, row.session_b, row.offset_seconds,
    { actor: by, evidence, method: how.rule ? 'auto-rule' : 'proposal', proposal_id: id }, how.streamerId);
  await decide(env, id, 'accepted', by, text, !!how.rule);
  // Other pending proposals touching the merged Session are re-evaluated by the sweep; mark the obvious ones now.
  await supersedeStale(env);
  return { proposal: await proposal(env, id), ...merged };
}
export async function rejectProposal(env: Env, id: string, how: { actor: string; note?: string | null }) {
  const row = await proposal(env, id);
  if (row.status !== 'pending') throw new HttpError(409, 'Proposal is no longer pending');
  await decide(env, id, 'rejected', actor(how.actor), note(how.note), false);
  return proposal(env, id);
}
/** The disabled-by-default rule. With it off nothing takes effect without an operator. */
async function autoAccept(env: Env, id: string) {
  const rule = await autoAcceptConfig(env);
  if (!rule.enabled) return false;
  const row = await proposal(env, id);
  if (row.support < rule.min_support || row.distinct_names < rule.min_distinct_names || row.conflicts / Math.max(1, row.support) > rule.max_conflict_ratio) return false;
  if (rule.require_same_streamer) {
    const [x, y] = [await streamerOf(env, row.session_a), await streamerOf(env, row.session_b)];
    if (x === null || x !== y) return false;
  }
  await acceptProposal(env, id, { actor: 'auto-rule', note: 'Accepted by the session_auto_accept rule', rule: true });
  return true;
}

export async function listProposals(env: Env, options: { status?: string; offset: number; limit: number }) {
  requireValue(options.status === undefined || ['pending', 'accepted', 'rejected', 'superseded'].includes(options.status), 'Invalid status');
  return rows(env, `SELECT * FROM session_link_proposals WHERE (?1 IS NULL OR status=?1) ORDER BY created_at DESC,id LIMIT ?2 OFFSET ?3`,
    options.status ?? null, options.limit, options.offset);
}
export async function getProposal(env: Env, id: string) {
  const row = await proposal(env, id);
  const evidence = await rows(env, `SELECT e.kind,e.detection_a,e.detection_b,e.delta,da.username AS name_a,db.username AS name_b,
      da.frame_time_seconds AS time_a,db.frame_time_seconds AS time_b,da.storage_path AS screenshot_a,db.storage_path AS screenshot_b
    FROM proposal_evidence e LEFT JOIN detections da ON da.id=e.detection_a LEFT JOIN detections db ON db.id=e.detection_b
    WHERE e.proposal_id=? ORDER BY e.kind,da.frame_time_seconds`, id);
  return { ...row, evidence };
}

export async function proposalsAdminRoute(req: Request, env: Env, path: string): Promise<Response> {
  const base = path.slice('/api/admin/session-proposals'.length), url = new URL(req.url);
  if (base === '' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    integer(limit, 'limit', 1, 200); integer(offset, 'offset', 0, 1e6);
    return Response.json(await listProposals(env, { status: url.searchParams.get('status') ?? undefined, offset, limit }));
  }
  if (base === '/generate' && req.method === 'POST') {
    const data = await body(req);
    return Response.json(await proposeForRecording(env, data.vod_id));
  }
  const match = base.match(/^\/([0-9a-f]{32})(?:\/(accept|reject))?$/);
  if (!match) throw new HttpError(404, 'Unknown session-proposals endpoint');
  const [, id, action] = match;
  if (!action && req.method === 'GET') return Response.json(await getProposal(env, id));
  if (!action || req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const data = await body(req);
  if (action === 'accept') return Response.json(await acceptProposal(env, id, { actor: data.actor ?? 'admin', note: data.note ?? data.evidence, streamerId: data.streamer_id }));
  return Response.json(await rejectProposal(env, id, { actor: data.actor ?? 'admin', note: data.note ?? data.evidence }));
}
