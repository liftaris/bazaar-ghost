# YouTube support status

Latest result: [authenticated GitHub-hosted playback succeeds](youtube-po-token-experiment.md#authenticated-hosted-playback-succeeds). Run 40540195761 passed all 12 cases and 48 frame checks for one recording, including plugin-free controls. The earlier anonymous login blocker still applies. Production integration and cookie renewal remain open; broader hosted verification is running.

Audited October 27, 2026 against `migration/cloudflare` at `fac316865551e9b0fc24bedb995e1956327168be`. The live validation `/health` returned that exact commit. The initial audit read source, Linear records, GitHub workflow history, and public validation endpoints. A subsequent [fresh PO-token experiment](youtube-po-token-experiment.md) tested six actual GitHub-hosted jobs. Private D1 settings were not queried.

YouTube has a working catalog and processing implementation, historical full-recording acceptance, and frontend support. Reliable automatic access from the chosen runner remains the main blocker. Twitch already runs automatically. Bilibili passed automatic hosted validation on October 20.

## Implemented support

| Area | Evidence | Remaining limitation |
| --- | --- | --- |
| Enrollment and catalog | `scripts/catalog_youtube.py` handles channel IDs, uploads, finalized archives, explicit ranges, and resumable backfills | Metadata still uses yt-dlp, which encountered hosted sign-in failures |
| Automatic ingestion | `scripts/platform_ingestion.py` and `scripts/platform_discovery.py` handle discovery, uploads/streams polling, durable readiness jobs, and retries | The proposed Worker-native Data API adapter is not implemented |
| WebSub | `worker/youtube-websub.ts` handles signed delivery, replay protection, subscription confirmation, and renewal | Recorded acceptance does not establish real public hub delivery |
| Media and OCR | Streamlink-first resolution, yt-dlp fallback, shared chunks, FFmpeg, and SFDE | Hosted access and native resolution remain unresolved |
| API | Live `/api/v1/platforms` lists YouTube; `/api/v1/search?platform=youtube&limit=1` returned matchup 17 with a YouTube source at 2388 seconds | Historical searchable output does not prove new automatic ingestion |
| Frontend | [BG-38](https://linear.app/kaio-barbosa/issue/BG-38), BG-90, and BG-92 are Done; BG-96 records real-player clock verification | Passive YouTube URL advance was not verified in BG-96; this audit did not rerun browser QA |
| Notifications | Generic Matchup notification delivery exists | YouTube catalog rows disable notifications, and platform notification defaults are off |

Two complete historical recordings, `0C6bxQsDj-s` and `yS_mgLwtITA`, passed through disposable self-hosted Actions runners. Those runners were removed afterward. October 14 local acceptance subsequently processed three complete recordings across seven chunks and 4,278 samples, producing 35 public detections. See [local acceptance](platform-ingestion.md#local-youtube-acceptance-october-14-2026).

## Blockers

### Runner access

[BG-40](https://linear.app/kaio-barbosa/issue/BG-40) tracks media access. The October 27 repeat confirmed `LOGIN_REQUIRED` on all three videos with both bgutil and WPC installed on separate GitHub-hosted runners. Forced bgutil token retrieval succeeded for each video, but did not remove the login rejection. Official API metadata succeeded in the earlier October 15 probes; the fresh credential-free experiment tested media access only.

The original PO-token experiments failed before requesting a token. The October 27 repeat tested `fetch_pot=always` and reached token retrieval, strengthening the evidence that the hosted login restriction is separate. The [current upstream guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) still recommends an automatic token provider with `mweb`. The fresh local control decoded all four native-480p HLS frames with current yt-dlp and no token plugin, while token-assisted direct-HTTPS reads returned 403. These are different stages and network conditions, not interchangeable success criteria.

Both `prepare` and `process-chunk` in `.github/workflows/process-vod.yml` use `ubuntu-latest`. `scripts/vod_workflow.py:142-147` resolves media during preparation. Moving only chunk jobs to a working network would leave preparation blocked. Catalog jobs also need working access until the metadata adapter changes.

The smallest demonstrated route is source-specific self-hosted Actions execution on a network where anonymous access passed. A self-hosted VM with another datacenter IP is not automatically equivalent to the successful local network.

The local branch `experiment/youtube-workers`, at `8195dc3`, contains an unmerged byte-range relay. It passed 12/12 local frame checks and 7/12 hosted checks, all at 360p. No full OCR run passed through it. The five failed hosted checks were not all individually classified as sign-in failures. The temporary Worker was deleted. A relay or proxy remains an experiment rather than an established deployment path.

Probe commands and evidence: [YouTube runner checks](tooling.md#youtube-po-token-probe), including runs [38682275472](https://github.com/liftaris/bazaar-ghost/actions/runs/38682275472), [38682278954](https://github.com/liftaris/bazaar-ghost/actions/runs/38682278954), and [38682281142](https://github.com/liftaris/bazaar-ghost/actions/runs/38682281142).

### Catalog access and the API proposal

[BG-35](https://linear.app/kaio-barbosa/issue/BG-35) now distinguishes existing ingestion from the unimplemented Data API proposal. `scripts/check_youtube_access.py` is the only caller of the official YouTube Data API. Normal readiness and cataloging still call `youtube_metadata`, which runs yt-dlp.

Official channel/uploads-playlist polling and batched video metadata would separate catalog reliability from media extraction. They must preserve live/archive readiness retries, owner identity, and unknown recording dates. A stream ending does not by itself establish playable archive media. This rewrite can proceed independently of BG-40, but it is not required for an initial self-hosted proof using the existing catalog runner.

The earlier Linear comment's quota estimate is outdated. Google's [current quota guide](https://developers.google.com/youtube/v3/determine_quota_cost), retrieved October 27, describes a separate default `search.list` bucket of 100 calls/day at one unit per call, plus 10,000 daily units for other endpoints. A single playlist page every 15 minutes costs 96 units per channel per day before video reads, catch-up, and readiness retries. Capacity depends on channel count and batching.

### Native video quality

[BG-125](https://linear.app/kaio-barbosa/issue/BG-125) tracks rendition selection. `sfde/src/media_source.py:126-147` returns a supported Streamlink rendition before considering yt-dlp. Earlier real probes exposed only muxed itag 18 at 360p. A request for 480p therefore does not establish native 480p input. Preparation discards the resolved height and reports the requested processing geometry.

The local acceptance already includes a readable day-4 value left null on native 360p. This does not invalidate all 360p processing. It does justify selecting and reporting the actual input resolution, then reviewing OCR against real frames. Higher-resolution extraction must also work through FFmpeg seeks and chunk reads, not just return a format URL.

## Activation and parity

Migration `0010` deleted `automatic_platform_ingestion`. The current independent controls are `platform_settings.ingestion_enabled`, `discovery_enabled`, and `processing_enabled`.

[BG-49](https://linear.app/kaio-barbosa/issue/BG-49) records YouTube `0/0/0` and Bilibili `1/1/1` on October 19. Bilibili then passed 22 hours of automatic hosted validation: 36/36 eligible videos complete, zero terminal failed chunks, 434 detections, and 13 tracked uploaders. These are dated acceptance records, not freshly queried private settings. Bilibili listing rejections remain tracked in BG-76.

Full automatic YouTube acceptance still needs the selected execution path to complete discovery or polling, readiness, dispatch, OCR, public search, and real embedded playback. The existing backlog and `automatic_vods_since` boundary need review before activation. WebSub delivery and polling fallback need a real check. Native-quality selection is a separate tracked gap.

Full Twitch parity also includes notifications. `catalog_youtube.normalize_video` sets `notifications_enabled=False`. Migration `0011` defaults platform notifications off except for Twitch, and current outbox triggers require both recording and platform permission. Ingestion switches alone do not enable notifications. Actual delivery is additionally suppressed outside production.

The current deployment configuration still separates Cloudflare validation from production. Successful validation is not evidence of a production cutover.
