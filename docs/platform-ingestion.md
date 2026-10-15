# Automatic platform ingestion on Cloudflare

The Worker stores durable discovery, creator-poll, and video-readiness jobs in D1. When provider scheduling is activated, its existing three-minute processing schedule queues a bounded GitHub Actions ingestion run for due work. That runner reads platform metadata through yt-dlp/public endpoints and sends validated catalog changes back to the Worker. Finite playable recordings then enter the existing GitHub OCR workflow. Nothing records a live stream.

Validation still has `OUTBOUND_ENABLED=false` and only the auth-maintenance Cron. The recurring caller has local implementation and test coverage; a healthy hosted automatic catalog → dispatch → OCR → persistence run remains unproven.

This ports the ingestion follow-up from `ec4b870`. The separate [multiplatform backend guide](multiplatform-backend.md) describes source identities, profiles, manual backfills, processing, and appearance grouping.

## Triggers and coverage

| Platform | Discover/enroll creators | Find new playable recordings |
|---|---|---|
| Twitch | Existing Bazaar streamer discovery | Existing EventSub offline event plus VOD reconciliation |
| YouTube | Immutable channel enrollment and bounded recent game-video search | Signed WebSub hints, uploads/streams polling, durable live/post-live readiness retries |
| Bilibili | Immutable uploader UID enrollment and bounded recent `大巴扎` search | Published submission polling/discovery followed by stable CID enumeration |

A stream ending and a recording becoming playable are distinct events. WebSub is an acceleration path for YouTube feed changes; polling and readiness jobs remain necessary. Bilibili integration detects published uploads/replays, not a guaranteed room-ended event. A stream with no accessible published replay never becomes ingestible through this path.

Discovery is best effort. Title/tag gates miss videos that omit the game and may admit discussions or mixed footage. Full metadata verifies the actual owner before account enrollment; a similar creator display name never links identities across platforms. Existing operator disables win over automatic rediscovery.

## Enrollment and bounded runs

Supply `BAZAARGHOST_API_URL`, `BAZAARGHOST_CATALOG_KEY`, and an explicit `ENVIRONMENT` for the intended backend. Use `local` or `validation` for local and isolated migration checks; `dev` and `production` require their separately activated backends and paired branches. The commands verify `/health` and never source ambient `.env` files.

```bash
python scripts/platform_ingestion.py enroll --source youtube --identity '@Kripparrian'
python scripts/platform_ingestion.py enroll --source bilibili --identity 2663423

# Catalog already-enrolled accounts/candidates without broad discovery or OCR dispatch.
python scripts/platform_ingestion.py run --no-discovery --limit 10 --seconds 300

# Include discovery and dispatch up to three due videos in the selected environment.
python scripts/platform_ingestion.py run --limit 30 --seconds 1200 --dispatch

# Drain previously requested discovery/account/video jobs without creating discovery jobs.
python scripts/platform_ingestion.py run --existing-work --limit 30 --seconds 1200
```

Enrollment accepts `--profile-id` and an optional verified `--streamer-id` link. YouTube upload-only/archive-only creators are supported: an explicit absent-tab response is an empty tab, while network/access failures remain errors.

Explicit discovery-enabled runs ensure both platform discovery jobs exist before claiming work, without resetting an existing job's due time. `--no-discovery` creates no discovery jobs and excludes existing broad discovery jobs during that run. `--existing-work` includes discovery jobs already present but initializes none; this is the recurring caller's mode. Neither option erases candidates nominated earlier. Already-requested discovery and unassigned candidates may still enroll their metadata-verified owner under the existing rules, while operator disables win. Enabling recurring dispatch alone does not seed discovery or enroll a caller-supplied identity.

First enrollment scans a recent page; it does not automatically request a creator's lifetime upload history. Manual historical backfills remain explicit, separately bounded operations.

## Recurring caller and workflow ownership

The existing provider Cron `*/3 * * * *` calls `processPending`. With outbound integrations enabled, that function emits at most one `platform-ingestion` Queue message when eligible ingestion work is due and no dispatcher lease/backoff blocks another run. The Queue handler rechecks eligibility and atomically reserves a dispatch ticket before calling GitHub. The scheduling and job-claim paths share the same database-clock predicate: due pending/waiting jobs or expired processing leases, with either no assigned account or an enabled owning account. Empty installations, future-only work, and disabled-account work do not start a workflow.

Migration `0007` adds `platform_ingestion_dispatch`, a private operational table with at most one row per backend database. It is created empty; even its first row is inserted only when due work exists. Tickets and active workflow ownership are never restored from a source snapshot.

| State | Bound | Meaning |
|---|---|---|
| Provisional queued ticket | 5 minutes | A request may be in flight or its delivery may be uncertain. |
| Accepted queued ticket | 45 minutes | GitHub returned the expected HTTP 204; the workflow has not necessarily started. |
| Running ticket | 40 minutes | A specific GitHub run ID and attempt claimed it; the workflow timeout is 35 minutes. |
| Individual ingestion job | 20 minutes | A separate job token fences catalog writes and completion. |

Reservation, start and job-claim expiry checks use D1's clock. The ticket is a nonsecret identifier; `CATALOG_KEY` authenticates lifecycle requests. Before provider work, the workflow calls `/api/catalog/runner/start` with its ticket, expected environment, GitHub run ID and run attempt. A duplicate or delayed invocation cannot take another run's ownership. Retrying the same successful start is idempotent and does not extend its deadline. Each subsequent automatic job claim must retain that running ownership as well as acquire its own job lease.

The workflow's finalizer calls `/api/catalog/runner/finish` with the same identity and a finite outcome. Retrying an already-applied finish with the same identity/outcome is read-only and succeeds; an old finish cannot release a replacement ticket. Failed or cancelled finishes set a three-minute cooldown before another dispatch. Runner loss or an unavailable finalizer leaves an expiring lease, without claiming that any unfinished catalog jobs completed.

A lost/failed GitHub response, including an unexpected successful status other than 204, retains delivery uncertainty. It does not immediately free a request that GitHub might have accepted. Repeated delivery failures back off from five minutes to a maximum of one hour; successful acceptance or start resets that delivery-failure counter. Late HTTP responses cannot downgrade a running owner or modify its successor. Queue duplicates therefore coalesce, while expired tickets can be replaced when eligible work remains. These bounds provide recovery; they do not guarantee GitHub queue latency or processing completion time.

## Durable state and retries

`platform_ingestion_jobs` stores discovery, account scans, and video-readiness work. The unique key is `(source, kind, source_id)`. Claims are atomic, expire after twenty minutes, and issue a unique lease token. Expired jobs can be reclaimed; stale runners cannot finish or mutate catalog state under the replacement's lease. Replacing a workflow ticket does not steal an unexpired individual job lease.

Every automatic catalog mutation carries its job identity/token: account discovery, candidate enqueueing, account attachment, video upsert, subscription renewal, and completion. The backend validates ownership in the same D1 transaction as the change. Manual catalog operations use the catalog credential without pretending to hold a job lease. The catalog credential exposes explicit operations rather than unrestricted database writes.

Discovery normally nominates up to 20 recent candidates per platform every six hours. Account scans become due every fifteen minutes. YouTube tracks uploads and streams separately. Each tab stores its previous first ID, an in-progress scan head, and the next playlist position. Catch-up continues in bounded pages until it reaches that previous head or the end; candidate persistence precedes cursor advancement. Inspected playlist slots, including unavailable entries, determine positional progress. Transient failures retain the last committed cursor.

Readiness jobs persist outside the latest channel page. Scheduled/live/post-live YouTube states wait fifteen minutes before retry. Transport/extractor failures retain retryable jobs with a visible error/backoff; they do not establish deletion. Account-feed failures back off up to four hours, and repeated video/discovery exceptions up to roughly five hours. Healthy polling resets the error-attempt counter.

Provider failures carry a finite diagnostic category into the durable job error and the runner's `error_categories` JSON array. Examples include `auth_required`, `http_403`, `http_412`, `http_429`, `provider_feed_rejected`, and `transport_timeout`. Raw extractor stderr, response bodies, playback URLs, and arbitrary exception messages are excluded. These categories describe the observed failure; they do not authorize bypassing provider restrictions or establish that a recording was deleted.

Bilibili jobs process up to 20 parts per lease and continue by seen CID, rather than mutable part number. Recent rediscovery can reopen a completed submission after a day to detect appended parts. Old submissions absent from all current feeds require explicit recataloging to discover revisions; this is not a complete historical watcher.

A notification arriving during active work sets `rerun_requested`. The finishing transaction schedules another pass rather than discarding that notification. GitHub runner crashes leave reclaimable leases; a failed individual job is recorded while the runner continues other healthy work. A run containing errors exits unsuccessfully so the workflow makes partial outages visible.

Ingestion retries and OCR retries are separate. Expired OCR processing claims recover up to three attempts. Chunks persisted as failed after preparation, media, profile or decoder errors require an operator to use `/api/admin/retry-vod`. A rejected claim never takes ownership or replaces detections; a manual pending chunk may remain pending when the claim is rejected. The caller does not reset failed chunks to make automatic processing appear successful. Completed siblings remain preserved by the default retry mode.

## YouTube WebSub lifecycle

The public Worker callback is `/functions/v1/youtube-webhook`. The Worker owns per-account callback capabilities, HMAC secrets, subscription requests, confirmations, and granted lease expiry in `youtube_websub_subscriptions`. Python requests `/api/catalog/subscriptions/renew`; it never receives those secrets or calls the hub with them.

Verification requires the exact enrolled channel topic and a pending request before echoing a bounded plain-text challenge. Deliveries require a valid raw-body SHA-1/SHA-256 HMAC, an enabled account, an active confirmed lease, bounded XML without DTD/entities, and matching channel/video identities. Receipt deduplication and candidate enqueueing commit together before acknowledgement.

The requested lease is ten days; renewal begins within twelve hours of expiry. The hub determines the actual granted lease. Unconfirmed requests wait an hour before another attempt. Hub denial/request failure is recorded and leaves polling active. Disabling an account stops renewal and delivery acceptance; explicit upstream unsubscribe is not implemented, so its outstanding hub subscription expires naturally.

Delivery digest tombstones are retained for the account lifetime. WebSub deliveries contain no signed timestamp, so deleting those digests would let an old signed body wake processing again. Stable source IDs and guarded timelines additionally keep cataloging idempotent. A real public hub subscription/renewal and live-to-archive event still need hosted evidence beyond signed local fixtures.

## GitHub ingestion workflow

`ingest-platforms.yml` accepts `workflow_dispatch` and `workflow_call`. GitHub environment and branch must match exactly: `validation` → `migration/cloudflare`, `dev` → `dev`, and `production` → `main`. Runs serialize within each environment. Both triggers expose the same controls:

| Input | Default | Behavior |
|---|---|---|
| `environment` | `validation` | Backend/GitHub environment paired with the workflow branch |
| `dispatch_ticket` | empty | Worker-generated dispatch identifier; leave empty for manual runs |
| `source` | `none` | Optional enrollment platform: `none`, `youtube`, or `bilibili` |
| `identity` | empty | Optional creator identity to enroll before draining jobs |
| `discovery` | `false` | Include broad discovery jobs when true |
| `dispatch` | `true` | Dispatch OCR for up to three due videos after draining jobs when true |
| `limit` | `30` | Maximum ingestion jobs to claim; integer from 1 through 100 |
| `seconds` | `1200` | Budget for starting ingestion jobs; integer from 30 through 1200 |

For manual runs, discovery defaults off so initial platform tests can start with selected creators/recordings. Worker dispatches supply a ticket, `source=none`, empty `identity`, and `discovery=false`; ticket mode independently selects `--existing-work`, including previously requested discovery without initializing it. The preflight rejects automatic enrollment inputs before provider work. A superseded/expired ticket reports a skipped start and does no provider work.

The default drain remains thirty jobs/twenty minutes with OCR dispatch enabled. The CLI rejects out-of-range or noninteger budgets. It starts no new job after the budget expires, though an already-running bounded metadata operation may finish later. OCR dispatch, when enabled, happens after this drain and is separate from its time/job budget. The start/finish helper retries lost lifecycle responses under the same identity, with a fixed maximum of three requests.

For a short run of existing account/candidate jobs without broad discovery or OCR dispatch:

```bash
gh workflow run ingest-platforms.yml --ref migration/cloudflare \
  -f environment=validation -f source=none -f discovery=false -f dispatch=false -f limit=3 -f seconds=90
```

This run still claims durable jobs and writes catalog/retry state; `dispatch=false` is not a dry run. Inputs enter task-specific environment variables and a quoted shell argument array, so numeric validation remains in the CLI and a false dispatch input does not fall back to true.

The workflow has no GitHub schedule and currently has no checked-in `workflow_call` caller. The recurring implementation dispatches it from the Worker's existing provider schedule and Queue instead. Validation's deployment workflow ends after deployment/health checks; it does not enable provider processing or invoke ingestion. Existing dev/production live configuration remains outside this isolated validation work.

Environment preflight verifies HTTPS origin, unauthenticated `/health`, and GitHub branch pairing before sending catalog/processor keys. The Worker separately checks the requested environment before dispatching OCR. Validation resource names, credentials, queues, and callbacks are separate from dev and production. Weekly deletion of the existing dev bucket does not apply to validation.

The OCR dispatcher selects at most three due platform videos per ingestion run and retains the global active-chunk cap. Once provider scheduling is activated, the same three-minute `processPending` path independently dispatches remaining pending OCR chunks across sources, including a long recording's tail after earlier chunks finish. No ingestion poll is required merely to continue that OCR work. Validation's auth-only schedule does not provide this continuation.

Video count alone is not a source-hours budget: a long archive can create many pending chunks. Broad discovery/enrollment should follow measured queue age, error rates, and processing cost, with an explicit capacity policy.

## Evidence to retain

### Local YouTube acceptance, October 14, 2026

Fresh public discovery returned 17 candidates with yt-dlp 2026.8.19. Two bounded runs through the actual local Worker catalog API processed 20 durable jobs: discovery, an account poll, and 18 video catalog operations, with zero errors and all leases finished. No GitHub dispatch was requested. Discovery and account polling can return different or overlapping candidates; these counts are operations, not distinct videos.

Four real chunks from three discovered recordings completed against local D1/R2 using the production processor, current templates, and a reviewed standard gameplay profile (nameplate `[0.5726,0.729,0.35,0.121]`, day `[0.1458,0.4509,0.013,0.0231]`). The generic local seed profile is a fixture and was not used for these runs.

| YouTube recording | Source range | Samples | Persisted matchups | Non-null IGD |
|---|---:|---:|---:|---:|
| `jwxFzTcvWLs` | `[0,1800)` | 900 | 6 | 3 |
| `Bfr68889LR0` | `[0,1800)` | 900 | 9 | 5 |
| `62BIbb1liSU` | `[0,1800)` | 900 | 7 | 5 |
| `jwxFzTcvWLs` | `[1800,3600)` | 900 | 7 | 5 |

Each run verified all 54,000 decoded source-frame timestamps and all 900 sampling ticks. Public rows matched the reported names, ranks, days, source identities, and timestamps; all 29 JPEGs decoded successfully. The continuation preserved the earlier public rows exactly. Representative nameplate images were visually reviewed; non-null day counts do not imply exhaustive visual certification. These are completed chunks, not completed whole recordings.

The first recording exposed an intermittent FFmpeg 5 H.264 diagnostic collision: a decoder warning replaced a `showinfo` filter prefix, causing strict timestamp validation to fail. Single-thread input decoding and disabled progress output prevent that collision without accepting missing/unattributed timestamps. Failed attempts remain in the private evidence, followed by explicit local operator retries. The 47 existing pipeline tests passed; no new unit tests were added.

Evidence is under `.ignore/youtube-readiness/`: discovery and durable-job logs, failed decoder traces, per-recording processing logs, terminal chunk state, public rows, and `proof.json`. This demonstrates local feasibility after the dependency update. It does not prove GitHub-hosted YouTube access, Worker-to-Actions dispatch, or public WebSub delivery. Those hosted gates below still apply; validation outbound integrations remain disabled.

For each hosted recording, retain its source identity, complete reviewed range, profile/template era, workflow run and commit, completed chunk/VOD state, frame count, detections, and retrievable screenshot checks. Validate source-relative timestamps, especially nonzero starts and Bilibili part timelines. Compare against prior known detections without presenting sample agreement as exhaustive recall.

The original source branch observed both successful and blocked Bilibili uploader feeds from the local machine. That proves feasibility for specific feeds from that network, not sustained GitHub-runner reliability.

On 2026-09-07, [bounded hosted ingestion run 34152338750](https://github.com/liftaris/bazaar-ghost/actions/runs/34152338750) completed a YouTube account poll and queued forty video-readiness candidates, while both enrolled Bilibili uploader feeds failed. All three leases finished and the failed account jobs retained their retry state; the workflow correctly reported failure for the partial outage and dispatched no OCR. Independent bounded local probes reproduced HTTP 412 for UID 2561817 and Bilibili JSON code −352 for UID 2663423 with yt-dlp 2026.08.19. JSON −352/−401 are provider rejection codes, not HTTP statuses or evidence of expired user credentials. The feed URLs match the maintained extractor. Successful individual-video playback does not establish uploader-feed availability.

Automatic Bilibili uploader polling is therefore access-limited in the current environment. Reviewed BV/CID cataloging and processing of accessible individual recordings remain usable. YouTube individual-video extraction has separately requested human sign-in from GitHub-hosted runners; the successful full-recording validation used disposable self-hosted GitHub Actions runners. Diagnostic improvements preserve these limitations explicitly. Evidence: `.ignore/feed-evidence/README.md` and `.ignore/platform-validation/ingestion-34152338750/`.

Operational state includes due-job age, attempts, last error, per-tab progress, subscription confirmation, and lease expiry. Useful alerts include overdue work, repeated feed failures, unconfirmed/expired subscriptions, and no candidate growth despite active creators. A Grafana dashboard package for these new fields has not been added.
