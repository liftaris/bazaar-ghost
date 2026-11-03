import { atomic } from './atomic';
import { authenticated, identityCheck, requireCsrf, type AuthEnv, type Identity } from './auth';
import { digest, only, privateResponse } from './auth/security';
import { authorized, HttpError, integer, one, readBytes, requireValue, rows, statement, text, uuid } from './http';
import { matchupCards, parameters } from './native-api';
import { boundary, page as cursorPage } from './native-cursor';
import type { MatchupRow } from './native-model';

type Check = { sql: string; args: unknown[] };
type Category = 'reaction' | 'comment' | 'report';
interface CommentRow {
  sequence: number; id: string; matchup_id: number; origin_id: number; author_id: string; name: string;
  body: string | null; original_body_hash: string; version: number; status: string;
  created_at: string; updated_at: string;
}
const commentFields = 'c.*,u.name';
const commentFrom = 'FROM matchup_comments c JOIN app_users u ON u.id=c.author_id JOIN matchups p ON p.id=c.matchup_id';

async function input(req: Request, keys: string[]) {
  requireValue(req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json', 'Expected application/json');
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBytes(req, 16_384))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON'); }
  requireValue(data && typeof data === 'object' && !Array.isArray(data), 'Expected an object');
  const result = data as Record<string, unknown>;
  only(result, keys);
  return result;
}
function key(value: unknown) { return uuid(value).toLowerCase(); }
function matchupId(value: string | unknown) {
  requireValue(typeof value === 'number' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)), 'Invalid Matchup ID');
  return integer(Number(value), 'Matchup ID', 1);
}
function pagination(url: URL, extra: string[] = []) {
  for (const name of url.searchParams.keys())
    requireValue(['limit', 'after', ...extra].includes(name) && url.searchParams.getAll(name).length === 1, 'Unsupported query parameter');
  const numeric = (name: string, fallback: number, min: number, max: number) => {
    const value = url.searchParams.get(name);
    requireValue(value === null || /^[0-9]+$/.test(value), `Invalid ${name}`);
    return integer(value === null ? fallback : Number(value), name, min, max);
  };
  return { limit: numeric('limit', 25, 1, 50), after: numeric('after', 0, 0, Number.MAX_SAFE_INTEGER) };
}
function page<T>(values: T[], limit: number, cursor: (item: T) => number) {
  const items = values.slice(0, limit);
  return { items, next_after: values.length > limit ? cursor(items[items.length - 1]) : null };
}
function publicComment(row: CommentRow) {
  return { id: row.id, matchup_id: row.matchup_id, author: { id: row.author_id, name: row.name }, body: row.body,
    version: row.version, created_at: row.created_at, updated_at: row.updated_at };
}
async function requireVisible(env: Env, id: number) {
  if (!await one(env, "SELECT 1 FROM matchups WHERE id=? AND status='visible'", id)) throw new HttpError(404, 'Matchup not found');
}
function visibleCheck(id: number): Check {
  return { sql: "EXISTS(SELECT 1 FROM matchups WHERE id=? AND status='visible')", args: [id] };
}
/** Follows `merged_into` to the surviving Matchup; null when the Matchup does not exist. */
async function resolveMatchup(env: Env, id: number) {
  let current = id;
  for (let hops = 0; hops < 8; hops++) {
    const row = await one<{ merged_into: number | null }>(env, 'SELECT merged_into FROM matchups WHERE id=?', current);
    if (!row) return null;
    if (row.merged_into === null) return current;
    current = row.merged_into;
  }
  return null;
}
/** Social routes address the canonical Matchup; a retired ID follows its redirect. */
async function canonicalOr404(env: Env, id: number) {
  const matchup = await resolveMatchup(env, id);
  if (matchup === null) throw new HttpError(404, 'Matchup not found');
  return matchup;
}
async function mutationIdentity(req: Request, env: AuthEnv) {
  const identity = await authenticated(req, env);
  await requireCsrf(req, env, identity);
  return identity;
}
async function mutate(env: AuthEnv, identity: Identity, category: Category, checks: Check[], writes: D1PreparedStatement[]) {
  // The counter and action share a transaction, so rejected or conflicted actions
  // consume no quota. The fixed-size account counters cannot grow with arbitrary IPs.
  const minute = "CAST(unixepoch()/60 AS INTEGER)";
  try {
    await atomic(env, [identityCheck(identity), ...checks], [
      statement(env, `INSERT INTO social_rate_limits(user_id,category,window_start,count) VALUES(?,?,${minute},1)
        ON CONFLICT(user_id,category) DO UPDATE SET window_start=${minute},
        count=CASE WHEN window_start=${minute} THEN count+1 ELSE 1 END`, identity.userId, category),
      ...writes,
    ]);
  } catch (error) {
    if (String(error).includes('social_rate_count')) throw new HttpError(429, 'Too many requests; try again shortly');
    throw error;
  }
}

/**
 * The caller's saved Matchups as public cards, most recently saved first. Only public Matchups appear; a favorite row
 * persists while its Matchup is hidden or unavailable, so the Matchup reappears when it becomes public again.
 */
async function listFavorites(req: Request, env: AuthEnv) {
  const url = new URL(req.url), limit = parameters(url, ['limit', 'cursor']), identity = await authenticated(req, env), check = identityCheck(identity);
  const state = await boundary(env, url), position = state.after.length ? 'WHERE (saved_at,matchup_id)<(?,?)' : '';
  const found = await rows<MatchupRow & { saved_at: string }>(env, `SELECT * FROM (
      SELECT p.*,1.0 AS score,0 AS exact,f.saved_at FROM (SELECT matchup_id,max(created_at) AS saved_at FROM matchup_favorites WHERE user_id=? GROUP BY matchup_id) f
      JOIN public_matchups p ON p.matchup_id=f.matchup_id WHERE ${check.sql}) ${position}
    ORDER BY saved_at DESC,matchup_id DESC LIMIT ?`, identity.userId, ...check.args, ...state.after, limit + 1);
  const saved = await cursorPage(env, state, found, limit, row => [row.saved_at, row.matchup_id]);
  return Response.json({ ...saved, items: await matchupCards(env, saved.items) });
}
async function myMatchup(req: Request, env: AuthEnv, requested: number) {
  const identity = await authenticated(req, env), check = identityCheck(identity), id = await canonicalOr404(env, requested);
  const result = await one<{ liked: number; favorite: number }>(env, `SELECT
    EXISTS(SELECT 1 FROM matchup_likes WHERE matchup_id=m.id AND user_id=?) AS liked,
    EXISTS(SELECT 1 FROM matchup_favorites WHERE matchup_id=m.id AND user_id=?) AS favorite
    FROM matchups m WHERE m.id=? AND m.status='visible' AND ${check.sql}`, identity.userId, identity.userId, id, ...check.args);
  if (!result) throw new HttpError(404, 'Matchup not found');
  return Response.json({ matchup_id: id, liked: Boolean(result.liked), favorite: Boolean(result.favorite) });
}
async function reaction(req: Request, env: AuthEnv, requested: number, favorite: boolean) {
  const identity = await mutationIdentity(req, env), enabled = req.method === 'PUT', id = await canonicalOr404(env, requested);
  // No caller-provided user IDs or booleans: the authenticated caller owns this desired state.
  if ((await readBytes(req, 16)).length) throw new HttpError(400, 'Reaction requests have no body');
  const table = favorite ? 'matchup_favorites' : 'matchup_likes';
  await mutate(env, identity, 'reaction', enabled ? [visibleCheck(id)] : [], [statement(env,
    enabled ? `INSERT OR IGNORE INTO ${table}(matchup_id,origin_id,user_id) VALUES(?1,?1,?2)` : `DELETE FROM ${table} WHERE matchup_id=?1 AND user_id=?2`, id, identity.userId)]);
  return Response.json(favorite ? { favorite: enabled } : { liked: enabled });
}
async function comments(req: Request, env: AuthEnv, requested: number) {
  if (req.method === 'GET') {
    const { limit, after } = pagination(new URL(req.url)), id = await canonicalOr404(env, requested);
    await requireVisible(env, id);
    const result = await rows<CommentRow>(env, `SELECT ${commentFields} ${commentFrom}
      WHERE c.matchup_id=? AND c.sequence>? AND c.status='visible' AND p.status='visible' AND u.status='active'
      ORDER BY c.sequence LIMIT ?`, id, after, limit + 1);
    const paged = page(result, limit, row => row.sequence);
    return Response.json({ ...paged, items: paged.items.map(publicComment) });
  }
  const identity = await mutationIdentity(req, env), data = await input(req, ['id', 'body']), id = await canonicalOr404(env, requested);
  const commentId = key(data.id), body = text(data.body, 'Comment', 2000), hash = await digest(body);
  const duplicate = { sql: 'NOT EXISTS(SELECT 1 FROM matchup_comments WHERE id=? AND (author_id!=? OR matchup_id!=? OR original_body_hash!=?))',
    args: [commentId, identity.userId, id, hash] };
  await mutate(env, identity, 'comment', [visibleCheck(id), duplicate], [statement(env,
    'INSERT OR IGNORE INTO matchup_comments(id,matchup_id,origin_id,author_id,body,original_body_hash) VALUES(?1,?2,?2,?3,?4,?5)', commentId, id, identity.userId, body, hash)]);
  const result = await one<CommentRow>(env, `SELECT ${commentFields} ${commentFrom} WHERE c.id=? AND c.author_id=?`, commentId, identity.userId);
  if (!result) throw new HttpError(409, 'Comment changed; refresh before retrying');
  // A retry after edit/delete acknowledges the original request without restoring old text.
  return Response.json({ id: result.id, version: result.version, status: result.status });
}
async function readComment(env: Env, id: string) {
  const result = await one<CommentRow>(env, `SELECT ${commentFields} ${commentFrom}
    WHERE c.id=? AND c.status='visible' AND p.status='visible' AND u.status='active'`, id);
  if (!result) throw new HttpError(404, 'Comment not found');
  return Response.json(publicComment(result));
}
async function editComment(req: Request, env: AuthEnv, id: string) {
  const identity = await mutationIdentity(req, env);
  const data = await input(req, req.method === 'DELETE' ? ['version'] : ['version', 'body']);
  const version = integer(data.version, 'version', 1), deleting = req.method === 'DELETE';
  const body = deleting ? null : text(data.body, 'Comment', 2000);
  // Author-only lookup deliberately treats another person's ID as absent.
  const existing = await one<CommentRow>(env, 'SELECT * FROM matchup_comments WHERE id=? AND author_id=?', id, identity.userId);
  if (!existing) throw new HttpError(404, 'Comment not found');
  await mutate(env, identity, 'comment', [
    { sql: `EXISTS(SELECT 1 FROM matchup_comments c JOIN matchups p ON p.id=c.matchup_id WHERE c.id=? AND c.author_id=? AND
      ${deleting ? "((c.status!='deleted' AND c.version=?) OR (c.status='deleted' AND c.version=?+1))"
        : "c.status='visible' AND p.status='visible' AND c.version=?"})`,
      args: [id, identity.userId, version, ...(deleting ? [version] : [])] },
  ], [statement(env, `UPDATE matchup_comments SET body=?,version=version+1,
    status=CASE WHEN ? THEN 'deleted' ELSE status END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND author_id=? AND version=? AND status!='deleted'`, body, deleting, id, identity.userId, version)]);
  return Response.json({ id, version: version + 1, status: deleting ? 'deleted' : 'visible' });
}
async function report(req: Request, env: AuthEnv) {
  const identity = await mutationIdentity(req, env), data = await input(req, ['id', 'matchup_id', 'comment_id', 'reason']);
  requireValue([data.matchup_id, data.comment_id].filter(value => value !== undefined).length === 1, 'Report exactly one Matchup or comment');
  const id = key(data.id), comment = data.comment_id === undefined ? null : key(data.comment_id), reason = text(data.reason, 'Reason', 1000);
  let matchup: number | null = null;
  if (data.matchup_id !== undefined) matchup = await resolveMatchup(env, matchupId(data.matchup_id)) ?? 0;
  const target = matchup !== null ? { sql: "EXISTS(SELECT 1 FROM matchups WHERE id=? AND status='visible')", args: [matchup] } : {
    sql: `EXISTS(SELECT 1 FROM matchup_comments c JOIN matchups p ON p.id=c.matchup_id JOIN app_users u ON u.id=c.author_id
      WHERE c.id=? AND c.status='visible' AND p.status='visible' AND u.status='active')`, args: [comment],
  };
  await mutate(env, identity, 'report', [target,
    { sql: `NOT EXISTS(SELECT 1 FROM social_reports WHERE id=? AND
      (reporter_id!=? OR origin_id IS NOT ? OR comment_id IS NOT ? OR reason!=?))`, args: [id, identity.userId, matchup, comment, reason] },
    { sql: 'NOT EXISTS(SELECT 1 FROM social_reports WHERE reporter_id=? AND origin_id IS ? AND comment_id IS ? AND reason!=?)',
      args: [identity.userId, matchup, comment, reason] },
  ], [statement(env, 'INSERT OR IGNORE INTO social_reports(id,reporter_id,matchup_id,origin_id,comment_id,reason) VALUES(?,?,?,?,?,?)', id, identity.userId, matchup, matchup, comment, reason)]);
  // The same reporter/target has one canonical report, even if a retry chose a new UUID.
  const result = await one(env, 'SELECT id,status FROM social_reports WHERE reporter_id=? AND origin_id IS ? AND comment_id IS ?', identity.userId, matchup, comment);
  return Response.json(result);
}

async function moderate(req: Request, env: AuthEnv, url: URL) {
  if (!(await authorized(req, env.ADMIN_KEY))) throw new HttpError(401, 'Unauthorized');
  if (req.method === 'GET' && ['/api/admin/social/reports', '/api/admin/social/audit'].includes(url.pathname)) {
    const reports = url.pathname.endsWith('/reports'), { limit, after } = pagination(url, reports ? ['status'] : []);
    const status = url.searchParams.get('status') || 'open';
    requireValue(!reports || ['open', 'resolved', 'dismissed'].includes(status), 'Invalid report status');
    const result = await rows<{ sequence: number }>(env, reports
      ? 'SELECT sequence,id,reporter_id,origin_id,matchup_id,comment_id,reason,status,created_at,updated_at FROM social_reports WHERE sequence>? AND status=? ORDER BY sequence LIMIT ?'
      : 'SELECT * FROM social_moderation_audit WHERE sequence>? ORDER BY sequence LIMIT ?', after, ...(reports ? [status] : []), limit + 1);
    return Response.json(page(result, limit, row => row.sequence));
  }
  const route = url.pathname.match(/^\/api\/admin\/social\/(matchups|comments|users|reports)\/([^/]+)$/);
  if (!route || req.method !== 'PUT') throw new HttpError(404, 'Moderation endpoint not found');
  const data = await input(req, ['request_id', 'status', 'reason']);
  const requestId = key(data.request_id), reason = text(data.reason, 'Reason', 1000), kind = route[1];
  const matchupKind = kind === 'matchups';
  const targetId = matchupKind ? String(await resolveMatchup(env, matchupId(route[2])) ?? 0) : key(route[2]);
  const statuses = kind === 'users' ? ['active', 'suspended'] : kind === 'reports' ? ['resolved', 'dismissed'] : ['visible', 'hidden'];
  requireValue(typeof data.status === 'string' && statuses.includes(data.status), 'Invalid moderation status');
  const table = ({ matchups: 'matchups', comments: 'matchup_comments', users: 'app_users', reports: 'social_reports' } as const)[kind as 'matchups' | 'comments' | 'users' | 'reports'];
  const type = matchupKind ? 'matchup' : kind.slice(0, -1), action = data.status;
  const existing = await one(env, 'SELECT target_type,target_id,action,reason FROM social_moderation_audit WHERE request_id=?', requestId);
  if (existing) {
    if (existing.target_type !== type || existing.target_id !== targetId || existing.action !== action || existing.reason !== reason)
      throw new HttpError(409, 'Moderation request ID was already used with a different payload');
    return Response.json({ request_id: requestId, applied: true });
  }
  if (!await one(env, `SELECT id FROM ${table} WHERE id=? ${kind === 'comments' ? "AND status!='deleted'" : ''}`, targetId))
    throw new HttpError(404, 'Moderation target not found');
  await atomic(env, [
    { sql: `EXISTS(SELECT 1 FROM ${table} WHERE id=? ${kind === 'comments' ? "AND status!='deleted'" : ''})`, args: [targetId] },
    { sql: 'NOT EXISTS(SELECT 1 FROM social_moderation_audit WHERE request_id=? AND (target_type!=? OR target_id!=? OR action!=? OR reason!=?))',
      args: [requestId, type, targetId, action, reason] },
  ], [
    // Guard the UPDATE as well as audit insertion: concurrent identical requests must
    // not reapply an old decision after a later moderation action.
    statement(env, `UPDATE ${table} SET status=? ${kind === 'comments' ? ',version=version+1' : ''}
      ${kind === 'users' ? " ,updatedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ",updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"}
      WHERE id=? AND NOT EXISTS(SELECT 1 FROM social_moderation_audit WHERE request_id=?)`, action, targetId, requestId),
    statement(env, 'INSERT OR IGNORE INTO social_moderation_audit(request_id,target_type,target_id,action,reason) VALUES(?,?,?,?,?)', requestId, type, targetId, action, reason),
  ]);
  return Response.json({ request_id: requestId, applied: true });
}

/** Route before the legacy ADMIN_KEY catch-all. All responses are uncached. */
export async function socialRoute(req: Request, env: AuthEnv): Promise<Response> {
  try {
    const url = new URL(req.url), path = url.pathname;
    if (req.url.length > 4096) throw new HttpError(414, 'Request URL too long');
    let result: Response;
    if (path.startsWith('/api/admin/social/')) result = await moderate(req, env, url);
    else if (path === '/api/v1/me/favorites' && req.method === 'GET') result = await listFavorites(req, env);
    else if (path === '/api/v1/reports' && req.method === 'POST') result = await report(req, env);
    else {
      const comment = path.match(/^\/api\/v1\/comments\/([^/]+)$/);
      const matchup = path.match(/^\/api\/v1\/matchups\/([^/]+)\/(me|like|favorite|heart|comments)$/);
      if (comment && req.method === 'GET') result = await readComment(env, key(comment[1]));
      else if (comment && ['PATCH', 'DELETE'].includes(req.method)) result = await editComment(req, env, key(comment[1]));
      else if (matchup) {
        const action = matchup[2], id = matchupId(matchup[1]);
        if (action === 'me' && req.method === 'GET') result = await myMatchup(req, env, id);
        else if (['like', 'favorite', 'heart'].includes(action) && ['PUT', 'DELETE'].includes(req.method))
          result = await reaction(req, env, id, action !== 'like');
        else if (action === 'comments' && ['GET', 'POST'].includes(req.method)) result = await comments(req, env, id);
        else throw new HttpError(404, 'Social endpoint not found');
      } else throw new HttpError(404, 'Social endpoint not found');
    }
    return privateResponse(result);
  } catch (error) {
    return privateResponse(Response.json({ error: error instanceof HttpError ? error.message : 'Social request failed' },
      { status: error instanceof HttpError ? error.status : 500 }));
  }
}
