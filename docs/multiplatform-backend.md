# Multiplatform backend on Cloudflare

The backend catalogs Twitch, YouTube, and Bilibili recordings into the same D1 processing model. Cloudflare Workers owns catalog persistence, processing claims, screenshots in R2, public search, and reviewed matchup groups. Media extraction, FFmpeg, OpenCV, and PaddleOCR run in GitHub Actions. The frontend remains a separate repository.

This port incorporates `c7c3863` and `ec4b870` from the original Supabase implementation. Its prior real-footage results establish useful comparison cases; they do not establish that the Cloudflare port or GitHub-hosted playback has passed the same checks. The ongoing deployment and verification trail is tracked separately from those historical results.

## Platform contracts

| Source | Catalog inputs | Stable playable identity | Media resolver |
|---|---|---|---|
| Twitch | Existing discovery, EventSub, scheduled VOD catalog | Numeric Twitch VOD ID | Streamlink → FFmpeg |
| YouTube | Channel enrollment, bounded discovery/polling, WebSub, manual backfill | Case-sensitive eleven-character video ID | Streamlink first; optional yt-dlp fallback |
| Bilibili | Uploader enrollment/polling, bounded discovery, curated submissions | `BV:cid`, one timeline per part | Bundled Streamlink UGC plugin → anonymous H.264 DASH → FFmpeg |

YouTube supports finite uploads and finalized livestream archives. Automatic ingestion retains scheduled/live/post-live videos for later readiness checks. The manual catalog command skips them. Metadata extraction does not download the video; each chunk resolves fresh playback media.

Bilibili supports public published submissions and replay uploads. A submission's `p` position is mutable metadata; the `cid` identifies the actual part. Each part has its own duration and source-relative clock. Reordering parts cannot substitute another part for existing work. Active live rooms, unpublished replay dashboards, private/paid/supporter-only media, interactive videos, preview playback, and legacy fragmented FLV are outside this adapter's support.

The Bilibili adapter uses public web endpoints, not an approved developer API integration. YouTube metadata uses yt-dlp. Access failures are retryable errors, not evidence of deletion. No login, proxy rotation, request signing (WBI), or premium access is used.

All Bilibili API calls go through one paced client (`BilibiliClient` in `sfde/src/bilibili_source.py`). It identifies as `BazaarGhost/1.0`, allows only fixed endpoints, refuses redirects and bounds response sizes. Listing endpoints (search, uploader listing, owner card) carry the anonymous device cookie (`buvid3`/`buvid4`) that `/x/frontend/finger/spi` issues to any logged-out browser; playback metadata (`view`, `playurl`) does not. Each endpoint has a minimum interval (uploader listing 12 s, search 3 s, card 2 s, playback metadata 1 s). HTTP 412/429 and JSON −352/−412/−509/−799 are retried up to three attempts with jittered backoff (10 s, then 20 s, each up to doubled by jitter) and a fresh device cookie; the endpoint's own rejection category is reported if all attempts fail.

Bilibili rejects requests from Cloudflare Worker egress (105/105 HTTP 412 in a 25-minute probe), so these calls run on GitHub-hosted runners, which were accepted. A browser User-Agent without browser behavior was rejected on `view`; the honest client UA with the device cookie was not. Evidence: branch `experiment/bilibili-access`, `experiments/bilibili-worker/README.md`.

Bilibili playback details observed on October 18, 2026:

- Anonymous playback offers H.264 up to 480p (852×480), which matches the processing geometry.
- The play API returns a mirror list in random order. The Akamai mirror (`upos-hz-mirrorakam.akamaized.net`) truncated every anonymous read at about 1.6 MB, so the resolver chooses it only when no other mirror is offered.
- The first reads of a part that the CDN has not cached yet can drop the connection or deliver data that does not decode, while a later read of the same part is clean. FFmpeg exits 0 in both cases by default. For progressive HTTP inputs (Bilibili parts and YouTube's muxed stream), SFDE resumes dropped responses by byte range and treats decoder errors as fatal. The first failure of such a read (FFmpeg exiting with an error, or a decode that stops more than 10 s before the chunk's end) is retried once inside the same SFDE run after 20 s: the first read has usually cached the part, the chunk keeps its claim, and the failed attempt's uploaded detections are cleared first. The retry shares the chunk's single 30-minute deadline and is skipped when less than about five minutes remain. A second failure fails the chunk with the first FFmpeg diagnostic, and the normal retry/cooldown processes it again. Twitch HLS options and failure handling are unchanged.
- Part durations in the view API are rounded up from the play length, and the video track can end about a second earlier: `BV1K114BiE7t:33726794861` lists 2,468 s while its video ends at 2,466.97 s. Its final chunk completed with the expected last tick at 2,466 s.
- Some creators use the game's streamer mode, which replaces opponent names with `******`. Those recordings process normally but produce no detections.

## Catalog commands

Supply `BAZAARGHOST_API_URL`, `BAZAARGHOST_CATALOG_KEY`, and `ENVIRONMENT` explicitly. The CLI does not source `.env` files. `ENVIRONMENT=local` requires a localhost origin; hosted environments require HTTPS. Every command verifies the unauthenticated `/health` environment before sending credentials. Redirects are refused.

For hosted migration testing, select `ENVIRONMENT=validation` and the dedicated validation Worker. GitHub jobs must run on `migration/cloudflare` with the `validation` GitHub environment. Do not point these jobs at the existing Supabase dev or production services.

```bash
# Catalog only a reviewed 900-second range of a current YouTube upload.
python scripts/catalog_youtube.py --video 0C6bxQsDj-s \
  --ranges '[0,900]' --templates current --profile-id 1 --enable-processing

# Metadata-only inspection; no backend write or credential needed.
python scripts/catalog_youtube.py --channel 'https://www.youtube.com/@Kripparrian' \
  --tab videos --limit 5 --dry-run

# Continue a stored, bounded historical cursor for an existing account.
python scripts/catalog_youtube.py --account '<account-uuid>' \
  --mode backfill --tab streams --limit 10

# One Bilibili part, with its own reviewed timeline and known old layout.
python scripts/catalog_bilibili.py \
  --video 'https://www.bilibili.com/video/BV1FfL5zPEbH/?p=2' \
  --ranges '[600,1500]' --templates old --profile-id 1 --enable-processing
```

A bare BV ID enumerates a bounded set of parts. `--start-part` resumes curated enumeration; output supplies a resume position when `--limit` is reached. Each command accepts at most 50 items/parts per run. Automatic submission ingestion resumes by already-seen CIDs, so it remains stable across part reordering.

YouTube uploads and streams have independent stored backfill cursors. The cursor advances only after the page persists, counting inspected playlist positions even when some entries are unavailable. Recent scans always start at the first page. Upstream reordering/deletion can still require an operator restart or reconciliation of a historical scan.

Manual cataloging creates disabled accounts unless `--enable-processing` is supplied. Explicit enrollment and automatic discovery enable new matching accounts, following Twitch discovery's behavior. Rediscovery preserves existing operator disables. New non-Twitch chunks use priority `-10`, behind ordinary Twitch work.

## Gameplay evidence, profiles, and dates

Title/tag evidence nominates candidates; it does not classify every frame of a recording. The same helper accepts English Bazaar and Chinese `大巴扎` evidence in discovery and catalog normalization. Mixed-game recordings should use verified ranges. `--assume-bazaar` is an explicit operator override.

Accounts have independent processing flags and profiles. An optional Twitch streamer link records a verified creator relationship; a reuploader is not automatically the original streamer. Profile precedence is video override, platform account, linked streamer, then profile 1. Configure a real default crop before enabling discovery; the original local full-frame fixture profile is not a production crop profile.

Reviewed settings can be changed without fetching upstream media again:

```bash
python scripts/catalog_settings.py account '<account-uuid>' --clear-streamer
python scripts/catalog_settings.py video 123 --account-id '<account-uuid>' --profile-id 3
python scripts/catalog_settings.py video 123 --account-id '<account-uuid>' --clear-profile
```

The video command takes the internal numeric ID returned by cataloging and requires the expected owning account. Clearing a video override restores account-profile inheritance; clearing a creator link also removes that link from its existing recordings. Omitted settings remain unchanged. Automatic jobs cannot set or clear operator profile/link fields. Effective profile changes are rejected while affected chunks are queued or processing; no-ops and account changes that do not affect an overridden video remain allowed. These settings affect future processing and do not automatically reprocess completed chunks.

The same active-work guard covers Twitch streamer profile changes and edits to a shared profile's name/day crops and edge settings. Renaming a profile or submitting numerically equivalent settings remains allowed. Dispatch reservations compare the actual processing values, so an edit between reading a profile and queuing work cannot dispatch an obsolete copy. Each HTTP chunk claim requires `expected_profile` and boolean `expected_old_templates`; the processor sends the settings it will actually use. A stale claim returns `claimed=false` without taking ownership. Save/select a reviewed catalog profile before processing; an ad hoc workflow profile override must match it. Existing queued/processing rows continue to block edits until completion, failure or lease recovery changes their state. This does not retroactively change completed chunks or lock a VOD's settings forever between separate processing runs.

`published_at` is publication time. `recorded_at` is an optional known start for the playable timeline. The backend does not invent a recording date from a recent reupload. `template_version=old|current` is explicit. In `auto`, Twitch uses its publication cutoff; YouTube/Bilibili use a known recording date and otherwise default to current. Known pre-August-12-2025 footage should use `--templates old`; old templates require 480p. A Bilibili recording timestamp must refer to one explicit part, not a copied timestamp across all parts.

The Worker validates source identity, ownership, account settings, duration, and ranges. Catalog updates and lease checks use guarded D1 transactions; a client-side read followed by a blind PATCH is no longer the revision boundary. Once chunks exist, duration/range changes are rejected for explicit operator handling. Routine recataloging preserves verified ranges and template/date overrides. Same-duration edits cannot currently be identified automatically.

## Processing and storage

The processor resolves a VOD by `(source, source_id)` or its internal ID. Its normalized context includes account enablement, profile, and template era. Independent YouTube/Bilibili creators do not require invented Twitch streamer records.

The existing processing workflow accepts `source=twitch|youtube|bilibili`, with the platform's external ID in `vod_id`. The Worker dispatches that workflow on the branch paired with its environment. GitHub Actions queues the chunk jobs and manages execution capacity; the backend does not reserve slots.

Cloudflare's existing ownership safeguards remain: atomic claim tokens, queued-at dispatch fencing, bounded streamed uploads, screenshot-before-detection validation, deterministic detection IDs, and stale-runner rejection. R2 paths add a platform namespace for new non-Twitch images while retaining chunk and attempt identity. Imported screenshot keys remain readable at their historical paths. Signed playback locators are resolved per chunk and are not stored in the catalog or printed in decoder logs.

The shared admin retry endpoint is `/api/admin/retry-vod`, with the internal `vod_id` and optional `mode: "all"`; the default retries failed chunks while preserving completed siblings. It uses the owning platform account's enablement and transactionally rejects competing disables or active workers. Validation build `3d00e92` fixes the earlier Twitch-only lookup. All eight new workerd cases and the full 173-test Worker suite pass, CI passed, and the deployed build is verified. A hosted disposable YouTube fixture completed actual retry/clear/upload/publish cycles, preserving exact-anchor social records and hidden status without transferring them to an adjacent timestamp; see [backend-validation-status.md](backend-validation-status.md) for evidence and scope.

Successful completion requires a continuous sampled timestamp sequence across the requested range and processing of every decoded sample. Clean early EOF fails the chunk. Logs and exported summaries include requested bounds, first/last sample timestamps, expected sample count, and decoded count. This verifies sampled coverage; it does not establish exhaustive matchup recall.

IGD extraction remains configurable through the profile's `igd_crop_region`. The OCR alphabet is unchanged; Chinese uploader names are preserved, but arbitrary Chinese in-game username recognition is not established by this port. Quality selection normalizes media to the template geometry; native resolution may differ from processing resolution.

## Private catalog API

All routes below require `CATALOG_KEY`, supplied by runners as `BAZAARGHOST_CATALOG_KEY`. They are separate from browser reads, admin credentials, and processor claim credentials. There is no generic private-table PostgREST write API.

| Route under `/api/catalog` | Operation |
|---|---|
| `GET /accounts` | Resolve an account by ID or source/immutable identity |
| `POST /accounts/upsert` | Validate and persist account metadata/settings; atomically preserve disables during discovery |
| `PATCH /accounts/<id>` | Update allowed operator fields or manual backfill progress |
| `POST /videos` | Guarded catalog upsert, revision checks, and missing-work planning |
| `PATCH /videos/<internal-id>` | Manual profile set/clear; requires `account_id` and `sfde_profile_id` (ID or null) |
| `POST /jobs/enqueue`, `/jobs/claim`, `/jobs/finish`, `/jobs/attach-account` | Durable ingestion queue and lease operations |
| `POST /subscriptions/renew` | Worker-owned hub subscription/renewal, without returning callback secrets |
| `POST /dispatch` | Dispatch bounded due platform work after checking expected environment |
| `POST /maintenance` | Maintenance hook; keeps delivery digest tombstones for the account lifetime |

Automatic ingestion mutations carry the active `job_id` and `lease_token`; completion/attachment use their endpoint's `id` and `token` fields. Ownership checks occur with the D1 mutation. Explicit manual catalog operations may omit a job lease. The ingestion lifecycle and callback rules are detailed in [platform-ingestion.md](platform-ingestion.md).

## Public appearance search and reviewed overlap

The existing `detection_search`, VOD/player views, and Twitch-specific operations remain scoped to Twitch so the current website cannot open a YouTube/Bilibili ID in its Twitch player. New public contracts expose all platforms:

- `GET /rest/v1/video_detections`: available source appearances with creator, source identity, timestamp, screenshot, and public link/embed data.
- `POST /rest/v1/rpc/search_video_detections`: bounded username substring search with source, account, and internal-video filters.
- `POST /rest/v1/rpc/search_matchup_appearances`: reviewed groups, grouping before pagination, including all available appearances when any one matches.

Unlinked detections remain independent appearances. Repeated opponent names are never automatic proof of copied footage. After reviewing actual gameplay, an admin can call `POST /api/admin/appearances/link` with `detection_ids` and a substantive `evidence` note. Linking requires 2–50 detections across at least two videos, rejects conflicting groups, and preserves raw observations. `POST /api/admin/appearances/unlink` takes one `detection_id` and an evidence note. The port adds review-event records for later links and unlinks so new reasoning is not lost when extending an older group.

Bilibili external links use the current part position; embeds use the stable CID. YouTube links use the source timestamp. Unknown recording dates remain null. An unavailable copy does not hide a group that has another available copy. Automatic fingerprinting, copied-footage alignment, and OCR reuse remain future work.

## Validation provenance and limits

The original Supabase branch reported six complete real-recording runs: two current YouTube creators, an old YouTube archive, an old multipart Bilibili replay, and a reviewed YouTube/Bilibili duplicate pair. Each covered 900 seconds and 450 sampled frames; together they saved 21 appearances. The source summaries and images under the original checkout's `.ignore/youtube/` provide comparison evidence. Those were local Docker/Supabase runs, not Cloudflare/GitHub-hosted runs, and not an exhaustively annotated recall benchmark.

The port's offline checks cover media identities, readiness transitions, old-template selection, persistence fencing, upload behavior, and environment isolation. Hosted verification must separately prove current provider access, complete catalog→GitHub→OCR→D1/R2 processing, screenshot retrieval, and source-correct search results. A historical success, mocked test, or successful deployment alone does not establish that full path.

YouTube/Bilibili notification delivery remains suppressed, as does detection notification delivery in nonproduction environments. Automatic availability recovery/classification, reliable arbitrary Bilibili uploader coverage, same-duration edit detection, Chinese in-game OCR, and exhaustive historical revision watching are not claimed.
