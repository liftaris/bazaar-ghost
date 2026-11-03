# Parallel backend operation

Cloudflare runs the Twitch backend alongside existing Supabase production. Both backends discover/catalog recordings, create their own chunks, and dispatch their own GitHub Actions workflows. Neither processor writes into the other backend. Historical detections, clips and storage objects are deferred to the later backfill.

| Component | Existing production | Cloudflare parallel backend |
|---|---|---|
| Git branch | `main` | `migration/cloudflare` |
| GitHub environment | `production` | `validation` |
| API/data | Existing Supabase project | `bazaarghost-validation` Worker, D1 and private R2 |
| OCR | GitHub Actions | GitHub Actions |
| Twitch callbacks | Existing subscriptions | Separate callbacks at the validation Worker |
| Discord | Existing production behavior | Existing nonproduction delivery suppression; mentions unchanged |

The Cloudflare environment retains its `validation` name and isolated resources during parallel operation. Its workflow titles include `(validation)`. Existing production deployments, schedules and workflows are unchanged.

## Ingestion and dispatch

- Discovery scans recent Bazaar archives every 15 minutes, including offline creators. Each discovered creator is reconciled immediately.
- Each known creator is also reconciled hourly, with due times spread across the hour. This catches mixed-game archives absent from Twitch's game-specific discovery feed. Dedicated `stream.offline` subscriptions trigger immediate reconciliation once enrolled.
- Cataloging uses Helix archive pagination and per-video chapter queries. It stops at the configured start boundary or 100 recent archives. Deleted Twitch accounts do not repeatedly fail the queue.
- Every three minutes, the backend submits eligible chunks from up to 100 pending recordings. GitHub Actions queues and runs the jobs according to runner capacity. Failed chunks retry after five minutes, up to three attempts; completed chunks are retained. Waiting for a runner does not consume an attempt.
- Availability reconciliation runs twice daily. Bilibili passed automatic hosted validation on October 20. YouTube's runner-access blocker remains unresolved in the latest recorded probes. See the [support audit](youtube-support-status.md) for evidence and rollout scope.

Cloudflare processing was opened on October 17, 2026, with the fixed boundary `2026-10-16T00:00:00.000Z`. This catches recent recordings while excluding the existing historical catalog. Capacity started at four chunks and was raised to eight after 15 successful chunks with no failures. This is a fixed start date, not a moving expiration window: unfinished eligible recordings remain eligible tomorrow. The boundary is checked by scheduler selection, queued-job handling and atomic dispatch reservation. Missing/invalid publication dates fail closed. An explicit administrator dispatch can deliberately process an older recording.

Initial setup copied only the 1,581 streamer processing settings and custom crop configurations. Production callback IDs, VODs, chunk IDs, results and notification subscriptions were not imported. Custom profiles use separate target IDs to preserve earlier validation profiles; Kripp retains the previously reviewed IGD variant of the production crop. New discovery retains the default enabled behavior and default crop profile. Configuration changes after this snapshot must be applied to the appropriate backend; Cloudflare has no ongoing dependency on Supabase credentials.

The initial reconciliation was seeded for recently active creators. Subsequent discovery, hourly fallback, callbacks and OCR scheduling run independently. Routine reconciliation can catalog more recordings than production if its chapter evidence finds additional eligible archives. A successful workflow alone is insufficient acceptance: verify terminal chunks, coverage and stored/searchable output.

## Operational controls

The controls live in Cloudflare D1 `processing_config`:

| Key | Parallel value | Effect |
|---|---|---|
| `automatic_vods_since` | `2026-10-16T00:00:00.000Z` | Earliest automatic publication time; also bounds Twitch catalog reads |
| `automatic_vods` | absent | No per-VOD allowlist |
| `twitch_discovery_streamer_ids` | absent | No per-streamer discovery allowlist |

Per-platform switches live in `platform_settings` (see [processing and platform controls](cloudflare-migration.md#processing-and-platform-controls)). Migration `0010` initially carried the earlier pause over. The later October 19 rollout recorded Twitch and Bilibili fully on, with YouTube ingestion, discovery, and processing all off. These are recorded rollout values, not a live settings read. The old `automatic_platform_ingestion` key was deleted by the migration.

The former `max_concurrent_chunks` setting is ignored. GitHub Actions owns execution capacity; queued and processing chunks no longer reserve backend slots.

To pause new automatic OCR dispatch while leaving active jobs to finish, set `automatic_vods` to the JSON text `[]`. Queued processing messages recheck this gate; it also fences atomic reservations. Delete that entry to resume. Preserve the start boundary when resuming, otherwise the older catalog becomes eligible. Streamer-level processing settings and profile changes use the existing administrator API, including active-job conflict protection.

Use `scripts/database.py execute --environment validation --file <reviewed.sql>` for D1 operations. Check the Worker `/health` environment before supplying any administrator or processor credential. The workflow itself validates its branch/environment pairing before sending processor credentials.

Frontend deployment, live OAuth/browser acceptance, live Discord acceptance and historical backfill remain separate cutover work. Parallel operation does not change public traffic routing.

The existing snapshot importer requires an empty target. Do not apply its full import SQL to this populated parallel database. The later backfill needs to reconcile source video identities and detection/clip anchors, map profile IDs, preserve Cloudflare-only records, and copy historical images. That merge is separate from this configuration bootstrap.

## Parallel acceptance: October 17, 2026

Code `10e7a63398ef35464aec79700eeaaf9b24c7fa56` passed [validation CI and deployment](https://github.com/liftaris/bazaar-ghost/actions/runs/38992941143). Processing was opened at 01:57 UTC. All OCR batches below were dispatched by the actual scheduler, with no manual processing dispatch or chunk resets. Existing production independently processed the same recordings on `main`.

| Twitch recording | Creator | Full range | Chunks | Samples | Cloudflare detections/JPEGs | Production detections |
|---|---|---|---:|---:|---:|---:|
| `2902732511` | spacejuju_ | `[0,6782)` | 4 | 3,391 | 0 | 0 |
| `2902688791` | spacejuju_ | `[0,3096)` | 2 | 1,548 | 0 | 0 |
| `2902654110` | ikarus_ | `[0,12721)` | 8 | 6,361 | 47 | 43 |

The audit reconciled every chunk's Actions artifact and decoder coverage with D1, then compared public search identities and decoded all 47 stored JPEGs. The zero-detection recordings establish complete processing, not matchup recall. All five differing Ikarus crops were visually reviewed: four additional names were valid (`S_y`, `twelvee`, `YM.`, `RandM`), and `ProgKnife` recovered the full name recorded as `ProgKni` in production. This does not establish perfect OCR on every frame. These creators' copied profiles do not enable IGD; the earlier Kripp acceptance remains the IGD evidence.

The final Ikarus batch is [38994790673](https://github.com/liftaris/bazaar-ghost/actions/runs/38994790673), following [38993805812](https://github.com/liftaris/bazaar-ghost/actions/runs/38993805812) and [38994423281](https://github.com/liftaris/bazaar-ghost/actions/runs/38994423281); its independent production run is [38991508251](https://github.com/liftaris/bazaar-ghost/actions/runs/38991508251). An additional partial Trynet comparison covered `[0,7200)`: both backends found 26 detections, with Cloudflare visibly recovering `John_Badwolf` where production stored `John_Bad`.

The initial 29-recording production snapshot was fully covered by Cloudflare's independent catalog. Actual processing and discovery Cron events succeeded; a hosted availability sweep checked the paired recordings. Twitch confirmed enabled production and Cloudflare callbacks for three sampled creators. Enrollment continues through staggered hourly reconciliation: 775 of 1,581 creators had callback IDs at 02:28 UTC. No natural offline event was observed during this acceptance window. Hourly catalog reconciliation also operates for creators awaiting callbacks.

At 02:28 UTC, catch-up contained 35 eligible recordings and 261 chunks, with 27 chunks complete and eight active. This is ongoing queue progress, not a claim that all catch-up finished. No pre-boundary recording started, foreign keys were clean, and the 102 original detections and 102 clips retained their exact rows. Detailed private evidence is under `.ignore/parallel-backend/`, including `final-proof.json`, `final-health.json`, `preservation.json`, `parallel-eventsub.json` and the image comparisons.

One catch-up recording, AnasthasiusFocht `2902563426`, exposed incomplete coverage. Its first chunk failed on source gaps; an independent native-rendition probe reproduced three consecutive two-second timestamp gaps. Three later chunks also failed endpoint coverage checks. The first failure automatically returned to pending after cooldown; retries remain bounded and unrelated recordings continue. Existing production is also partial on this recording. It is not accepted as fully processed, and the coverage checks were not weakened to make it pass. Evidence: `source-first-chunk.json`, `gap-production.json` and `parallel-retries-final.json` (the latter under `.ignore/twitch-parity/`).

## Catalog queue efficiency

Catalog requests are durable in `twitch_catalog_work` before publication to Queues.
Hourly reconciliation retains the same creator coverage and spreads due times over
an hour. The existing three-minute scheduler dispatches up to 200 due creators in
messages containing at most ten IDs. Routine reconciliation can therefore start
up to three minutes after its staggered due time. Discovery and Twitch callbacks
also dispatch immediately; discovery carries a bounded list of seen creator IDs
across its five pages to avoid repeated checks in one scan.

Pending/running routine requests coalesce. A new offline event or explicit update
received during a running check increments its requested version; successful
completion immediately dispatches a follow-up rather than erasing that event.
Two creators run concurrently within each message. Each creator has its own token,
completion version, attempts, and error; one failure does not replay the successful
creators. A lost queue handoff is recoverable after five minutes, and interrupted
running leases after fifteen minutes (renewed for long checks). Failed checks use
exponential backoff, stop after six attempts, and can be restarted by the next
routine discovery/reconciliation or an explicit update request. Infrastructure
failures still use the queue's existing delivery retries.

Each grouped task handles one archive page per creator. Pagination state is
persisted in D1 and dispatched in subsequent groups, retaining the 100-archive
limit while bounding D1 queries per invocation. Only eligible VODs with missing
chunk coverage produce planning messages; unchanged covered VODs produce none. Completed chunks are preserved. A crash after
updating VOD metadata but before publishing a planning message is recovered through the durable catalog
request. Older single-creator/cursor queue messages remain supported while the old
deployment's backlog drains.

Inspect recovery independently of the queue DLQ: `catalog_failed` logs and
`twitch_catalog_work` rows with `state='failed'` identify exhausted creator checks.
`catalog_batch_complete` reports requested/completed/failed counts per group. Rows
with a pending state and future `due_at` are scheduled work, not stuck processing.
The `requested_version`/`completed_version` fields distinguish outstanding work
from an idle row. Leases and due times are Unix milliseconds.

The change trades small indexed D1 updates for fewer Queue operations; validate
both metrics after deployment. Queue billing is per message, so a consumer batch
size change alone would not achieve this reduction. No discovery cadence, OCR
capacity, processing retry policy, or production Supabase behavior changes.
