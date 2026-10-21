import { atomic } from './atomic';
import { body, HttpError, integer, now, one, requireValue, rows, statement } from './http';
import { trigrams } from './search';

/**
 * Matchup coalescing. A Matchup is a connected component of anchors: auto edges (two Recordings of one Session,
 * session times within the tolerance, similar names) plus manual `link` overrides, minus `unlink` overrides.
 * The canonical ID of a component is its lowest anchor ID (every anchor founded a Matchup with its own ID, so
 * that row always exists). Everything is recomputed from the edges, so a run on unchanged input writes nothing.
 */
export interface CoalesceConfig { tolerance: number; similarity: number }
export interface Actor { actor: string; evidence?: string | null }
export interface AnchorRow { id: number; vod_id: number; matchup_id: number; session_id: string | null; t: number | null; name: string | null }
export interface OverrideRow { id: string; action: 'link' | 'unlink'; anchor_a: number; anchor_b: number; actor: string; rid?: number }
export interface Conflict { link: [number, number]; unlink: [number, number] }
export interface Assignment { canonical: Map<number, number>; origin: Map<number, 'auto' | 'manual' | 'legacy-group'>; conflicts: Conflict[] }
export interface CoalesceResult { changed: number; retired: number; revived: number; conflicts: Conflict[]; event_id: string | null }

export const DEFAULT_TOLERANCE = 3;
export const DEFAULT_SIMILARITY = 0.8;
const MAX_TOLERANCE = 30;
const MAX_ANCHORS = 8000;
const MIN_SIMILAR_LENGTH = 4;
const hex = () => crypto.randomUUID().replaceAll('-', '');
const json = (value: unknown) => JSON.stringify(value);

export async function coalesceConfig(env: Env): Promise<CoalesceConfig> {
  const settings = await rows<{ key: string; value: string }>(env,
    "SELECT key,value FROM processing_config WHERE key IN('coalesce_tolerance_seconds','coalesce_name_similarity')");
  const read = (key: string, fallback: number, min: number, max: number) => {
    const raw = settings.find(s => s.key === key)?.value;
    const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return { tolerance: read('coalesce_tolerance_seconds', DEFAULT_TOLERANCE, 0, MAX_TOLERANCE),
    similarity: read('coalesce_name_similarity', DEFAULT_SIMILARITY, 0.5, 1) };
}

/** Exact (case-insensitive) match, or trigram Jaccard >= threshold when both names have at least four characters. */
export function namesMatch(a: string | null, b: string | null, similarity: number, cache?: Map<string, Set<string>>) {
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  if ([...a].length < MIN_SIMILAR_LENGTH || [...b].length < MIN_SIMILAR_LENGTH) return false;
  const grams = (name: string) => {
    const key = name.toLowerCase();
    let found = cache?.get(key);
    if (!found) { found = new Set(trigrams(key)); cache?.set(key, found); }
    return found;
  };
  const [x, y] = [grams(a), grams(b)];
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared) >= similarity;
}

/** Pure: components of the edge graph. Link overrides are hard edges, unlink overrides forbid joins, and a link that would
 * join the two sides of a forbidden pair is reported and skipped rather than silently resolved. */
export function computeAssignment(anchors: AnchorRow[], overrides: OverrideRow[], config: CoalesceConfig): Assignment {
  const byId = new Map(anchors.map(a => [a.id, a]));
  const parent = new Map<number, number>(), members = new Map<number, number[]>(), vods = new Map<number, Set<number>>();
  for (const a of anchors) { parent.set(a.id, a.id); members.set(a.id, [a.id]); vods.set(a.id, new Set([a.vod_id])); }
  const find = (x: number): number => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const forbidden = new Map<number, Set<number>>();
  const usable = overrides.filter(o => byId.has(o.anchor_a) && byId.has(o.anchor_b));
  for (const o of usable) if (o.action === 'unlink') {
    if (!forbidden.has(o.anchor_a)) forbidden.set(o.anchor_a, new Set());
    if (!forbidden.has(o.anchor_b)) forbidden.set(o.anchor_b, new Set());
    forbidden.get(o.anchor_a)!.add(o.anchor_b); forbidden.get(o.anchor_b)!.add(o.anchor_a);
  }
  const blocked = (ra: number, rb: number): [number, number] | null => {
    const [small, large] = members.get(ra)!.length <= members.get(rb)!.length ? [ra, rb] : [rb, ra];
    for (const x of members.get(small)!) for (const y of forbidden.get(x) ?? []) if (find(y) === large) return [Math.min(x, y), Math.max(x, y)];
    return null;
  };
  const union = (ra: number, rb: number) => {
    const [keep, drop] = members.get(ra)!.length >= members.get(rb)!.length ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    members.get(keep)!.push(...members.get(drop)!); members.delete(drop);
    for (const v of vods.get(drop)!) vods.get(keep)!.add(v); vods.delete(drop);
  };
  const conflicts: Conflict[] = [], linked: Array<[number, number, 'manual' | 'legacy-group']> = [];
  for (const o of usable.filter(o => o.action === 'link').sort((a, b) => a.anchor_a - b.anchor_a || a.anchor_b - b.anchor_b)) {
    const [ra, rb] = [find(o.anchor_a), find(o.anchor_b)];
    if (ra !== rb) {
      const hit = blocked(ra, rb);
      if (hit) { conflicts.push({ link: [o.anchor_a, o.anchor_b], unlink: hit }); continue; }
      union(ra, rb);
    }
    linked.push([o.anchor_a, o.anchor_b, o.actor === 'legacy-group' ? 'legacy-group' : 'manual']);
  }
  // Sweep each Session in time order; only different Recordings can be an auto edge.
  const timed = anchors.filter(a => a.session_id !== null && a.t !== null && a.name)
    .sort((a, b) => (a.session_id! < b.session_id! ? -1 : a.session_id! > b.session_id! ? 1 : 0) || a.t! - b.t! || a.id - b.id);
  const cache = new Map<string, Set<string>>(), edges: Array<[number, number, number]> = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length && timed[j].session_id === timed[i].session_id && timed[j].t! - timed[i].t! <= config.tolerance; j++)
      if (timed[i].vod_id !== timed[j].vod_id && namesMatch(timed[i].name, timed[j].name, config.similarity, cache))
        edges.push([Math.abs(timed[j].t! - timed[i].t!), Math.min(timed[i].id, timed[j].id), Math.max(timed[i].id, timed[j].id)]);
  for (const [, a, b] of edges.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])) {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb || [...vods.get(ra)!].some(v => vods.get(rb)!.has(v)) || blocked(ra, rb)) continue;
    union(ra, rb);
  }
  const canonical = new Map<number, number>(), minimum = new Map<number, number>();
  for (const a of anchors) { const r = find(a.id); minimum.set(r, Math.min(minimum.get(r) ?? Infinity, a.id)); }
  for (const a of anchors) canonical.set(a.id, minimum.get(find(a.id))!);
  const origin = new Map<number, 'auto' | 'manual' | 'legacy-group'>();
  for (const root of minimum.values()) origin.set(root, 'auto');
  for (const [a, , kind] of linked) {
    const c = canonical.get(a)!;
    if (origin.get(c) === 'auto' || kind === 'manual') origin.set(c, kind === 'manual' || origin.get(c) === 'manual' ? 'manual' : 'legacy-group');
  }
  return { canonical, origin, conflicts };
}

interface Universe { anchors: AnchorRow[]; overrides: OverrideRow[]; revision: number }
async function loadUniverse(env: Env, seeds: number[]): Promise<Universe> {
  // Stable Detection IDs no longer signal a correction through pointer changes.
  // Fence the name/visibility revision as well as the component/override topology.
  const revision = (await one<{ revision: number }>(env, 'SELECT revision FROM public_search_state WHERE id=1'))!.revision;
  const ids = new Set(seeds);
  const overrides = new Map<string, OverrideRow>();
  for (let round = 0; round < 6 && ids.size; round++) {
    requireValue(ids.size <= MAX_ANCHORS, 'Too many anchors to coalesce in one run');
    const list = json([...ids]), before = ids.size;
    for (const r of await rows<{ id: number }>(env, `SELECT id FROM matchup_anchors WHERE matchup_id IN
      (SELECT matchup_id FROM matchup_anchors WHERE id IN(SELECT value FROM json_each(?)))`, list)) ids.add(r.id);
    for (const o of await rows<OverrideRow>(env, `SELECT id,action,anchor_a,anchor_b,actor,rowid AS rid FROM matchup_overrides WHERE revoked_at IS NULL
      AND (anchor_a IN(SELECT value FROM json_each(?1)) OR anchor_b IN(SELECT value FROM json_each(?1)))`, list)) {
      overrides.set(o.id, o); ids.add(o.anchor_a); ids.add(o.anchor_b);
    }
    if (ids.size === before) break;
  }
  const anchors = ids.size ? await rows<AnchorRow>(env, `SELECT a.id,a.vod_id,a.matchup_id,g.session_id,a.anchor_seconds+g.offset_seconds AS t,
    CASE WHEN d.name_state IN('legacy','complete') AND d.confidence>0.7 THEN d.username_lower END AS name
    FROM matchup_anchors a LEFT JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL
      AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end)
    LEFT JOIN detections d ON d.id=a.current_detection_id WHERE a.id IN(SELECT value FROM json_each(?)) ORDER BY a.id`, json([...ids])) : [];
  return { anchors, overrides: [...overrides.values()], revision };
}

interface MatchupRow { id: number; status: 'visible' | 'hidden'; merged_into: number | null; origin: string }
const FENCE_ANCHORS = 'SELECT (SELECT count(*)||\':\'||coalesce(sum(matchup_id*31+id),0) FROM matchup_anchors WHERE id IN(SELECT value FROM json_each(?)))=?';
const FENCE_OVERRIDES = `SELECT (SELECT count(*)||':'||coalesce(max(rowid),0) FROM matchup_overrides WHERE revoked_at IS NULL
  AND (anchor_a IN(SELECT value FROM json_each(?)) OR anchor_b IN(SELECT value FROM json_each(?))))=?`;
const FENCE_MATCHUPS = "SELECT (SELECT count(*)||':'||coalesce(sum(coalesce(merged_into,0)),0)||':'||coalesce(sum(status='hidden'),0) FROM matchups WHERE id IN(SELECT value FROM json_each(?)))=?";
const CHUNK = 1000;
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** Recomputes the Matchups touching `seeds` and writes only what differs. */
async function reconcile(env: Env, seeds: number[], trigger: Record<string, unknown>, by: string, config?: CoalesceConfig): Promise<CoalesceResult> {
  const settings = config ?? await coalesceConfig(env);
  for (let attempt = 0; ; attempt++) {
    const universe = await loadUniverse(env, seeds);
    const result = await apply(env, universe, settings, trigger, by);
    if (result) return result;
    if (attempt >= 3) throw new HttpError(409, 'Matchups changed while coalescing; try again');
  }
}
async function apply(env: Env, { anchors, overrides, revision }: Universe, config: CoalesceConfig, trigger: Record<string, unknown>, by: string): Promise<CoalesceResult | null> {
  const empty: CoalesceResult = { changed: 0, retired: 0, revived: 0, conflicts: [], event_id: null };
  if (!anchors.length) return empty;
  const { canonical, origin, conflicts } = computeAssignment(anchors, overrides, config);
  const anchorIds = anchors.map(a => a.id), oldIds = [...new Set(anchors.map(a => a.matchup_id))];
  const rowIds = [...new Set([...anchorIds, ...oldIds])];
  const matchups = new Map((await rows<MatchupRow>(env, 'SELECT id,status,merged_into,origin FROM matchups WHERE id IN(SELECT value FROM json_each(?))', json(rowIds))).map(m => [m.id, m]));
  const present = new Set(anchorIds);
  const moves = anchors.filter(a => canonical.get(a.id) !== a.matchup_id).map(a => ({ a: a.id, from: a.matchup_id, to: canonical.get(a.id)! }));
  // Desired pointer of every Matchup row whose ID is an anchor in the run; rows without an anchor follow their old anchors.
  const desired = new Map<number, number | null>();
  for (const a of anchors) if (matchups.has(a.id)) desired.set(a.id, canonical.get(a.id) === a.id ? null : canonical.get(a.id)!);
  for (const old of oldIds) if (!present.has(old) && matchups.has(old))
    desired.set(old, canonical.get(anchors.find(a => a.matchup_id === old)!.id)!);
  const rowChanges = [...desired].filter(([id, target]) => matchups.get(id)!.merged_into !== target);
  if (!moves.length && !rowChanges.length) return { ...empty, conflicts };

  const hiddenOf = (id: number) => matchups.get(id)?.status === 'hidden';
  const touched = new Set<number>(moves.map(m => canonical.get(m.a)!));
  for (const [id, target] of rowChanges) if (target === null) touched.add(id);
  const retiredNow = rowChanges.filter(([, target]) => target !== null).map(([id]) => id);
  const revived = rowChanges.filter(([, target]) => target === null).map(([id]) => id);
  const state = [...touched].map(c => ({ id: c, origin: origin.get(c)!,
    status: anchors.some(a => canonical.get(a.id) === c && hiddenOf(a.matchup_id)) ? 'hidden' : 'visible' }));
  const retireRows = rowChanges.filter(([, target]) => target !== null).map(([id, target]) => ({ id, to: target, origin: origin.get(target!)! }));
  const affected = [...new Set([...rowIds, ...state.map(s => s.id)])];
  const event = hex(), stamp = now();
  const payload = { ...trigger, moves: moves.slice(0, 500), moved: moves.length, retired: retiredNow, revived, conflicts };
  const checks = [
    { sql: 'SELECT revision=? FROM public_search_state WHERE id=1', args: [revision] },
    { sql: FENCE_ANCHORS, args: [json(anchorIds), `${anchors.length}:${anchors.reduce((sum, a) => sum + a.matchup_id * 31 + a.id, 0)}`] },
    { sql: FENCE_OVERRIDES, args: [json(anchorIds), json(anchorIds), `${overrides.length}:${overrides.reduce((m, o) => Math.max(m, o.rid ?? 0), 0)}`] },
    { sql: FENCE_MATCHUPS, args: [json(rowIds), `${matchups.size}:${[...matchups.values()].reduce((sum, m) => sum + (m.merged_into ?? 0), 0)}:${[...matchups.values()].filter(m => m.status === 'hidden').length}`] },
  ];
  const writes: D1PreparedStatement[] = [];
  for (const part of chunks(moves)) writes.push(statement(env, `UPDATE matchup_anchors SET matchup_id=(SELECT json_extract(value,'$.to') FROM json_each(?1) WHERE json_extract(value,'$.a')=matchup_anchors.id)
    WHERE id IN(SELECT json_extract(value,'$.a') FROM json_each(?1))`, json(part)));
  for (const part of chunks(retireRows)) writes.push(statement(env, `UPDATE matchups SET merged_into=(SELECT json_extract(value,'$.to') FROM json_each(?1) WHERE json_extract(value,'$.id')=matchups.id),
    origin=(SELECT json_extract(value,'$.origin') FROM json_each(?1) WHERE json_extract(value,'$.id')=matchups.id),updated_at=?2
    WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?1))`, json(part), stamp));
  for (const part of chunks(state)) writes.push(statement(env, `UPDATE matchups SET merged_into=NULL,
    status=(SELECT json_extract(value,'$.status') FROM json_each(?1) WHERE json_extract(value,'$.id')=matchups.id),
    origin=(SELECT json_extract(value,'$.origin') FROM json_each(?1) WHERE json_extract(value,'$.id')=matchups.id),updated_at=?2
    WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?1))`, json(part), stamp));
  if (retiredNow.length) for (const part of chunks(retiredNow)) writes.push(statement(env, `UPDATE matchups SET merged_into=(SELECT p.merged_into FROM matchups p WHERE p.id=matchups.merged_into)
    WHERE merged_into IN(SELECT value FROM json_each(?1)) AND (SELECT p.merged_into FROM matchups p WHERE p.id=matchups.merged_into) IS NOT NULL`, json(part)));
  for (const part of chunks(affected)) {
    for (const table of ['matchup_likes', 'matchup_favorites', 'matchup_comments'])
      writes.push(statement(env, `UPDATE ${table} SET matchup_id=coalesce((SELECT merged_into FROM matchups WHERE id=${table}.origin_id),${table}.origin_id)
        WHERE (origin_id IN(SELECT value FROM json_each(?1)) OR matchup_id IN(SELECT value FROM json_each(?1)))
        AND matchup_id IS NOT coalesce((SELECT merged_into FROM matchups WHERE id=${table}.origin_id),${table}.origin_id)`, json(part)));
    writes.push(statement(env, `UPDATE social_reports SET matchup_id=coalesce((SELECT merged_into FROM matchups WHERE id=social_reports.origin_id),social_reports.origin_id)
      WHERE origin_id IS NOT NULL AND (origin_id IN(SELECT value FROM json_each(?1)) OR matchup_id IN(SELECT value FROM json_each(?1)))
      AND matchup_id IS NOT coalesce((SELECT merged_into FROM matchups WHERE id=social_reports.origin_id),social_reports.origin_id)`, json(part)));
  }
  // D5: one reporter keeps the earliest open report on a Matchup; later duplicates are dismissed (origin keeps them distinct).
  for (const part of chunks([...touched])) writes.push(statement(env, `UPDATE social_reports SET status='dismissed',updated_at=?2
    WHERE comment_id IS NULL AND status='open' AND matchup_id IN(SELECT value FROM json_each(?1))
    AND sequence>(SELECT min(r.sequence) FROM social_reports r WHERE r.reporter_id=social_reports.reporter_id AND r.comment_id IS NULL AND r.matchup_id=social_reports.matchup_id)`, json(part), stamp));
  for (const part of chunks([...touched])) writes.push(statement(env, `UPDATE matchups SET
    session_id=(SELECT v.session_id FROM matchup_anchors a JOIN vods v ON v.id=a.vod_id WHERE a.id=matchups.id),
    session_time=(SELECT a.anchor_seconds+g.offset_seconds FROM matchup_anchors a JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL
      AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end) WHERE a.id=matchups.id)
    WHERE id IN(SELECT value FROM json_each(?1)) AND EXISTS(SELECT 1 FROM matchup_anchors a WHERE a.id=matchups.id)`, json(part)));
  writes.push(statement(env, 'INSERT INTO matchup_events(id,action,payload,actor,created_at) VALUES(?,?,?,?,?)', event, 'coalesce', json(payload), by, stamp));
  try { await atomic(env, checks, writes); }
  catch (error) { if (error instanceof HttpError && error.status === 409) return null; throw error; }
  return { changed: moves.length, retired: retiredNow.length, revived: revived.length, conflicts, event_id: event };
}
async function sessionAnchors(env: Env, session: string) {
  return (await rows<{ id: number }>(env, `SELECT a.id FROM matchup_anchors a WHERE a.vod_id IN
    (SELECT vod_id FROM recording_alignments WHERE session_id=? AND revoked_at IS NULL) ORDER BY a.id`, session)).map(r => r.id);
}
/** Coalesces every anchor of the Session's Recordings (and whatever they are already merged with). */
export async function coalesceSession(env: Env, session: string, by = 'coalesce') {
  const dirty = await one<{ coalesce_dirty: number }>(env, 'SELECT coalesce_dirty FROM sessions WHERE id=?', session);
  if (!dirty) throw new HttpError(404, 'Session not found');
  const result = await reconcile(env, await sessionAnchors(env, session), { trigger: 'session', session }, by);
  await statement(env, 'UPDATE sessions SET coalesce_dirty=0 WHERE id=? AND coalesce_dirty=?', session, dirty.coalesce_dirty).run();
  return result;
}
/** Coalesces the Session that holds a Recording; a Session of one Recording has nothing to match across. */
export async function coalesceVod(env: Env, vodId: number) {
  const sessions = await rows<{ session_id: string }>(env, `SELECT DISTINCT g.session_id FROM recording_alignments g WHERE g.vod_id=? AND g.revoked_at IS NULL
    AND (SELECT count(DISTINCT vod_id) FROM recording_alignments WHERE session_id=g.session_id AND revoked_at IS NULL)>1`, vodId);
  for (const { session_id } of sessions) await markAndCoalesce(env, [session_id]);
}
/** Marks Sessions dirty first so a failure leaves them for the scheduled reconcile, then tries to coalesce now. */
export async function markAndCoalesce(env: Env, sessions: string[], by = 'coalesce') {
  const unique = [...new Set(sessions)];
  if (!unique.length) return;
  await statement(env, 'UPDATE sessions SET coalesce_dirty=coalesce_dirty+1 WHERE id IN(SELECT value FROM json_each(?))', json(unique)).run();
  for (const session of unique) {
    try { await coalesceSession(env, session, by); }
    catch (error) { console.log(JSON.stringify({ event: 'coalesce_failed', session, error: String(error) })); }
  }
}
/** Scheduled reconcile: Sessions flagged dirty by detections or alignment changes. */
export async function reconcileDirtySessions(env: Env, limit = 5) {
  const dirty = await rows<{ id: string }>(env, 'SELECT id FROM sessions WHERE coalesce_dirty>0 AND merged_into IS NULL ORDER BY id LIMIT ?', limit);
  for (const { id } of dirty) {
    try { await coalesceSession(env, id, 'reconcile'); }
    catch (error) { console.log(JSON.stringify({ event: 'coalesce_failed', session: id, error: String(error) })); }
  }
  return dirty.length;
}

/** Follows `merged_into` to the canonical Matchup (null when the ID never existed). */
export async function canonicalMatchup(env: Env, id: number) {
  const row = await one<{ id: number }>(env, `WITH RECURSIVE chain(id,merged_into,depth) AS (
    SELECT id,merged_into,0 FROM matchups WHERE id=? UNION ALL SELECT m.id,m.merged_into,c.depth+1 FROM matchups m JOIN chain c ON m.id=c.merged_into WHERE c.depth<8)
    SELECT id FROM chain WHERE merged_into IS NULL`, id);
  return row?.id ?? null;
}

function overrideInput(how: Actor) {
  requireValue(how && typeof how.actor === 'string' && how.actor.length > 0 && how.actor.length <= 200, 'Invalid actor');
  requireValue(typeof how.evidence === 'string' && how.evidence.trim().length >= 10 && how.evidence.trim().length <= 4000, 'Provide a substantive verification note');
  return { actor: how.actor, evidence: how.evidence.trim() };
}
async function requireAnchors(env: Env, ids: number[]) {
  const found = await rows<{ id: number; matchup_id: number }>(env, 'SELECT id,matchup_id FROM matchup_anchors WHERE id IN(SELECT value FROM json_each(?))', json(ids));
  if (found.length !== new Set(ids).size) throw new HttpError(404, 'Anchor not found');
  return found;
}
const pair = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
const activeOverride = `NOT EXISTS(SELECT 1 FROM matchup_overrides WHERE action=? AND anchor_a=? AND anchor_b=? AND revoked_at IS NULL)`;

/** Creates link overrides for every pair of `anchorIds` that is not already hard-linked, then coalesces. */
export async function linkAnchors(env: Env, anchorIds: number[], how: Actor) {
  const by = overrideInput(how), ids = [...new Set(anchorIds)].sort((a, b) => a - b);
  requireValue(ids.length >= 2 && ids.length <= 50, 'Provide 2–50 anchors');
  ids.forEach(id => integer(id, 'anchor ID', 1));
  await requireAnchors(env, ids);
  const star = ids.slice(1).map(id => pair(ids[0], id));
  const opposing = await rows(env, `SELECT 1 FROM matchup_overrides WHERE action='unlink' AND revoked_at IS NULL AND anchor_a IN(SELECT value FROM json_each(?1)) AND anchor_b IN(SELECT value FROM json_each(?1)) LIMIT 1`, json(ids));
  if (opposing.length) throw new HttpError(409, 'An unlink override covers these anchors; revoke it first');
  const mutations = star.map(([a, b]) => statement(env, `INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor,created_at)
    SELECT ?,?,?,?,?,?,? WHERE ${activeOverride}`, crypto.randomUUID(), 'link', a, b, by.evidence, by.actor, now(), 'link', a, b));
  await env.DB.batch(mutations);
  const result = await reconcile(env, ids, { trigger: 'link', anchors: ids, evidence: by.evidence }, by.actor);
  return { ...result, matchup_id: (await one<{ matchup_id: number }>(env, 'SELECT matchup_id FROM matchup_anchors WHERE id=?', ids[0]))!.matchup_id };
}
/** Hard-links two Matchups through their lowest anchors. The surviving ID is the lowest anchor of the union. */
export async function mergeMatchups(env: Env, winner: number, loser: number, how: Actor) {
  integer(winner, 'matchup ID', 1); integer(loser, 'matchup ID', 1);
  requireValue(winner !== loser, 'Cannot merge a Matchup into itself');
  const [a, b] = [await canonicalMatchup(env, winner), await canonicalMatchup(env, loser)];
  if (a === null || b === null) throw new HttpError(404, 'Matchup not found');
  requireValue(a !== b, 'Matchups are already merged');
  const lowest = async (id: number) => (await one<{ id: number | null }>(env, 'SELECT min(id) AS id FROM matchup_anchors WHERE matchup_id=?', id))?.id;
  const [x, y] = [await lowest(a), await lowest(b)];
  if (!x || !y) throw new HttpError(409, 'Matchup has no anchors');
  const result = await linkAnchors(env, [x, y], how);
  return { ...result, merged: [a, b] };
}
/** Separates `anchorIds` from the rest of their Matchup: forbids every cross pair and revokes the links that joined them. */
export async function splitMatchup(env: Env, matchupId: number, anchorIds: number[], how: Actor) {
  const by = overrideInput(how);
  const canonical = await canonicalMatchup(env, integer(matchupId, 'matchup ID', 1));
  if (canonical === null) throw new HttpError(404, 'Matchup not found');
  const all = (await rows<{ id: number }>(env, 'SELECT id FROM matchup_anchors WHERE matchup_id=? ORDER BY id', canonical)).map(r => r.id);
  const part = [...new Set(anchorIds)].sort((a, b) => a - b);
  requireValue(part.length >= 1 && part.every(id => all.includes(id)), 'Anchors must belong to the Matchup');
  const rest = all.filter(id => !part.includes(id));
  requireValue(rest.length >= 1, 'A split must leave anchors on both sides');
  requireValue(part.length * rest.length <= 400, 'Split is too large; split fewer anchors');
  const cross = part.flatMap(p => rest.map(r => pair(p, r)));
  const stamp = now();
  await env.DB.batch([
    statement(env, `UPDATE matchup_overrides SET revoked_at=?1,revoked_by=?2 WHERE action='link' AND revoked_at IS NULL
      AND ((anchor_a IN(SELECT value FROM json_each(?3)) AND anchor_b IN(SELECT value FROM json_each(?4))) OR (anchor_a IN(SELECT value FROM json_each(?4)) AND anchor_b IN(SELECT value FROM json_each(?3))))`,
      stamp, by.actor, json(part), json(rest)),
    ...cross.map(([a, b]) => statement(env, `INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${activeOverride}`, crypto.randomUUID(), 'unlink', a, b, by.evidence, by.actor, stamp, 'unlink', a, b)),
  ]);
  return reconcile(env, all, { trigger: 'split', matchup: canonical, anchors: part, evidence: by.evidence }, by.actor);
}
export async function revokeOverride(env: Env, id: string, how: { actor: string }) {
  requireValue(typeof id === 'string' && id.length > 0 && id.length <= 200, 'Invalid override ID');
  const row = await one<{ anchor_a: number; anchor_b: number }>(env, 'SELECT anchor_a,anchor_b FROM matchup_overrides WHERE id=? AND revoked_at IS NULL', id);
  if (!row) throw new HttpError(404, 'Active override not found');
  requireValue(typeof how.actor === 'string' && how.actor.length > 0, 'Invalid actor');
  await statement(env, 'UPDATE matchup_overrides SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL', now(), how.actor, id).run();
  return reconcile(env, [row.anchor_a, row.anchor_b], { trigger: 'revoke', override: id }, how.actor);
}
export async function createUnlink(env: Env, a: number, b: number, how: Actor) {
  const by = overrideInput(how), [x, y] = pair(a, b);
  requireValue(x !== y, 'Provide two different anchors');
  await requireAnchors(env, [x, y]);
  if (await one(env, "SELECT 1 FROM matchup_overrides WHERE action='link' AND anchor_a=? AND anchor_b=? AND revoked_at IS NULL", x, y))
    throw new HttpError(409, 'A link override covers this pair; revoke it first');
  await env.DB.batch([statement(env, `INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor,created_at)
    SELECT ?,?,?,?,?,?,? WHERE ${activeOverride}`, crypto.randomUUID(), 'unlink', x, y, by.evidence, by.actor, now(), 'unlink', x, y)]);
  return reconcile(env, [x, y], { trigger: 'unlink', anchors: [x, y] }, by.actor);
}

export async function listMatchups(env: Env, options: { after: number; limit: number; multi?: boolean }) {
  return rows(env, `SELECT m.id,m.status,m.origin,m.session_id,m.session_time,
      (SELECT count(*) FROM matchup_anchors a WHERE a.matchup_id=m.id) AS anchor_count,
      (SELECT count(DISTINCT v.session_id) FROM matchup_anchors a JOIN vods v ON v.id=a.vod_id WHERE a.matchup_id=m.id)>1 AS unaligned
    FROM matchups m WHERE m.id>? AND m.merged_into IS NULL AND (?=0 OR (SELECT count(*) FROM matchup_anchors a WHERE a.matchup_id=m.id)>1) ORDER BY m.id LIMIT ?`,
    options.after, options.multi ? 1 : 0, options.limit);
}
export async function getMatchup(env: Env, id: number) {
  const canonical = await canonicalMatchup(env, id);
  if (canonical === null) throw new HttpError(404, 'Matchup not found');
  const matchup = await one(env, 'SELECT * FROM matchups WHERE id=?', canonical);
  const anchors = await rows(env, `SELECT a.id,a.vod_id,a.anchor_seconds,a.current_detection_id,v.session_id,d.username,g.session_id AS aligned_session,
      a.anchor_seconds+g.offset_seconds AS session_time
    FROM matchup_anchors a JOIN vods v ON v.id=a.vod_id LEFT JOIN detections d ON d.id=a.current_detection_id
    LEFT JOIN recording_alignments g ON g.vod_id=a.vod_id AND g.revoked_at IS NULL AND g.rec_start<=a.anchor_seconds AND (g.rec_end IS NULL OR a.anchor_seconds<g.rec_end)
    WHERE a.matchup_id=? ORDER BY a.id`, canonical);
  const ids = json(anchors.map(a => a.id));
  const overrides = await rows(env, `SELECT id,action,anchor_a,anchor_b,evidence,actor,source_group,created_at,revoked_at FROM matchup_overrides
    WHERE anchor_a IN(SELECT value FROM json_each(?1)) OR anchor_b IN(SELECT value FROM json_each(?1)) ORDER BY created_at`, ids);
  const retired = await rows(env, 'SELECT id FROM matchups WHERE merged_into=? ORDER BY id', canonical);
  return { ...matchup, requested_id: id, anchors, overrides, retired_ids: retired.map(r => r.id),
    unaligned: new Set(anchors.map(a => a.session_id)).size > 1 };
}

export async function matchupsAdminRoute(req: Request, env: Env, path: string): Promise<Response> {
  const base = path.slice('/api/admin/matchups'.length), url = new URL(req.url);
  const how = (data: Record<string, any>) => ({ actor: data.actor ?? 'admin', evidence: data.evidence });
  if (base === '' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50), after = Number(url.searchParams.get('after') ?? 0);
    integer(limit, 'limit', 1, 200); integer(after, 'after', 0);
    return Response.json(await listMatchups(env, { after, limit, multi: url.searchParams.get('multi') === '1' }));
  }
  if (/^\/[1-9]\d*$/.test(base) && req.method === 'GET') return Response.json(await getMatchup(env, Number(base.slice(1))));
  if (base === '/overrides' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 100); integer(limit, 'limit', 1, 500);
    return Response.json(await rows(env, 'SELECT * FROM matchup_overrides WHERE revoked_at IS NULL AND created_at>? ORDER BY created_at,id LIMIT ?', url.searchParams.get('after') ?? '', limit));
  }
  const revoke = base.match(/^\/overrides\/([^/]+)$/);
  if (revoke && req.method === 'DELETE') return Response.json(await revokeOverride(env, decodeURIComponent(revoke[1]), how(await body(req))));
  if (req.method !== 'POST') throw new HttpError(404, 'Unknown matchups endpoint');
  const data = await body(req);
  if (base === '/merge') return Response.json(await mergeMatchups(env, data.winner, data.loser, how(data)));
  if (base === '/split') return Response.json(await splitMatchup(env, data.matchup_id, data.anchor_ids, how(data)));
  if (base === '/link') return Response.json(await linkAnchors(env, data.anchor_ids, how(data)));
  if (base === '/unlink') return Response.json(await createUnlink(env, data.anchor_a, data.anchor_b, how(data)));
  if (base === '/coalesce') {
    requireValue(typeof data.session_id === 'string', 'Invalid session ID');
    return Response.json(await coalesceSession(env, data.session_id, data.actor ?? 'admin'));
  }
  throw new HttpError(404, 'Unknown matchups endpoint');
}
