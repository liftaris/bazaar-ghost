import { external, HttpError, one, requireValue, statement, uuid } from './http';
import { platformEnabled } from './platform-settings';

export function dispatchBranch(environment: string) {
  const branches: Record<string, string> = { dev: 'dev', production: 'main', validation: 'migration/cloudflare' };
  requireValue(Object.hasOwn(branches, environment), 'Dispatch requires dev, production or validation environment');
  return branches[environment];
}

const CLOCK = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const INGESTION_RUNNING_MINUTES = 40; // Workflow timeout is 35 minutes.
const after = (seconds: number) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','+${seconds} seconds')`;

// Shared by the recurring caller and job claims. Discovery is included only if
// it already exists; the dispatcher never initializes a discovery job/account.
// Discovery jobs and unowned candidates belong to a platform's discovery switch;
// account polls and enrolled creators' videos belong to its ingestion switch.
export const CLAIMABLE_INGESTION = `(
 (j.status IN('pending','waiting') AND j.next_attempt_at<=${CLOCK}) OR
 (j.status='processing' AND j.lease_expires_at<=${CLOCK}))
 AND (j.account_id IS NULL OR a.processing_enabled=1)
 AND CASE WHEN j.kind='discovery' OR j.account_id IS NULL THEN ${platformEnabled('j.source', 'discovery_enabled')}
   ELSE ${platformEnabled('j.source', 'ingestion_enabled')} END`;
const DUE = `EXISTS(SELECT 1 FROM platform_ingestion_jobs j
 LEFT JOIN platform_accounts a ON a.id=j.account_id WHERE ${CLAIMABLE_INGESTION})`;
const DISPATCH_AVAILABLE = `(state='idle' OR lease_expires_at<=${CLOCK}) AND next_attempt_at<=${CLOCK}`;

export async function hasDueIngestionDispatch(env: Env) {
  if (env.OUTBOUND_ENABLED !== 'true') return false;
  return Boolean(await one(env, `SELECT 1 WHERE ${DUE} AND NOT EXISTS(
    SELECT 1 FROM platform_ingestion_dispatch WHERE NOT (${DISPATCH_AVAILABLE}))`));
}

export async function dispatchIngestion(env: Env) {
  const branch = dispatchBranch(env.ENVIRONMENT);
  if (env.OUTBOUND_ENABLED !== 'true' || !env.GITHUB_TOKEN)
    throw new HttpError(503, 'GitHub dispatch is not configured');
  const ticket = crypto.randomUUID();
  // No idle row is inserted for an empty database. The due predicate and the
  // ownership reservation observe the same database statement/clock.
  const reserved = await one(env, `INSERT INTO platform_ingestion_dispatch
    (id,ticket_id,state,lease_expires_at,next_attempt_at,last_attempt_at)
    SELECT 1,?,'queued',${after(300)},${CLOCK},${CLOCK} WHERE ${DUE}
    ON CONFLICT(id) DO UPDATE SET ticket_id=excluded.ticket_id,state='queued',
      lease_expires_at=excluded.lease_expires_at,next_attempt_at=excluded.next_attempt_at,
      last_attempt_at=excluded.last_attempt_at,run_id=NULL,run_attempt=NULL,started_at=NULL,finished_at=NULL,outcome=NULL
    WHERE ${DISPATCH_AVAILABLE} RETURNING ticket_id,delivery_failures`, ticket);
  if (!reserved) return { dispatched: false };
  try {
    const response = await external(env, 'https://api.github.com/repos/liftaris/bazaar-ghost/actions/workflows/ingest-platforms.yml/dispatches', {
      method: 'POST', headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'BazaarGhost', 'Content-Type': 'application/json',
      }, body: JSON.stringify({ ref: branch, inputs: {
        environment: env.ENVIRONMENT, dispatch_ticket: ticket, source: 'none', identity: '',
        discovery: 'false', dispatch: 'true', limit: '30', seconds: '1200',
      } }),
    });
    if (response.status !== 204) throw new Error('Unexpected workflow dispatch response');
    // GitHub can start before this response arrives. Never downgrade a running
    // owner, revive an expired ticket, or overwrite a replacement dispatch.
    await statement(env, `UPDATE platform_ingestion_dispatch SET lease_expires_at=${after(2700)},
      delivery_failures=0,outcome='accepted' WHERE id=1 AND ticket_id=? AND state='queued' AND lease_expires_at>${CLOCK}`, ticket).run();
    return { dispatched: true };
  } catch {
    // A failed/lost response does not prove GitHub rejected the request. Keep the
    // provisional ticket; a matching start can still win. Retry after bounded
    // backoff, without reflecting upstream response bodies or credentials.
    const failures = Math.min(reserved.delivery_failures + 1, 10);
    const delay = Math.min(3600, 300 * 2 ** (failures - 1));
    await statement(env, `UPDATE platform_ingestion_dispatch SET delivery_failures=?,
      next_attempt_at=${after(delay)},outcome='delivery_unconfirmed'
      WHERE id=1 AND ticket_id=? AND state='queued' AND lease_expires_at>${CLOCK}`, failures, ticket).run();
    throw new HttpError(503, 'Ingestion workflow delivery is unconfirmed; retry is scheduled');
  }
}

type Input = Record<string, any>;
function identity(env: Env, input: Input) {
  requireValue(input.expected_environment === env.ENVIRONMENT, 'Environment mismatch');
  const ticket = uuid(input.ticket_id);
  for (const key of ['run_id', 'run_attempt'])
    requireValue(typeof input[key] === 'string' && /^[1-9][0-9]{0,24}$/.test(input[key]), 'Invalid GitHub run identity');
  return [ticket, input.run_id, input.run_attempt];
}
export function runnerOwnership(env: Env, input: Input) {
  const present = ['ticket_id', 'run_id', 'run_attempt'].some(key => Object.hasOwn(input, key));
  if (!present) return { sql: '1', args: [] as unknown[], automatic: false };
  const args = identity(env, input);
  return { sql: `EXISTS(SELECT 1 FROM platform_ingestion_dispatch WHERE id=1 AND ticket_id=?
    AND run_id=? AND run_attempt=? AND state='running' AND lease_expires_at>${CLOCK})`, args, automatic: true };
}
export async function startIngestionRunner(env: Env, input: Input) {
  const [ticket, run, attempt] = identity(env, input);
  requireValue(env.OUTBOUND_ENABLED === 'true', 'Automatic ingestion is disabled');
  requireValue((input.source ?? 'none') === 'none' && (input.identity ?? '') === ''
    && (input.discovery == null || input.discovery === false),
    'Automatic runners may only drain existing work');
  await statement(env, `UPDATE platform_ingestion_dispatch SET state='running',run_id=?,run_attempt=?,
    lease_expires_at=${after(INGESTION_RUNNING_MINUTES * 60)},started_at=${CLOCK},delivery_failures=0
    WHERE id=1 AND ticket_id=? AND state='queued' AND lease_expires_at>${CLOCK}`, run, attempt, ticket).run();
  const ownership = runnerOwnership(env, input);
  // Repeating start after a lost response succeeds for the same run/attempt,
  // without extending its original deadline. Other/expired owners are rejected.
  return { started: Boolean(await one(env, `SELECT 1 WHERE ${ownership.sql}`, ...ownership.args)) };
}
export async function finishIngestionRunner(env: Env, input: Input) {
  const ownership = runnerOwnership(env, input);
  requireValue(ownership.automatic, 'Runner identity required');
  requireValue(['success', 'failure', 'cancelled'].includes(input.outcome), 'Invalid runner outcome');
  const row = await one(env, `UPDATE platform_ingestion_dispatch SET state='idle',lease_expires_at=NULL,
    next_attempt_at=${input.outcome === 'success' ? CLOCK : after(180)},finished_at=${CLOCK},outcome=?
    WHERE id=1 AND ${ownership.sql} RETURNING id`, input.outcome, ...ownership.args);
  // A lost finish response may be retried by this exact invocation. An idle
  // receipt is read-only; a new ticket or different outcome cannot be changed.
  const repeated = row ? null : await one(env, `SELECT 1 FROM platform_ingestion_dispatch
    WHERE id=1 AND ticket_id=? AND run_id=? AND run_attempt=? AND state='idle' AND outcome=?`,
    ...ownership.args, input.outcome);
  return { finished: Boolean(row || repeated) };
}
