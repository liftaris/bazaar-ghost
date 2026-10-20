import { atomic } from './atomic';
import { markAndCoalesce } from './coalesce';
import { body, HttpError, integer, now, one, requireValue, rows, statement } from './http';

type Input = Record<string, any>;
export interface Segment { rec_start: number; rec_end: number | null; offset_seconds: number }
export interface Provenance { actor: string; evidence?: string | null; method?: 'operator' | 'proposal' | 'auto-rule'; proposal_id?: string | null }

const SESSION_ID = /^[0-9a-f]{32}$/;
const COLUMNS = 'id,session_id,vod_id,rec_start,rec_end,offset_seconds,method,proposal_id,actor,evidence,created_at';
const hex = () => crypto.randomUUID().replaceAll('-', '');
const ACTIVE = 'revoked_at IS NULL';

function sessionId(value: unknown) {
  requireValue(typeof value === 'string' && SESSION_ID.test(value), 'Invalid session ID');
  return value;
}
function provenance(input: Provenance | undefined): Required<Provenance> {
  requireValue(input && typeof input.actor === 'string' && input.actor.length > 0 && input.actor.length <= 200, 'Invalid actor');
  requireValue(input.evidence == null || (typeof input.evidence === 'string' && input.evidence.length <= 2000), 'Invalid evidence');
  const method = input.method ?? 'operator';
  requireValue(method === 'operator' || method === 'proposal' || method === 'auto-rule', 'Invalid alignment method');
  return { actor: input.actor, evidence: input.evidence ?? null, method, proposal_id: input.proposal_id ?? null };
}
function number(value: unknown, label: string) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7, `Invalid ${label}`);
  return value;
}
function segments(value: unknown): Segment[] {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= 50, 'Invalid segments');
  const parsed = value.map((raw: Input) => {
    requireValue(raw && typeof raw === 'object', 'Invalid segment');
    const rec_start = number(raw.rec_start ?? 0, 'rec_start');
    requireValue(rec_start >= 0, 'Invalid rec_start');
    const rec_end = raw.rec_end == null ? null : number(raw.rec_end, 'rec_end');
    requireValue(rec_end === null || rec_end > rec_start, 'rec_end must be after rec_start');
    return { rec_start, rec_end, offset_seconds: number(raw.offset_seconds, 'offset_seconds') };
  }).sort((a, b) => a.rec_start - b.rec_start);
  for (let i = 1; i < parsed.length; i++)
    requireValue(parsed[i - 1].rec_end !== null && parsed[i - 1].rec_end! <= parsed[i].rec_start, 'Segments must not overlap');
  return parsed;
}

/** Pure conversions over a Recording's active segments. Time outside every segment is unmapped (null). */
export function segmentToSession(list: Segment[], recordingTime: number): number | null {
  const hit = list.find(s => s.rec_start <= recordingTime && (s.rec_end === null || recordingTime < s.rec_end));
  return hit ? recordingTime + hit.offset_seconds : null;
}
export function segmentToRecording(list: Segment[], sessionTime: number): number | null {
  for (const s of list) {
    const t = sessionTime - s.offset_seconds;
    if (s.rec_start <= t && (s.rec_end === null || t < s.rec_end)) return t;
  }
  return null;
}
async function activeSegments(env: Env, vodId: number, inSession?: string): Promise<Segment[]> {
  return rows<Segment>(env, `SELECT rec_start,rec_end,offset_seconds FROM recording_alignments
    WHERE vod_id=? AND ${ACTIVE} AND (? IS NULL OR session_id=?) ORDER BY rec_start`, vodId, inSession ?? null, inSession ?? null);
}
export async function toSession(env: Env, vodId: number, recordingTime: number) {
  const row = await one(env, `SELECT session_id FROM recording_alignments WHERE vod_id=? AND ${ACTIVE} AND rec_start<=? AND (rec_end IS NULL OR ?<rec_end)`, vodId, recordingTime, recordingTime);
  if (!row) return null;
  const time = segmentToSession(await activeSegments(env, vodId), recordingTime);
  return time === null ? null : { session_id: row.session_id as string, time };
}
export async function toRecording(env: Env, session: string, vodId: number, sessionTime: number) {
  return segmentToRecording(await activeSegments(env, vodId, sessionId(session)), sessionTime);
}

async function owners(env: Env, id: string) {
  return (await rows(env, `SELECT DISTINCT o.streamer_id FROM recording_alignments g JOIN vods v ON v.id=g.vod_id
    JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL WHERE g.session_id=? AND g.${ACTIVE}`, id)).map(r => r.streamer_id as number);
}
/** Fills the Session's Streamer from its Channels' active owners; never overrides an operator choice between several owners. */
export async function recomputeSessionStreamer(env: Env, id: string) {
  sessionId(id);
  const session = await one(env, 'SELECT streamer_id FROM sessions WHERE id=?', id);
  if (!session) throw new HttpError(404, 'Session not found');
  const found = await owners(env, id);
  if (found.length === 1 && session.streamer_id !== found[0]) {
    await atomic(env, [{ sql: 'SELECT (SELECT streamer_id FROM sessions WHERE id=?) IS ?', args: [id, session.streamer_id] }],
      [statement(env, 'UPDATE sessions SET streamer_id=?,updated_at=? WHERE id=?', found[0], now(), id)]);
  }
  return { streamer_id: found.length === 1 ? found[0] : session.streamer_id as number | null, conflict: found.length > 1 };
}

const recordingJson = (list: Array<Segment & { vod_id: number }>) => JSON.stringify(list);
const insertSegments = (env: Env, session: string, how: Required<Provenance>, event: string, json: string) => statement(env,
  `INSERT INTO recording_alignments(session_id,vod_id,rec_start,rec_end,offset_seconds,method,proposal_id,actor,evidence,event_id,created_at)
   SELECT ?,json_extract(value,'$.vod_id'),json_extract(value,'$.rec_start'),json_extract(value,'$.rec_end'),json_extract(value,'$.offset_seconds'),?,?,?,?,?,?
   FROM json_each(?)`, session, how.method, how.proposal_id, how.actor, how.evidence, event, now(), json);
const revokeVods = (env: Env, actor: string, vodIds: number[]) => statement(env,
  `UPDATE recording_alignments SET revoked_at=?,revoked_by=? WHERE vod_id IN(SELECT value FROM json_each(?)) AND ${ACTIVE}`, now(), actor, JSON.stringify(vodIds));
const eventStatement = (env: Env, event: string, session: string, action: string, payload: unknown, how: Required<Provenance>) => statement(env,
  'INSERT INTO session_events(id,session_id,action,payload,actor,evidence,created_at) VALUES(?,?,?,?,?,?,?)',
  event, session, action, JSON.stringify(payload), how.actor, how.evidence, now());
const fingerprint = (ids: number[]) => ({
  sql: `SELECT (SELECT count(*)||':'||coalesce(max(id),0) FROM recording_alignments WHERE vod_id IN(SELECT value FROM json_each(?)) AND ${ACTIVE})=?`,
  fn: (before: Input[]) => [JSON.stringify(ids), `${before.length}:${before.reduce((m, r) => Math.max(m, r.id), 0)}`],
});
async function activeSession(env: Env, id: string) {
  const row = await one(env, 'SELECT * FROM sessions WHERE id=?', sessionId(id));
  if (!row) throw new HttpError(404, 'Session not found');
  if (row.merged_into) throw new HttpError(409, 'Session was merged into another Session');
  return row;
}
async function activeBefore(env: Env, vodIds: number[]) {
  return rows(env, `SELECT ${COLUMNS} FROM recording_alignments WHERE vod_id IN(SELECT value FROM json_each(?)) AND ${ACTIVE} ORDER BY id`, JSON.stringify(vodIds));
}

/** Replaces the active segments of a Recording with `list` inside `session` (a move when the Recording was elsewhere). */
export async function setAlignment(env: Env, session: string, vodId: number, list: unknown, how: Provenance, action: 'set_alignment' | 'move' = 'set_alignment') {
  sessionId(session); integer(vodId, 'vod ID', 1);
  const by = provenance(how), parsed = segments(list);
  await activeSession(env, session);
  if (!await one(env, 'SELECT 1 FROM vods WHERE id=?', vodId)) throw new HttpError(404, 'Recording not found');
  const before = await activeBefore(env, [vodId]), event = hex(), fp = fingerprint([vodId]);
  const after = parsed.map(s => ({ ...s, vod_id: vodId }));
  await atomic(env, [
    { sql: 'SELECT EXISTS(SELECT 1 FROM sessions WHERE id=? AND merged_into IS NULL)', args: [session] },
    { sql: 'SELECT EXISTS(SELECT 1 FROM vods WHERE id=?)', args: [vodId] },
    { sql: fp.sql, args: fp.fn(before) },
  ], [
    revokeVods(env, by.actor, [vodId]),
    insertSegments(env, session, by, event, recordingJson(after)),
    eventStatement(env, event, session, action, { vod_ids: [vodId], before, after_count: after.length }, by),
  ]);
  await recomputeSessionStreamer(env, session);
  await markAndCoalesce(env, [session, ...before.map(r => r.session_id as string)], by.actor);
  return { event_id: event, session: await getSession(env, session) };
}
export function moveRecording(env: Env, vodId: number, toSession: string, offset: number, how: Provenance) {
  return setAlignment(env, toSession, vodId, [{ rec_start: 0, rec_end: null, offset_seconds: offset }], how, 'move');
}
export async function revokeAlignment(env: Env, alignmentId: number, how: { actor: string; evidence?: string | null }) {
  integer(alignmentId, 'alignment ID', 1);
  const by = provenance({ ...how, method: 'operator' });
  const row = await one(env, `SELECT ${COLUMNS},revoked_at FROM recording_alignments WHERE id=?`, alignmentId);
  if (!row || row.revoked_at) throw new HttpError(404, 'Active alignment not found');
  const event = hex();
  await atomic(env, [
    { sql: `SELECT EXISTS(SELECT 1 FROM recording_alignments WHERE id=? AND ${ACTIVE})`, args: [alignmentId] },
    { sql: `SELECT EXISTS(SELECT 1 FROM recording_alignments WHERE vod_id=? AND id!=? AND ${ACTIVE})`, args: [row.vod_id, alignmentId] },
  ], [
    statement(env, `UPDATE recording_alignments SET revoked_at=?,revoked_by=? WHERE id=? AND ${ACTIVE}`, now(), by.actor, alignmentId),
    eventStatement(env, event, row.session_id, 'revoke', { vod_ids: [row.vod_id], before: [row], after_count: 0 }, by),
  ]).catch(error => {
    if (error instanceof HttpError && error.status === 409) throw new HttpError(409, 'A recording keeps at least one alignment; move it to another Session instead');
    throw error;
  });
  await markAndCoalesce(env, [row.session_id], by.actor);
  return { event_id: event, session: await getSession(env, row.session_id) };
}

/** Moves every Recording of `loser` into `winner` (session_time_winner = session_time_loser + delta). */
export async function mergeSessions(env: Env, winner: string, loser: string, delta: number, how: Provenance, streamerId?: number | null) {
  sessionId(winner); sessionId(loser); number(delta, 'delta');
  requireValue(winner !== loser, 'Cannot merge a Session into itself');
  const by = provenance(how);
  const [a, b] = [await activeSession(env, winner), await activeSession(env, loser)];
  const found = new Set<number>([...(a.streamer_id != null ? [a.streamer_id] : []), ...(b.streamer_id != null ? [b.streamer_id] : []),
    ...await owners(env, winner), ...await owners(env, loser)]);
  const real = (await rows(env, 'SELECT id FROM streamer_identities WHERE provisional_channel_id IS NULL AND id IN(SELECT value FROM json_each(?))',
    JSON.stringify([...found]))).map(r => r.id as number);
  // A provisional Streamer is a placeholder: next to exactly one real Streamer it does not make the merge ambiguous.
  let chosen: number | null = found.size === 1 ? [...found][0] : real.length === 1 ? real[0] : null;
  if (streamerId != null) {
    integer(streamerId, 'streamer ID', 1);
    requireValue(found.size === 0 ? !!await one(env, 'SELECT 1 FROM streamer_identities WHERE id=?', streamerId) : found.has(streamerId),
      'streamer_id must be one of the Streamers involved');
    chosen = streamerId;
  } else if (found.size > 1 && real.length !== 1) {
    throw new HttpError(409, `Sessions belong to different Streamers (${[...found].join(', ')}); choose one with streamer_id`);
  }
  const moving = await rows(env, `SELECT ${COLUMNS} FROM recording_alignments WHERE session_id=? AND ${ACTIVE} ORDER BY id`, loser);
  const vodIds = [...new Set(moving.map(r => r.vod_id as number))];
  const before = await activeBefore(env, vodIds), matchups = await rows(env, 'SELECT id,session_id,session_time FROM matchups WHERE session_id=?', loser);
  const event = hex(), fp = fingerprint(vodIds);
  const after = moving.map(r => ({ vod_id: r.vod_id, rec_start: r.rec_start, rec_end: r.rec_end, offset_seconds: r.offset_seconds + delta }));
  const payload = { winner, loser, delta, vod_ids: vodIds, before, after_count: after.length, matchups,
    streamers: { winner: a.streamer_id, loser: b.streamer_id } };
  await atomic(env, [
    { sql: 'SELECT (SELECT count(*) FROM sessions WHERE id IN(?,?) AND merged_into IS NULL)=2', args: [winner, loser] },
    { sql: 'SELECT (SELECT streamer_id FROM sessions WHERE id=?) IS ? AND (SELECT streamer_id FROM sessions WHERE id=?) IS ?', args: [winner, a.streamer_id, loser, b.streamer_id] },
    { sql: fp.sql, args: fp.fn(before) },
    { sql: 'SELECT (SELECT count(*) FROM matchups WHERE session_id=?)=?', args: [loser, matchups.length] },
  ], [
    statement(env, 'UPDATE matchups SET session_id=?,session_time=session_time+? WHERE session_id=?', winner, delta, loser),
    ...(vodIds.length ? [revokeVods(env, by.actor, vodIds), insertSegments(env, winner, by, event, recordingJson(after))] : []),
    statement(env, 'UPDATE sessions SET merged_into=?,updated_at=? WHERE id=?', winner, now(), loser),
    statement(env, 'UPDATE sessions SET streamer_id=?,updated_at=? WHERE id=? AND streamer_id IS NOT ?', chosen, now(), winner, chosen),
    eventStatement(env, event, winner, 'merge', payload, by),
  ]);
  await markAndCoalesce(env, [winner, loser], by.actor);
  return { event_id: event, session: await getSession(env, winner) };
}

/** Reverses an alignment or merge event when nothing it created has since changed. */
export async function undoSessionEvent(env: Env, eventId: string, how: { actor: string; evidence?: string | null }) {
  requireValue(typeof eventId === 'string' && /^[0-9a-f]{32}$/.test(eventId), 'Invalid event ID');
  const by = provenance({ ...how, method: 'operator' });
  const event = await one(env, 'SELECT * FROM session_events WHERE id=?', eventId);
  if (!event) throw new HttpError(404, 'Event not found');
  requireValue(['merge', 'move', 'set_alignment', 'revoke'].includes(event.action), 'This event cannot be undone');
  const payload = JSON.parse(event.payload), undo = hex();
  const vodIds: number[] = payload.vod_ids;
  const restore = (payload.before as Input[]).map(r => ({ vod_id: r.vod_id, rec_start: r.rec_start, rec_end: r.rec_end, offset_seconds: r.offset_seconds,
    session_id: r.session_id, method: r.method, proposal_id: r.proposal_id }));
  const checks = [
    { sql: "SELECT NOT EXISTS(SELECT 1 FROM session_events WHERE action='undo' AND json_extract(payload,'$.undoes')=?)", args: [eventId] },
    { sql: `SELECT (SELECT count(*) FROM recording_alignments WHERE event_id=? AND ${ACTIVE})=?`, args: [eventId, payload.after_count] },
    ...(event.action === 'revoke' ? [] : [{ sql: `SELECT (SELECT count(*) FROM recording_alignments WHERE vod_id IN(SELECT value FROM json_each(?)) AND ${ACTIVE})=?`,
      args: [JSON.stringify(vodIds), payload.after_count] }]),
    ...(event.action === 'merge' ? [{ sql: 'SELECT (SELECT merged_into FROM sessions WHERE id=?)=?', args: [payload.loser, payload.winner] }] : []),
  ];
  if (event.action === 'revoke') checks[1] = { sql: `SELECT NOT EXISTS(SELECT 1 FROM recording_alignments WHERE id=? AND ${ACTIVE})`, args: [payload.before[0].id] };
  const restoreSql = statement(env, `INSERT INTO recording_alignments(session_id,vod_id,rec_start,rec_end,offset_seconds,method,proposal_id,actor,evidence,event_id,created_at)
    SELECT json_extract(value,'$.session_id'),json_extract(value,'$.vod_id'),json_extract(value,'$.rec_start'),json_extract(value,'$.rec_end'),json_extract(value,'$.offset_seconds'),
    json_extract(value,'$.method'),json_extract(value,'$.proposal_id'),?,?,?,? FROM json_each(?)`, by.actor, `undo:${eventId}`, undo, now(), JSON.stringify(restore));
  const mutations = [
    ...(event.action === 'revoke' ? [] : [statement(env, `UPDATE recording_alignments SET revoked_at=?,revoked_by=? WHERE event_id=? AND ${ACTIVE}`, now(), by.actor, eventId)]),
    restoreSql,
  ];
  if (event.action === 'merge') {
    mutations.push(
      statement(env, 'UPDATE sessions SET merged_into=NULL,streamer_id=?,updated_at=? WHERE id=?', payload.streamers.loser, now(), payload.loser),
      statement(env, 'UPDATE sessions SET streamer_id=?,updated_at=? WHERE id=?', payload.streamers.winner, now(), payload.winner),
      statement(env, `UPDATE matchups SET
        session_id=(SELECT json_extract(value,'$.session_id') FROM json_each(?1) WHERE json_extract(value,'$.id')=matchups.id),
        session_time=(SELECT json_extract(value,'$.session_time') FROM json_each(?1) WHERE json_extract(value,'$.id')=matchups.id)
        WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?1))`, JSON.stringify(payload.matchups)));
  }
  mutations.push(eventStatement(env, undo, event.session_id, 'undo', { undoes: eventId, vod_ids: vodIds }, by));
  await atomic(env, checks, mutations);
  await markAndCoalesce(env, [event.session_id, payload.winner, payload.loser, ...restore.map(r => r.session_id)].filter(Boolean), by.actor);
  return { event_id: undo, session: await getSession(env, event.session_id) };
}

export async function listSessions(env: Env, options: { after?: string; limit: number; streamerId?: number; includeMerged?: boolean }) {
  return rows(env, `SELECT s.*,(SELECT count(DISTINCT vod_id) FROM recording_alignments g WHERE g.session_id=s.id AND g.${ACTIVE}) AS recording_count,
      (SELECT count(*) FROM matchups m WHERE m.session_id=s.id) AS matchup_count
    FROM sessions s WHERE s.id>? AND (? IS NULL OR s.streamer_id=?) AND (?=1 OR s.merged_into IS NULL) ORDER BY s.id LIMIT ?`,
    options.after ?? '', options.streamerId ?? null, options.streamerId ?? null, options.includeMerged ? 1 : 0, options.limit);
}
export async function getSession(env: Env, id: string) {
  const session = await one(env, 'SELECT * FROM sessions WHERE id=?', sessionId(id));
  if (!session) throw new HttpError(404, 'Session not found');
  const alignments = await rows(env, `SELECT g.id,g.vod_id,g.rec_start,g.rec_end,g.offset_seconds,g.method,g.actor,g.evidence,g.created_at,
      v.source AS platform,v.source_id,v.title,v.availability,v.source_part_index
    FROM recording_alignments g LEFT JOIN vods v ON v.id=g.vod_id WHERE g.session_id=? AND g.${ACTIVE} ORDER BY g.vod_id,g.rec_start`, id);
  const events = await rows(env, 'SELECT id,action,actor,evidence,created_at FROM session_events WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50', id);
  const matchups = await one(env, 'SELECT count(*) AS n FROM matchups WHERE session_id=?', id);
  return { ...session, alignments, events, matchup_count: matchups!.n };
}

export async function sessionsAdminRoute(req: Request, env: Env, path: string): Promise<Response> {
  const base = path.slice('/api/admin/sessions'.length), url = new URL(req.url);
  if (base === '' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50), streamer = url.searchParams.get('streamer_id');
    integer(limit, 'limit', 1, 200);
    return Response.json(await listSessions(env, { after: url.searchParams.get('after') ?? undefined, limit,
      streamerId: streamer ? Number(streamer) : undefined, includeMerged: url.searchParams.get('include_merged') === '1' }));
  }
  const match = base.match(/^\/([0-9a-f]{32})(?:\/(merge|alignments|undo)(?:\/(\d+))?)?$/);
  if (!match) throw new HttpError(404, 'Unknown sessions endpoint');
  const [, id, action, alignment] = match;
  if (!action && req.method === 'GET') return Response.json(await getSession(env, id));
  if (action === 'alignments' && alignment && req.method === 'DELETE') {
    const data = await body(req);
    return Response.json(await revokeAlignment(env, Number(alignment), { actor: data.actor ?? 'admin', evidence: data.evidence }));
  }
  if (req.method !== 'POST' || alignment) throw new HttpError(405, 'Method not allowed');
  const data = await body(req), how = { actor: data.actor ?? 'admin', evidence: data.evidence };
  if (action === 'merge') return Response.json(await mergeSessions(env, id, data.from, data.delta, how, data.streamer_id));
  if (action === 'alignments') return Response.json(await setAlignment(env, id, data.vod_id, data.segments, how));
  if (action === 'undo') return Response.json(await undoSessionEvent(env, data.event_id, how));
  throw new HttpError(404, 'Unknown sessions endpoint');
}
