# YouTube support status

Authenticated streaming is verified in validation at `130c9bd39d149384961c73a4bc85f225c4d4d81b`. [PR 82](https://github.com/liftaris/bazaar-ghost/pull/82) passed independent review and CI. [Deployment 40546559912](https://github.com/liftaris/bazaar-ghost/actions/runs/40546559912) passed, and live `/health` returned that commit. The deployed scheduler processed two full Kripparrian uploads through four normal streaming chunks, yielding 2,687 sampled frames and 27 persisted matchups.

The dedicated validation `YOUTUBE_COOKIES` secret supplies private cookie jars to catalog, ingestion, preparation, and Docker processing jobs. Normal processing still seeks directly into media streams. It does not download full recordings first. [Authenticated hosted probes](youtube-po-token-experiment.md#authenticated-hosted-playback-succeeds) passed all 12 cases and 48 frame checks, including plugin-free controls. Anonymous login failures and cookie expiry remain operational risks.

## October 27 deployed rollout

| Recording | Full duration | Catalog job | Scheduler-created processing job |
| --- | --- | --- | --- |
| `HklpcveV_4o`, record 310520 | 2763 seconds | [40546805031](https://github.com/liftaris/bazaar-ghost/actions/runs/40546805031) | [40548008075](https://github.com/liftaris/bazaar-ghost/actions/runs/40548008075) |
| `k3Mnp0OQ8ug`, record 310521 | 2609 seconds | [40546810258](https://github.com/liftaris/bazaar-ghost/actions/runs/40546810258) | [40548009614](https://github.com/liftaris/bazaar-ghost/actions/runs/40548009614) |

Both catalog records are visible through the deployed public lookup API. [Hosted bounded channel listing](https://github.com/liftaris/bazaar-ghost/actions/runs/40547183873) also returned and cataloged both uploads. This tests the anonymous channel-listing path, not automatic discovery or WebSub delivery.

### Verified processing output

| Record | Chunk range | Frames | Persisted matchups | Last sample |
| --- | --- | --- | --- | --- |
| 310520 | `[0,1800)` | 900 | 8 | 1798 |
| 310520 | `[1800,2763)` | 482 | 5 | 2762 |
| 310521 | `[0,1800)` | 900 | 9 | 1798 |
| 310521 | `[1800,2609)` | 405 | 5 | 2608 |

All four D1 chunks and both recordings are completed. Every chunk used SFDE NEXT and logged `yt-dlp (480p input)`. Decode reports show zero source gaps and zero unobserved catalog tail. The tested runtime was `ghcr.io/liftaris/bazaar-ghost/sfde-next@sha256:44737131bd9b8526d4e2926ef4292d8fa83e9e06de1c9c67136b913e0512df51`.

Public detection IDs and their username, rank, timestamp, and day values exactly matched all 27 artifact entries. The recordings expose 13 and 14 public matchups. Day values cover 1 through 13 and 1 through 14. Public search returned `agaveb` at 210 seconds as matchup 35132 and `j322` at 202 seconds as matchup 35141, each pointing to the correct YouTube recording.

All 100 referenced evidence JPEGs downloaded and fully decoded at 854 by 480. A visual review of the 27 username/day crops found readable names and matching day values, including day 4 in each recording. This is not independent ground truth for font-ambiguous name characters or a full accuracy evaluation of every inferred hero/rank field. Browser embedded playback was not rerun.

The rerunnable check is `scripts/verify_youtube_rollout.py`. It requires authenticated `gh` and Wrangler, repository npm dependencies, and Pillow. Download the original artifacts before running it from the repository root:

```sh
gh run download 40548008075 --dir /tmp/opencode/youtube-rollout/process-40548008075
gh run download 40548009614 --dir /tmp/opencode/youtube-rollout/process-40548009614
python3 scripts/verify_youtube_rollout.py /tmp/opencode/youtube-rollout \
  --output /tmp/opencode/youtube-rollout/verified.json
```

The check reads validation only. It compares the deployed commit, full chunk coverage, source resolution logs, tested runtime metadata, persisted counts, public fields, search results, and JPEG contents. It fails if the deployed commit changes; review that change rather than weakening the historical check. The final run returned `2 recordings, 2687 samples, 27 detections, 100 decoded_images`. Its report SHA-256 was `bd863bd3f0b39680eefc4642e17f50c03a4244eec543fcbb0754259395741684`.

Only YouTube processing was enabled. The freshly queried validation switches are ingestion `0`, discovery `0`, processing `1`, notifications `0`. The `automatic_vods_since` cutoff remains `2026-10-16T00:00:00.000Z`; older backlog recordings remain excluded. See the [rollout plan](youtube-rollout-plan.md) and [decision trail](youtube-rollout-decisions.tsv).

The user clarified that "production" meant deployed validation. This rollout meets that target. The separate Supabase production migration is outside this request, not a remaining blocker.

## Earlier audit

The initial October 27 audit used `migration/cloudflare` at `fac316865551e9b0fc24bedb995e1956327168be`. The live validation `/health` then returned that exact commit. That audit read source, Linear records, GitHub workflow history, and public validation endpoints. A subsequent [fresh PO-token experiment](youtube-po-token-experiment.md) tested six actual GitHub-hosted jobs. Private D1 settings were not queried until the deployed rollout above.

YouTube has a working catalog and processing implementation, historical full-recording acceptance, and frontend support. Reliable automatic access from the chosen runner remains the main blocker. Twitch already runs automatically. Bilibili passed automatic hosted validation on October 20.

## Implemented support

| Area | Evidence | Remaining limitation |
| --- | --- | --- |
| Enrollment and catalog | `scripts/catalog_youtube.py` handles channel IDs, uploads, finalized archives, explicit ranges, and resumable backfills | Authenticated hosted metadata now passes; cookie expiry remains a dependency |
| Automatic ingestion | `scripts/platform_ingestion.py` and `scripts/platform_discovery.py` handle discovery, uploads/streams polling, durable readiness jobs, and retries | The proposed Worker-native Data API adapter is not implemented |
| WebSub | `worker/youtube-websub.ts` handles signed delivery, replay protection, subscription confirmation, and renewal | Recorded acceptance does not establish real public hub delivery |
| Media and OCR | Streamlink-first resolution, authenticated yt-dlp fallback, shared chunks, FFmpeg, and SFDE | Two full recordings verified at native 480p; cookie expiry remains a dependency |
| API | Live `/api/v1/platforms` lists YouTube; `/api/v1/search?platform=youtube&limit=1` returned matchup 17 with a YouTube source at 2388 seconds | Historical searchable output does not prove new automatic ingestion |
| Frontend | [BG-38](https://linear.app/kaio-barbosa/issue/BG-38), BG-90, and BG-92 are Done; BG-96 records real-player clock verification | Passive YouTube URL advance was not verified in BG-96; this audit did not rerun browser QA |
| Notifications | Generic Matchup notification delivery exists | YouTube catalog rows disable notifications, and platform notification defaults are off |

Two complete historical recordings, `0C6bxQsDj-s` and `yS_mgLwtITA`, passed through disposable self-hosted Actions runners. Those runners were removed afterward. October 14 local acceptance subsequently processed three complete recordings across seven chunks and 4,278 samples, producing 35 public detections. See [local acceptance](platform-ingestion.md#local-youtube-acceptance-october-14-2026).

## Blockers

### Runner access

[BG-40](https://linear.app/kaio-barbosa/issue/BG-40) tracks media access. The October 27 repeat confirmed `LOGIN_REQUIRED` on all three videos with both bgutil and WPC installed on separate GitHub-hosted runners. Forced bgutil token retrieval succeeded for each video, but did not remove the login rejection. Official API metadata succeeded in the earlier October 15 probes; the fresh credential-free experiment tested media access only.

The original PO-token experiments failed before requesting a token. The October 27 repeat tested `fetch_pot=always` and reached token retrieval, strengthening the evidence that the hosted login restriction is separate. The [current upstream guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) still recommends an automatic token provider with `mweb`. The fresh local control decoded all four native-480p HLS frames with current yt-dlp and no token plugin, while token-assisted direct-HTTPS reads returned 403. These are different stages and network conditions, not interchangeable success criteria.

Both `prepare` and `process-chunk` in `.github/workflows/process-vod.yml` use `ubuntu-latest`. `scripts/vod_workflow.py:142-147` resolves media during preparation. Moving only chunk jobs to a working network would leave preparation blocked. Catalog jobs also need working access until the metadata adapter changes.

Before the authenticated probes, the demonstrated route was source-specific self-hosted Actions execution on a network where anonymous access passed. Authenticated GitHub-hosted playback now provides another verified route. A self-hosted VM with another datacenter IP is not automatically equivalent to the successful local network.

The local branch `experiment/youtube-workers`, at `8195dc3`, contains an unmerged byte-range relay. It passed 12/12 local frame checks and 7/12 hosted checks, all at 360p. No full OCR run passed through it. The five failed hosted checks were not all individually classified as sign-in failures. The temporary Worker was deleted. A relay or proxy remains an experiment rather than an established deployment path.

Probe commands and evidence: [YouTube runner checks](tooling.md#youtube-po-token-probe), including runs [38682275472](https://github.com/liftaris/bazaar-ghost/actions/runs/38682275472), [38682278954](https://github.com/liftaris/bazaar-ghost/actions/runs/38682278954), and [38682281142](https://github.com/liftaris/bazaar-ghost/actions/runs/38682281142).

### Catalog access and the API proposal

[BG-35](https://linear.app/kaio-barbosa/issue/BG-35) now distinguishes existing ingestion from the unimplemented Data API proposal. `scripts/check_youtube_access.py` is the only caller of the official YouTube Data API. Normal readiness and cataloging still call `youtube_metadata`, which runs yt-dlp.

Official channel/uploads-playlist polling and batched video metadata would separate catalog reliability from media extraction. They must preserve live/archive readiness retries, owner identity, and unknown recording dates. A stream ending does not by itself establish playable archive media. This rewrite can proceed independently of BG-40, but it is not required for an initial self-hosted proof using the existing catalog runner.

The earlier Linear comment's quota estimate is outdated. Google's [current quota guide](https://developers.google.com/youtube/v3/determine_quota_cost), retrieved October 27, describes a separate default `search.list` bucket of 100 calls/day at one unit per call, plus 10,000 daily units for other endpoints. A single playlist page every 15 minutes costs 96 units per channel per day before video reads, catch-up, and readiness retries. Capacity depends on channel count and batching.

### Native video quality

[BG-125](https://linear.app/kaio-barbosa/issue/BG-125) tracks rendition selection. The deployed resolver now falls back to yt-dlp when Streamlink returns a YouTube rendition below the requested processing resolution. Earlier real probes exposed only muxed itag 18 at 360p. The yt-dlp candidate selector can still choose a lower rendition if no higher one exists, so requested processing geometry alone does not prove native input resolution. Inspect the processor's resolved-input log and the actual OCR output.

The local acceptance already includes a readable day-4 value left null on native 360p. This does not invalidate all 360p processing. It does justify selecting and reporting the actual input resolution, then reviewing OCR against real frames. Higher-resolution extraction must also work through FFmpeg seeks and chunk reads, not just return a format URL.

## Activation and parity

Migration `0010` deleted `automatic_platform_ingestion`. The current independent controls are `platform_settings.ingestion_enabled`, `discovery_enabled`, and `processing_enabled`.

[BG-49](https://linear.app/kaio-barbosa/issue/BG-49) records YouTube `0/0/0` and Bilibili `1/1/1` on October 19. Bilibili then passed 22 hours of automatic hosted validation: 36/36 eligible videos complete, zero terminal failed chunks, 434 detections, and 13 tracked uploaders. These are dated acceptance records, not freshly queried private settings. Bilibili listing rejections remain tracked in BG-76.

Full automatic YouTube acceptance still needs the selected execution path to complete discovery or polling, readiness, dispatch, OCR, public search, and real embedded playback. The existing backlog and `automatic_vods_since` boundary need review before activation. WebSub delivery and polling fallback need a real check. Native-quality selection is a separate tracked gap.

Full Twitch parity also includes notifications. `catalog_youtube.normalize_video` sets `notifications_enabled=False`. Migration `0011` defaults platform notifications off except for Twitch, and current outbox triggers require both recording and platform permission. Ingestion switches alone do not enable notifications. Actual delivery is additionally suppressed outside production.

The deployment configuration still separates Cloudflare validation from the Supabase production service. No separate cutover was requested or performed.
