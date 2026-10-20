import { atomic } from './atomic';
import { body, HttpError, integer, now, one, readText, requireValue, rows, statement, uuid } from './http';

type Input = Record<string, any>;
export interface Provenance { method: string; actor: string; evidence?: string | null }

function name(value: unknown, label: string) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 200, `Invalid ${label}`);
  return value.trim();
}
function avatar(value: unknown) {
  if (value == null) return null;
  requireValue(typeof value === 'string' && value.length <= 2000 && /^https:\/\//.test(value), 'Invalid avatar_url');
  return value;
}
function provenance(input: Provenance) {
  // proven-login stays reserved until linked-sign-in verification exists; legacy-link is migration-only.
  requireValue(input.method === 'operator', 'Only operator ownership can be recorded');
  requireValue(typeof input.actor === 'string' && input.actor.length > 0 && input.actor.length <= 200, 'Invalid actor');
  requireValue(input.evidence == null || (typeof input.evidence === 'string' && input.evidence.length <= 2000), 'Invalid evidence');
  return input;
}

/** Ownership mutations for use inside a larger atomic batch (the channel may be inserted earlier in the same batch). */
export function linkStatements(env: Env, streamerId: number, channelId: string, how: Provenance) {
  const by = provenance(how);
  return {
    checks: [
      {sql: 'SELECT EXISTS(SELECT 1 FROM streamer_identities WHERE id=?)', args: [streamerId]},
      {sql: 'SELECT NOT EXISTS(SELECT 1 FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL AND streamer_id<>?)', args: [channelId, streamerId]},
    ],
    mutations: [statement(env, `INSERT INTO channel_ownership(channel_id,streamer_id,method,actor,evidence,started_at)
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL)`,
      channelId, streamerId, by.method, by.actor, by.evidence, now(), channelId)],
  };
}
export function unlinkStatement(env: Env, channelId: string, actor: string, reason: string) {
  return statement(env, `UPDATE channel_ownership SET ended_at=?,ended_by=?,end_reason=? WHERE channel_id=? AND ended_at IS NULL`,
    now(), actor, reason, channelId);
}

export async function createStreamer(env: Env, input: Input) {
  const row = await one(env, 'INSERT INTO streamer_identities(display_name,avatar_url) VALUES(?,?) RETURNING *',
    name(input.display_name, 'display name'), avatar(input.avatar_url));
  return streamer(row!);
}
export async function renameStreamer(env: Env, id: number, input: Input) {
  integer(id, 'streamer ID', 1);
  const fields: Input = {};
  if (input.display_name != null) fields.display_name = name(input.display_name, 'display name');
  if (Object.hasOwn(input, 'avatar_url')) fields.avatar_url = avatar(input.avatar_url);
  requireValue(Object.keys(fields).length > 0, 'No streamer changes');
  const row = await one(env, `UPDATE streamer_identities SET ${Object.keys(fields).map(k => `${k}=?`).join(',')},updated_at=? WHERE id=? RETURNING *`,
    ...Object.values(fields), now(), id);
  if (!row) throw new HttpError(404, 'Streamer not found');
  return streamer(row);
}
export async function linkChannel(env: Env, streamerId: number, channelId: string, how: Provenance) {
  integer(streamerId, 'streamer ID', 1); uuid(channelId);
  if (!await one(env, 'SELECT 1 FROM streamer_identities WHERE id=?', streamerId)) throw new HttpError(404, 'Streamer not found');
  if (!await one(env, 'SELECT 1 FROM platform_accounts WHERE id=?', channelId)) throw new HttpError(404, 'Channel not found');
  const owner = await one(env, 'SELECT streamer_id FROM channel_ownership WHERE channel_id=? AND ended_at IS NULL', channelId);
  if (owner && owner.streamer_id !== streamerId) throw new HttpError(409, 'Channel is owned by another Streamer; unlink it first');
  const {checks, mutations} = linkStatements(env, streamerId, channelId, how);
  await atomic(env, checks, mutations);
  return resolveStreamer(env, streamerId);
}
export async function unlinkChannel(env: Env, streamerId: number, channelId: string, how: {actor: string; reason?: string | null}) {
  integer(streamerId, 'streamer ID', 1); uuid(channelId);
  requireValue(typeof how.actor === 'string' && how.actor.length > 0 && how.actor.length <= 200, 'Invalid actor');
  requireValue(how.reason == null || (typeof how.reason === 'string' && how.reason.length <= 500), 'Invalid reason');
  const ended = await one(env, `UPDATE channel_ownership SET ended_at=?,ended_by=?,end_reason=? WHERE channel_id=? AND streamer_id=? AND ended_at IS NULL RETURNING id`,
    now(), how.actor, how.reason ?? 'operator unlink', channelId, streamerId);
  if (!ended) throw new HttpError(404, 'Active link not found');
  return resolveStreamer(env, streamerId);
}

/** Folds a provisional Streamer into the real one: its Channels, Sessions and reupload marks move, then it is retired. */
export async function mergeProvisional(env: Env, id: number, input: Input) {
  integer(id, 'streamer ID', 1);
  const target = integer(input.into, 'target streamer ID', 1);
  const by = provenance({method: 'operator', actor: input.actor ?? 'admin', evidence: input.evidence});
  requireValue(target !== id, 'Cannot merge a Streamer into itself');
  const source = await one(env, 'SELECT provisional_channel_id FROM streamer_identities WHERE id=?', id);
  if (!source) throw new HttpError(404, 'Streamer not found');
  if (!source.provisional_channel_id) throw new HttpError(409, 'Only provisional Streamers can be merged');
  if (!await one(env, 'SELECT 1 FROM streamer_identities WHERE id=?', target)) throw new HttpError(404, 'Target streamer not found');
  await atomic(env, [
    {sql: 'SELECT EXISTS(SELECT 1 FROM streamer_identities WHERE id=? AND provisional_channel_id IS NOT NULL)', args: [id]},
    {sql: 'SELECT EXISTS(SELECT 1 FROM streamer_identities WHERE id=?)', args: [target]},
  ], [
    statement(env, `UPDATE channel_ownership SET streamer_id=?,method=?,actor=?,evidence=?,started_at=? WHERE streamer_id=? AND ended_at IS NULL`,
      target, by.method, by.actor, by.evidence ?? `Merged provisional Streamer ${id}`, now(), id),
    statement(env, 'UPDATE channel_ownership SET streamer_id=? WHERE streamer_id=?', target, id),
    statement(env, 'UPDATE sessions SET streamer_id=?,updated_at=? WHERE streamer_id=?', target, now(), id),
    statement(env, 'UPDATE platform_accounts SET reupload_of=? WHERE reupload_of=?', target, id),
    statement(env, 'DELETE FROM streamer_identities WHERE id=?', id),
  ]);
  return resolveStreamer(env, target);
}
/** Marks a Channel as a reupload channel of a Streamer: its provisional Streamer is retired and its Sessions fall back to Session linking. */
export async function markReupload(env: Env, originalId: number, input: Input) {
  integer(originalId, 'streamer ID', 1);
  const channel = uuid(input.channel_id);
  if (!await one(env, 'SELECT 1 FROM streamer_identities WHERE id=?', originalId)) throw new HttpError(404, 'Streamer not found');
  if (!await one(env, 'SELECT 1 FROM platform_accounts WHERE id=?', channel)) throw new HttpError(404, 'Channel not found');
  const owner = await one(env, `SELECT o.streamer_id,i.provisional_channel_id FROM channel_ownership o JOIN streamer_identities i ON i.id=o.streamer_id
    WHERE o.channel_id=? AND o.ended_at IS NULL`, channel);
  if (owner && !owner.provisional_channel_id) throw new HttpError(409, 'Channel is owned by a Streamer; unlink it first');
  if (owner?.streamer_id === originalId) throw new HttpError(409, 'Channel is the Streamer\'s own provisional Channel; merge or unlink it first');
  const provisional = owner?.streamer_id ?? null;
  const soleOwner = `(SELECT CASE WHEN count(DISTINCT o.streamer_id)=1 THEN min(o.streamer_id) END FROM recording_alignments g JOIN vods v ON v.id=g.vod_id
    JOIN channel_ownership o ON o.channel_id=v.platform_account_id AND o.ended_at IS NULL AND o.streamer_id<>? WHERE g.session_id=sessions.id AND g.revoked_at IS NULL)`;
  await atomic(env, [
    {sql: 'SELECT NOT EXISTS(SELECT 1 FROM channel_ownership o WHERE o.channel_id=? AND o.ended_at IS NULL AND o.streamer_id IS NOT ?)', args: [channel, provisional]},
    {sql: 'SELECT EXISTS(SELECT 1 FROM streamer_identities WHERE id=?)', args: [originalId]},
  ], [
    statement(env, 'UPDATE platform_accounts SET reupload_of=? WHERE id=?', originalId, channel),
    ...(provisional == null ? [] : [
      statement(env, `UPDATE sessions SET streamer_id=${soleOwner},updated_at=? WHERE streamer_id=?`, provisional, now(), provisional),
      statement(env, 'DELETE FROM channel_ownership WHERE streamer_id=?', provisional),
      statement(env, 'DELETE FROM streamer_identities WHERE id=?', provisional),
    ]),
  ]);
  return resolveStreamer(env, originalId);
}
export async function listProvisional(env: Env, after: number, limit: number) {
  integer(after, 'after', 0); integer(limit, 'limit', 1, 200);
  const found = await rows(env, 'SELECT * FROM streamer_identities WHERE provisional_channel_id IS NOT NULL AND id>? ORDER BY id LIMIT ?', after, limit);
  const channels = await channelsOf(env, found.map(r => r.id));
  return found.map(r => ({...streamer(r), channels: channels.get(r.id) ?? []}));
}

function streamer(row: Input) {
  return {id: row.id, display_name: row.display_name, avatar_url: row.avatar_url, created_at: row.created_at, updated_at: row.updated_at};
}
async function channelsOf(env: Env, ids: number[]) {
  const found = await rows(env, `SELECT o.streamer_id,a.id,a.source AS platform,a.source_id,a.display_name,a.login,a.avatar_url,o.method,o.started_at
    FROM channel_ownership o JOIN platform_accounts a ON a.id=o.channel_id
    WHERE o.ended_at IS NULL AND o.streamer_id IN(SELECT value FROM json_each(?)) ORDER BY o.streamer_id,a.source,a.display_name,a.id`, JSON.stringify(ids));
  const by = new Map<number, Input[]>();
  for (const {streamer_id, ...channel} of found) by.set(streamer_id, [...(by.get(streamer_id) ?? []), channel]);
  return by;
}
export async function resolveStreamer(env: Env, id: number, withHistory = false) {
  integer(id, 'streamer ID', 1);
  const row = await one(env, 'SELECT * FROM streamer_identities WHERE id=?', id);
  if (!row) throw new HttpError(404, 'Streamer not found');
  const channels = (await channelsOf(env, [id])).get(id) ?? [];
  const history = withHistory ? await rows(env, `SELECT id,channel_id,method,actor,evidence,started_at,ended_at,ended_by,end_reason
    FROM channel_ownership WHERE streamer_id=? ORDER BY id`, id) : undefined;
  return {...streamer(row), channels, ...(history ? {history} : {})};
}

export async function streamersAdminRoute(req: Request, env: Env, path: string): Promise<Response> {
  const base = path.slice('/api/admin/streamers'.length);
  if (base === '' && req.method === 'GET') {
    const params = new URL(req.url).searchParams;
    requireValue(params.get('provisional') === '1', 'Only provisional=1 listing is supported');
    return Response.json(await listProvisional(env, Number(params.get('after') ?? 0), Number(params.get('limit') ?? 100)));
  }
  if (base === '' && req.method === 'POST') return Response.json(await createStreamer(env, await body(req)), {status: 201});
  const match = base.match(/^\/([1-9]\d{0,15})(?:\/(?:channels(?:\/([0-9a-f-]{36}))?|merge|reuploads))?$/);
  if (!match) throw new HttpError(404, 'Unknown streamers endpoint');
  const id = Number(match[1]), channel = match[2], channels = base.includes('/channels');
  if (base.endsWith('/merge') && req.method === 'POST') return Response.json(await mergeProvisional(env, id, await body(req)));
  if (base.endsWith('/reuploads') && req.method === 'POST') return Response.json(await markReupload(env, id, await body(req)));
  if (!channels && req.method === 'PATCH') return Response.json(await renameStreamer(env, id, await body(req)));
  if (!channels && req.method === 'GET') return Response.json(await resolveStreamer(env, id, true));
  if (channels && !channel && req.method === 'POST') {
    const data = await body(req);
    return Response.json(await linkChannel(env, id, uuid(data.channel_id), {
      method: data.method ?? 'operator', actor: data.actor ?? 'admin', evidence: data.evidence}));
  }
  if (channels && channel && req.method === 'DELETE') {
    const data = (await readText(req.clone())).trim() ? await body(req) : {};
    return Response.json(await unlinkChannel(env, id, channel, {actor: data.actor ?? 'admin', reason: data.reason}));
  }
  throw new HttpError(405, 'Method not allowed');
}
