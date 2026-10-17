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
- Each known creator is also reconciled hourly, with messages spread across the hour. This catches mixed-game archives absent from Twitch's game-specific discovery feed. Dedicated `stream.offline` subscriptions trigger immediate reconciliation once enrolled.
- Cataloging uses Helix archive pagination and per-video chapter queries. It stops at the configured start boundary or 100 recent archives. Deleted Twitch accounts do not repeatedly fail the queue.
- Processing runs every three minutes. D1 limits Cloudflare to eight queued/processing chunks across all workflows, independently of production's capacity. Failed chunks retry after five minutes, up to three attempts; completed chunks are retained.
- Availability reconciliation runs twice daily. YouTube/Bilibili automatic ingestion remains paused because its separate provider-access limitations are unresolved; current Supabase production's automatic VOD pipeline is Twitch.

Cloudflare processing was opened on October 17, 2026, with the fixed boundary `2026-10-16T00:00:00.000Z`. This catches recent recordings while excluding the existing historical catalog. Capacity started at four chunks and was raised to eight after 15 successful chunks with no failures. This is a fixed start date, not a moving expiration window: unfinished eligible recordings remain eligible tomorrow. The boundary is checked by scheduler selection, queued-job handling and atomic dispatch reservation. Missing/invalid publication dates fail closed. An explicit administrator dispatch can deliberately process an older recording.

Initial setup copied only the 1,581 streamer processing settings and custom crop configurations. Production callback IDs, VODs, chunk IDs, results and notification subscriptions were not imported. Custom profiles use separate target IDs to preserve earlier validation profiles; Kripp retains the previously reviewed IGD variant of the production crop. New discovery retains the default enabled behavior and default crop profile. Configuration changes after this snapshot must be applied to the appropriate backend; Cloudflare has no ongoing dependency on Supabase credentials.

The initial reconciliation was seeded for recently active creators. Subsequent discovery, hourly fallback, callbacks and OCR scheduling run independently. Routine reconciliation can catalog more recordings than production if its chapter evidence finds additional eligible archives. A successful workflow alone is insufficient acceptance: verify terminal chunks, coverage and stored/searchable output.

## Operational controls

The controls live in Cloudflare D1 `processing_config`:

| Key | Parallel value | Effect |
|---|---|---|
| `automatic_vods_since` | `2026-10-16T00:00:00.000Z` | Earliest automatic publication time; also bounds Twitch catalog reads |
| `max_concurrent_chunks` | `8` | Global Cloudflare chunk capacity |
| `automatic_platform_ingestion` | `false` | Pause YouTube/Bilibili ingestion dispatch |
| `automatic_vods` | absent | No per-VOD allowlist |
| `twitch_discovery_streamer_ids` | absent | No per-streamer discovery allowlist |

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
