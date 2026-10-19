import type { CatalogStats } from "./twitch";
import { integer, one, rows, statement } from "./http";
import { isPlatformEnabled } from "./platform-settings";

const GROUP_SIZE = 10;
const SEND_LEASE_MS = 5 * 60_000;
const RUN_LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 6;
export type CatalogCursor = { cursor: string; stats: CatalogStats; page: number };
export type CatalogBatch = { type: "catalog-batch"; ids: number[]; token: string };
type CatalogRequest = { id: number; dueAt?: number };

/** Routine requests coalesce. A new event during execution requires another pass. */
export async function requestCatalog(env: Env, requests: CatalogRequest[], urgent = false) {
  const time = Date.now();
  for (let start = 0; start < requests.length; start += 100) {
    await env.DB.batch(requests.slice(start, start + 100).map(({ id, dueAt = time }) => statement(env,
      `INSERT INTO twitch_catalog_work(streamer_id,due_at,updated_at) VALUES(?,?,?)
       ON CONFLICT(streamer_id) DO UPDATE SET
         requested_version=requested_version+CASE WHEN state IN('idle','failed') OR (cycle_version IS NOT NULL AND ?=1) THEN 1 ELSE 0 END,
         due_at=CASE WHEN state IN('idle','failed') THEN excluded.due_at ELSE min(due_at,excluded.due_at) END,
         attempt_count=CASE WHEN state IN('idle','failed') THEN 0 ELSE attempt_count END,
         cycle_version=CASE WHEN state IN('idle','failed') THEN NULL ELSE cycle_version END,
         continuation=CASE WHEN state IN('idle','failed') THEN NULL ELSE continuation END,
         state=CASE WHEN state IN('idle','failed') THEN 'pending' ELSE state END,
         updated_at=excluded.updated_at`,
      integer(id, "streamer ID", 1), dueAt, time, urgent ? 1 : 0)));
  }
}

/** Reserve before sending; an interrupted/ambiguous send is recoverable by the cron. */
export async function dispatchCatalog(env: Env) {
  // Requests stay durable while Twitch ingestion is off and resume when it is on.
  if (!(await isPlatformEnabled(env, "twitch", "ingestion_enabled"))) return 0;
  const time = Date.now();
  await statement(env,
    `UPDATE twitch_catalog_work SET state=CASE WHEN attempt_count>=? AND requested_version<=coalesce(cycle_version,requested_version) THEN 'failed' ELSE 'pending' END,
      attempt_count=CASE WHEN requested_version>cycle_version THEN 0 ELSE attempt_count END,
      continuation=CASE WHEN requested_version>cycle_version THEN NULL ELSE continuation END,
      cycle_version=CASE WHEN requested_version>cycle_version THEN NULL ELSE cycle_version END,
      lease_token=NULL,lease_expires_at=NULL,updated_at=?,last_error='Catalog lease expired'
      WHERE state IN('queued','running') AND lease_expires_at<=?`, MAX_ATTEMPTS, time, time).run();
  const token = crypto.randomUUID();
  const pending = await rows(env,
    `UPDATE twitch_catalog_work SET state='queued',lease_token=?,lease_expires_at=?,updated_at=?
      WHERE streamer_id IN(SELECT streamer_id FROM twitch_catalog_work
        WHERE state='pending' AND due_at<=? ORDER BY due_at,streamer_id LIMIT 200)
      AND state='pending' RETURNING streamer_id`, token, time + SEND_LEASE_MS, time, time);
  for (let offset = 0; offset < pending.length; offset += GROUP_SIZE) {
    const ids = pending.slice(offset, offset + GROUP_SIZE).map(row => Number(row.streamer_id));
    // If a send fails, keep the reservation. The scheduler will retry after expiry;
    // this also handles a successful send whose response was lost.
    await env.JOBS.send({ type: "catalog-batch", ids, token } satisfies CatalogBatch);
  }
  return pending.length;
}

/** One failed streamer must not replay the other nine. D1 owns retry/backoff state. */
export async function runCatalogBatch(
  env: Env, job: CatalogBatch,
  catalog: (id: number, checkpoint: () => Promise<void>, cursor?: CatalogCursor) => Promise<CatalogCursor | void>,
) {
  if (!Array.isArray(job.ids) || job.ids.length > GROUP_SIZE || typeof job.token !== "string")
    throw new Error("Invalid catalog batch");
  const ids = [...new Set(job.ids.map(id => integer(id, "streamer ID", 1)))];
  let next = 0, followUp = false, completed = 0, failed = 0;
  async function consume() {
    while (next < ids.length) {
      const id = ids[next++], time = Date.now();
      const claimed = await rows(env,
        `UPDATE twitch_catalog_work SET state='running',cycle_version=coalesce(cycle_version,requested_version),attempt_count=attempt_count+1,
          lease_expires_at=?,updated_at=? WHERE streamer_id=? AND state='queued'
          AND lease_token=? AND lease_expires_at>? RETURNING cycle_version,attempt_count,continuation`,
        time + RUN_LEASE_MS, time, id, job.token, time);
      if (!claimed.length) continue; // Duplicate or expired queue delivery.
      const version = claimed[0].cycle_version;
      const checkpoint = async () => {
        const current = Date.now();
        const lease = await one(env,
          `SELECT lease_expires_at FROM twitch_catalog_work
            WHERE streamer_id=? AND state='running' AND lease_token=? AND lease_expires_at>?`,
          id, job.token, current);
        if (!lease) throw new Error("Catalog lease lost");
        // Most catalogs finish in seconds. Avoid a billed write for every checkpoint.
        if (lease.lease_expires_at - current < 5 * 60_000) {
          const renewed = await rows(env,
            `UPDATE twitch_catalog_work SET lease_expires_at=?,updated_at=?
              WHERE streamer_id=? AND state='running' AND lease_token=? AND lease_expires_at>?
              RETURNING streamer_id`, current + RUN_LEASE_MS, current, id, job.token, current);
          if (!renewed.length) throw new Error("Catalog lease lost");
        }
      };
      try {
        const continuation = await catalog(id, checkpoint,
          claimed[0].continuation ? JSON.parse(claimed[0].continuation) : undefined);
        const nextPage = continuation ? JSON.stringify(continuation) : null;
        const finished = await rows(env,
          `UPDATE twitch_catalog_work SET completed_version=CASE WHEN ? IS NULL THEN ? ELSE completed_version END,
            state=CASE WHEN ? IS NOT NULL OR requested_version>? THEN 'pending' ELSE 'idle' END,
            cycle_version=CASE WHEN ? IS NULL THEN NULL ELSE cycle_version END,continuation=?,
            lease_token=NULL,lease_expires_at=NULL,attempt_count=0,last_error=NULL,updated_at=?
            WHERE streamer_id=? AND state='running' AND lease_token=? AND lease_expires_at>? RETURNING state`,
          nextPage, version, nextPage, version, nextPage, nextPage,
          Date.now(), id, job.token, Date.now());
        if (finished.length) completed++;
        if (finished[0]?.state === "pending") followUp = true;
      } catch (error) {
        failed++;
        const attempts = claimed[0].attempt_count;
        await statement(env,
          `UPDATE twitch_catalog_work SET state=CASE WHEN attempt_count>=? AND requested_version<=cycle_version THEN 'failed' ELSE 'pending' END,
            attempt_count=CASE WHEN requested_version>cycle_version THEN 0 ELSE attempt_count END,
            continuation=CASE WHEN requested_version>cycle_version THEN NULL ELSE continuation END,
            cycle_version=CASE WHEN requested_version>cycle_version THEN NULL ELSE cycle_version END,
            due_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=?
            WHERE streamer_id=? AND state='running' AND lease_token=?`,
          MAX_ATTEMPTS, Date.now() + Math.min(3600, 30 * 2 ** attempts) * 1000,
          String(error).slice(0, 1000), Date.now(), id, job.token).run();
        console.error(JSON.stringify({ event: "catalog_failed", id, attempts, error: String(error) }));
      }
    }
  }
  // Bound provider pressure within a group; all work remains attached to the handler.
  const results = await Promise.allSettled([consume(), consume()]);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  if (followUp) await dispatchCatalog(env);
  console.log(JSON.stringify({ event: "catalog_batch_complete", requested: ids.length, completed, failed }));
}
