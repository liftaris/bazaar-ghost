# Cloudflare backend migration

This worktree replaces the backend's Supabase runtime with one Cloudflare Worker, D1, R2, Queues, and Cron Triggers. OCR, Docker builds, tests, processing jobs, Discord command registration, and the weekly dev storage purge remain in **GitHub Actions**. The frontend repository is untouched. The original migration at `6a6d0ae` was local only; the subsequent platform and auth/social backend is deployed to the isolated [validation Worker](https://bazaarghost-validation.kaio-8df.workers.dev/health). Hosted deployment now uses `cf`, including the validation CI workflow. See [tooling](tooling.md) for its separate authentication and build/deploy commands. Dedicated validation deployment and dispatch credentials are configured. Existing dev/production services have not been migrated. See the [current work log](platform-work-log.md) for deployment evidence and unfinished hosted checks.

## Service mapping

| Previous service | Replacement |
| --- | --- |
| Supabase PostgreSQL application tables, views, processing functions | D1 SQLite schema plus explicit Worker operations |
| `pg_trgm` fuzzy username search | Indexed dictionary of unique names and word-padded trigram postings; Jaccard similarity in D1 |
| PostgREST public reads and search RPCs | Bounded read-only compatibility routes under `/rest/v1/` |
| Supabase Edge Functions | Worker handlers under `/functions/v1/` and `/api/` |
| PostgreSQL `pg_cron` | Worker Cron Triggers, with paginated work sent to Queues |
| `pg_net` HTTP dispatch and notification triggers | Worker HTTP calls and a transactional D1 notification outbox |
| Vault secrets / service-role credentials | Worker secrets; separate admin and processor keys |
| Supabase `detections` bucket | Private R2 bucket served by the Worker at the existing public URL shape |
| Supabase historical `logs` bucket | Separate private R2 archival bucket; current logs use Workers observability and GitHub logs |
| Supabase Auth / Realtime | No existing application usage to migrate; new user authentication is implemented with Better Auth on Workers/D1 |
| GitHub Actions / PaddleOCR / FFmpeg | Remain on GitHub Actions |
| Vercel frontend | Outside this worktree's scope |

## Local setup

Use Node 24 or newer, npm, Python 3.11+, and Docker for OCR tests. No Cloudflare login or paid account is required locally.

```bash
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run db:seed
npm run dev
```

`cf dev` listens at `http://localhost:8787`. D1, both R2 buckets, and Queues are simulated locally and persisted under `.wrangler/state/` (cf's current bundler default). All integrations are disabled by `OUTBOUND_ENABLED=false`; scheduled events stay idle until that setting is explicitly enabled. Local processor requests still work. `.dev.vars` contains disposable local keys, never hosted credentials.

The default fixture profile uses the whole frame and is only a placeholder. Real streamers must use their imported or individually configured crop profiles. Discovery still enables newly cataloged streamers by default, with profile ID 1, so import/configure that profile before enabling discovery.

```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/functions/v1/process-vod \
  -H 'Authorization: Bearer local-admin-change-me' \
  -H 'Content-Type: application/json' \
  -d '{"vod_id":1,"dry_run":true}'
```

`dry_run` builds missing chunks but does not dispatch GitHub Actions, matching the previous planning behavior. The seeded 3,661-second VOD produces `[0,1800)`, `[1800,3600)`, and `[3600,3661)`.

Validation:

```bash
npm run types
npm run typecheck
npm test
python3 -m unittest discover -s scripts/tests
npm run build                       # cf local build; no deployment

docker build --target test -t sfde:test sfde/
docker run --rm --network none sfde:test
```

The compatibility date is pinned to `2026-08-22`, supported by both installed Wrangler and the Cloudflare Vitest runtime. The dependencies are pinned in `package-lock.json`.

## Real local OCR smoke test

This test creates three 12-second videos from committed, labeled image crops, decodes them with FFmpeg, runs actual OpenCV/PaddleOCR, and checks the resulting names, ranks, database records, and JPEG downloads. It uses no Twitch data downloads. It is a synthetic integration test, not a hosted VOD recall measurement.

Start `npm run dev` and apply the ordinary fixture seed first, then:

```bash
python3 scripts/database.py execute --environment local --file worker/fixtures/ocr-smoke.sql
docker build --target test -t sfde:test sfde/
docker run --rm --network host --entrypoint python \
  -v "$PWD/scripts/local_ocr_smoke.py:/smoke.py:ro" \
  sfde:test /smoke.py
```

The Linux host-network mode lets the container reach localhost. Docker Desktop needs its host networking feature enabled. On a rerun, reset only fixture VODs 10–12 through `POST /api/admin/retry-vod` with `{"vod_id":10,"mode":"all"}` and the local admin key (repeat for 11 and 12). Active workers cause HTTP 409.

## Processing and data guarantees

- Chapter evidence is sorted, clamped, and merged. Empty Bazaar ranges produce no chunks. Full 25-marker Twitch chapter responses fail rather than guessing the missing tail. Twitch GraphQL remains an unofficial dependency, as before.
- Planning subtracts existing intervals. D1 rejects overlapping inserts, and concurrent planners reread/retry. Catalog updates can add a new tail to a previously completed VOD.
- An atomic claim returns a unique attempt token. Every screenshot upload, detection write, cleanup, and terminal update requires it. A runner that loses its lease cannot publish over its replacement. The processor has a 30-minute deadline and a 35-minute lease.
- HTTP claims also require the processor's `expected_profile` and boolean `expected_old_templates`. Their consumed values must match the catalog inside the claim transaction. Profile edits that affect queued/processing chunks return 409; metadata-only edits and effective-profile no-ops remain allowed. Deploy the matching processor revision with this API revision: older processor images omit the required claim fields and will be rejected before processing.
- Screenshots live under `source_id/chunk_id/claim_token/`. Required uploads precede detection insertion. UUID5 detection IDs are stable across retries. Unique inserts create one outbox entry, avoiding duplicate detection-trigger notifications.
- Expired processing leases and explicit failures recover up to three attempts. Failed chunks wait five minutes; exhausted attempts require an explicit operator retry. Successful siblings are preserved.
- GitHub dispatches use the environment's paired branch: `dev`, `main` for production, or `migration/cloudflare` for validation. D1 enforces the configured global queued/processing limit (default 10), including concurrent dispatches. Matrices never exceed 256 entries. Failed dispatches release only their own queued rows. An internal dispatch timestamp also prevents a delayed GitHub job from claiming or failing a newer dispatch of the same chunk.
- A chunk finishes only after SFDE drains frames, OCR, and uploads. VOD status follows its chunks. Optional IGD and truncation flags survive the new adapter and search API.
- Public detection reads require available VODs and confidence above 0.7. Name search retains word padding, unique trigrams, similarity ordering, filters, totals, and pagination. Unicode trigrams are represented directly rather than PostgreSQL's internal hashed representation; pathological hash collisions are not reproduced.
- Notification records commit with a D1 outbox. Periodic draining recovers a crash before queue publication. Queue delivery is at least once. Destination receipts and Discord nonces reduce repeated messages; Discord cannot offer a cross-service exactly-once transaction. Nonproduction environments mark notifications skipped without contacting Discord.
- Discord and EventSub verify provider signatures before mutation. Replayed Discord subscription interactions cannot toggle twice. Admin/processor keys are separate, and neither is needed or exposed in browser read calls.

## API contracts

Public reads retain these resources: `streamers`, `streamers_with_detections`, `vod_stats`, `vod_embed_info`, `detection_search`, and `streamer_detection_stats`. Supported query syntax: `select`, `eq`, `gt/gte/lt/lte`, `ilike`, bounded `or`, ordering, limit/offset, and Range headers. Single-object responses and Content-Range support the existing Supabase SDK reads. Private tables and internal columns are not exposed. Hosted public reads use a 30-second internal edge cache with a transactionally updated moderation revision; browsers revalidate each time. Local reads remain uncached. This is intentionally not a general PostgREST server.

Public RPCs: `fuzzy_search_detections`, `get_global_stats`, and `get_top_streamers_with_recent_detections`. Existing screenshot URLs work after replacing the origin: `/storage/v1/object/public/detections/<key>`. New responses also work at `/detections/<key>`.

Admin POST endpoints use `ADMIN_KEY`:

| Endpoint | Body / result |
| --- | --- |
| `/functions/v1/process-vod` | One `vod_id` or `source_id`, optional `dry_run` |
| `/functions/v1/update-vods` | Optional `streamer_id`; returns 202 after queueing |
| `/functions/v1/get_vods_from_streamer` | `streamerId`, optional `dryRun`; catalog first page and queue continuations |
| `/functions/v1/insert-new-streamers` | Queue discovery |
| `/functions/v1/check_vod_availability` | Queue paginated availability checks |
| `/functions/v1/search-chat-mentions` | Queue chat scans; matches persist in `chat_mentions` |
| `/functions/v1/schedule-vod-processing` | `check_status` or `test_processing` action |
| `/api/admin/profile` | Profile `id`, `profile_name`, fractional `crop_region`; optional day crop and edge fields |
| `/api/admin/streamer` | `id`, optional enablement/profile/identity fields; new streamers require `login` |
| `/api/admin/retry-vod` | `vod_id`, mode `failed` (default) or `all`; refuses active workers |
| `/api/admin/clear-dev-storage` | Dev only; sweeps detections, queues continuation pages |

Processor endpoints under `/api/processor/` use `PROCESSOR_KEY`; attempt mutations also require `X-Claim-Token`. The Python adapter and `scripts/vod_workflow.py` are the canonical clients. GitHub variables/secrets become `BAZAARGHOST_API_URL` and `BAZAARGHOST_PROCESSOR_KEY`.

The old `generate-seed-data` endpoint is replaced by the offline snapshot tools below. PostgreSQL migration history remains under `scripts/migration/postgres/` as source-schema evidence; it is not executable Cloudflare infrastructure. Active Supabase functions, configuration, deployment workflows, and sync scripts are removed.

## Preparing the eventual dev/production cutover

These steps describe the eventual dev/production cutover. Those existing environments remain untouched. The separate validation environment has already been provisioned and deployed with the validation resources now recorded in `config/environments.json`; its hosted processing checks are still incomplete.

1. Provision separate dev/production D1 databases, R2 `detections` and `logs` buckets, a queue and dead-letter queue per environment. Use the dev/production entries in `config/environments.json`.
2. Fill in each D1 ID and public HTTPS URL. Enable `workersDev` and use that origin for initial verification. Custom domains require an explicit configuration and guard update; they are not configured in these templates.
3. Set Worker secrets: `ADMIN_KEY`, `PROCESSOR_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET`, `GITHUB_TOKEN`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`. Use distinct dev/production credentials. GitHub dispatch needs Actions write access to this repository.
4. Keep `OUTBOUND_ENABLED=false` during data migration and initial read verification. Apply D1 migrations and import data, then verify counts, search examples, profiles, foreign keys, and object samples.
5. Configure GitHub environments with the new URL and keys. The optional dev/production deploy workflow needs a scoped Cloudflare API token/account ID and `CLOUDFLARE_BACKEND_ENABLED=true`. It is manual-only, requires the matching `dev`/`main` branch, and validates the target config and separation of dev/production databases and buckets. Protect the production GitHub environment. The dedicated validation branch has its own push pipeline; it does not enable these dev/production deployments.
6. Point Twitch/Discord callbacks at the Worker. **Clear imported EventSub subscription IDs only after the new callback is ready**, then run discovery/cataloging to register subscriptions for the new callback. Retire the old callback subscriptions to avoid dual catalogers.
7. In the separate frontend repository, update the backend origin and Next.js image host allowlist. The SDK can keep its existing public anon value during transition; these Worker reads do not use it as authentication. Confirm CORS origins. No frontend change was made here.
8. Enable outbound integrations in dev, run actual GitHub VOD jobs, inspect their images/IGD/search results, and verify the dead-letter queue is empty before production cutover. This hosted verification remains necessary; local mocks cannot validate provider permissions, Twitch account behavior, or remote limits.

The weekly dev bucket deletion remains the GitHub Action at Sunday 10:00 UTC. Its job stays gated off until Cloudflare backend activation. It verifies `/health` says `dev`; the Worker independently refuses every other environment. Only the dev detections bucket is swept. Detection records remain, so old dev screenshots can return 404. No production expiration rule is configured.

## Data transfer and rollback

Pause old schedules and drain active jobs before taking the final snapshot. The exporter makes **read-only** requests and requires explicitly supplied Supabase credentials:

```bash
python3 scripts/migration/export_supabase.py .ignore/snapshot
python3 scripts/migration/convert.py .ignore/snapshot .ignore/d1-import
```

The converter creates a validated SQLite database, a complete `import.sql`, ordered `import-0001.sql` parts (at most about 4 MB except a single oversized statement), and a count manifest. Import into an **empty D1 schema**, applying the parts in numeric order. It preserves primary keys, profiles, storage paths, subscriptions, and processing history; historical notification outbox entries are marked sent. It recognizes the earlier `sfot_profiles`/`sfot_profile_id` names. Unknown columns, active chunks, overlapping work, invalid detections, or foreign-key failures stop conversion for review rather than dropping records. A full production export has not been copied into this worktree or audited by the converter.

Copy storage separately with an S3-compatible transfer tool (for example rclone `copy`, **not sync/delete**) from Supabase Storage to the corresponding R2 buckets. Preserve exact object keys and content types. Copy both historical buckets if retaining logs. Validate object counts, byte totals, and representative downloads before changing the frontend origin. Do not use a rolling seven-day lifecycle rule as a substitute for the requested weekly dev wipe.

Keep Supabase intact and paused through the cutover window. A rollback can restore the old frontend origin and webhook/schedule configuration, but detections/subscriptions created after cutover need export/reconciliation first; there is no dual-write system. D1 Time Travel and R2 durability replace portions of Supabase backup infrastructure, not a complete application rollback plan.

## Original local verification at `6a6d0ae` (2026-09-07)

- 27 Worker integration tests passed in the Cloudflare runtime with real local D1/R2 bindings.
- 96 Python/OCR tests passed offline in the newly built `sfde:cloudflare-test` image.
- Six workflow/migration script tests passed. A converted snapshot also imported through Wrangler into a separate local D1 database with no foreign-key errors and zero pending historical notifications.
- Three synthetic videos each completed all six sampled frames and produced the expected name/rank: `sakura.` / diamond, `CapMoura` / gold, and `wsd1050458961` / gold. Each JPEG was fetched and verified from R2 through the Worker.
- The actual GitHub preparation script resolved three planned chunks, a valid profile, and 480p/30 FPS using the local API.
- The separate frontend's installed Supabase SDK successfully exercised stats, streamer lookup, missing-row lookup, paginated VODs, matchup search, top streamers, and embed data against localhost. No frontend files changed.
- Type checking, workflow YAML parsing, and Wrangler bundle dry-runs for local/dev/production passed. At this original local milestone, no hosted resources, callbacks, notifications, or GitHub jobs had been changed or invoked. Later isolated deployment evidence is recorded in the [platform work log](platform-work-log.md).

The original local smoke evidence is in `.ignore/cloudflare-local-evidence.json` and `.ignore/cloudflare-ocr-smoke.log`. At that milestone, local VODs 10–12 were completed and VOD 1 had three pending chunks for exploration; subsequent tests may change local runtime state.

## Cost context

The earlier measured production storage was about 13.44 GB of detections plus 0.25 GB of archived logs. With OCR and Actions staying on GitHub, the assessment estimated roughly **$5–7/month** for Workers Paid, D1 and R2 at current scale, excluding optional image transformations. This is an estimate, not a billing measurement of this implementation. D1 row scans and the trigram index need production-volume measurement before treating that range as a guarantee. See the local assessment in `.ignore/cloudflare-assessment/report.md` for dated sources and assumptions.

## Twitch processing controls

Discovery reads the 500 most recent Bazaar archives (five queued pages), including
creators who are offline. Each discovered creator is cataloged immediately;
existing processing disables and crop profiles are preserved. Cataloging also
registers the environment's EventSub callback. Routine catalog reconciliation uses
Helix pagination over at most the latest 100 archives (five pages of 20), with
per-video GraphQL chapter reads. Streamer archive counts describe that recent
window, not lifetime history; older stored VODs are retained.

Twitch source rendition names are preserved independently of template geometry.
For example, `936p60` can be decoded into the supported `720p` geometry, while
historical templates always normalize to `480p`. Sampling precedes scaling.
Explicit failures retry after five minutes, and interrupted leases are recovered;
three failed attempts stop automatic retries. Preparation failures count toward
that limit. Completed sibling chunks are retained.

Optional `processing_config` entries bound an automatic rollout:

- `twitch_discovery_streamer_ids`: JSON array of Twitch user ID strings; absent means all discovered creators.
- `automatic_vods`: JSON array of `source:source_id` strings; absent means all eligible recordings. This constrains the scheduler and queued processing dispatch, not an explicit administrator request.
- `automatic_platform_ingestion`: set to `false` to pause automatic YouTube/Bilibili catalog dispatch without pausing Twitch.

Empty arrays allow no entries. Set rollout controls before enabling outbound calls
and provider schedules. The isolated Twitch acceptance run uses these controls;
production behavior remains unrestricted when the entries are absent.
