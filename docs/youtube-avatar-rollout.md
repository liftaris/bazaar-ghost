# YouTube channel avatars

## Target and TODO

- [x] Read the Principles section and trace enrollment, polling, persistence, and public output.
- [x] Reproduce Kripparrian's missing channel and provisional-streamer avatars in validation.
- [x] Choose the metadata source and account-update shape.
- [x] Implement avatar and handle persistence without changing operator settings or ownership.
- [x] Run Python, Worker, and type checks.
- [x] Commit and push for independent review.
- [x] Deploy validation after review and CI pass.
- [x] Refresh the existing Kripparrian account through the deployed catalog workflow.
- [x] Verify the public channel and streamer expose the fetched avatar and decode the image bytes.

Validation is the entire target. Do not enable discovery, change the historical cutoff, or merge the separate Twitch and YouTube identities.

## Grounding and design

The existing yt-dlp channel listing already supplies YouTube's channel name, `uploader_id` handle, and a thumbnail explicitly labeled `avatar_uncropped`. A live bounded listing of `UCeBMccz-PDZf6OB4aV6a3eA` returned all three, alongside separately labeled banner images. The deployed channel lookup returned null avatars before this change.

Two options were considered. A new YouTube Data API request would introduce another credential and fetch path for metadata already present in the listing. Reusing the verified channel response avoids that dependency and distinguishes the avatar from banners and recording thumbnails. Nested design/review agents are unavailable at this session depth; the parent provides independent review before merge.

The data shape is a partial channel profile containing `display_name`, `login`, and `avatar_url`. Missing metadata is omitted rather than clearing saved values. `channel_profile` checks immutable channel identity and selects only the explicit avatar thumbnail. Enrollment reuses its channel response. Single-video cataloging and new candidate enrollment fetch a bounded channel page. Existing account polling forwards the profile from its already-fetched listing through a lease-fenced PATCH.

The Worker validates optional avatar URLs and handles at the catalog boundary. Upserts preserve omitted values, processing switches, crop profiles, and ownership. Existing provisional-streamer synchronization supplies the public streamer avatar; no schema or identity migration is needed.

The throughput checkpoint is to reuse polling responses instead of adding an extra profile request per account poll. Automatic refresh follows the existing enabled ingestion schedule. This task does not enable that schedule in validation; the initial existing-account refresh uses the manual catalog workflow.

## Verification

The baseline is `/api/v1/channels/lookup?platform=youtube&sourceId=UCeBMccz-PDZf6OB4aV6a3eA` with null channel and streamer avatars. Account ID is `509c02cb-04d9-4cd3-8b4c-5a1fe8d2bed9`; provisional streamer ID is `1000000000006`. Save the final fetched URL, deployment SHA, workflow run, HTTP image response, and decoded dimensions here after deployment. A populated database string alone does not prove the image works.

Local checks passed with 227 Python tests, two skips, 538 Worker tests, and TypeScript checking. Tests cover explicit avatar selection instead of banners, identity mismatch, unsafe URLs, enrollment response reuse, existing-account polling, failure preservation, omitted-value preservation, lease fencing, provisional-streamer propagation, public API output, and unchanged unrelated Twitch identity.

The real extracted avatar downloaded and decoded as a 250-by-250 PNG, then was visually inspected. Local evidence is `/tmp/opencode/youtube-avatar-source.json` and `/tmp/opencode/youtube-avatar-source.png`. This proves source extraction and image access, not deployed persistence. Deployment verification remains pending review.

## Base integration

The parent independently approved `a2fc19c`. Before merge, the base advanced to `8267ce2` with Bilibili avatar persistence and an isolated backfill job. The combined implementation retains the base's shared `avatar()` validator and preserves saved avatars on null or empty input. Login updates also preserve saved values on null input. The stale-lease test now supplies a nonempty avatar so it exercises lease fencing rather than an empty update.

The incoming workflow added two inputs, a separate concurrency group, and a shorter backfill timeout. Updated its contract test to assert those inputs and concurrency expression and inspect the ingestion job's timeout. Registered the incoming platform-specific backfill script in the adapter allowlist.

Combined checks pass with 232 Python tests (two skipped), 540 Worker tests, and typecheck. The changed candidate requires narrow independent re-review before merge. No deployment or live metadata refresh has occurred yet.

## Deployed acceptance

Independent re-review approved `a48f45e984cd3ea234eebdab2134961f7b576760`. [Current-head CI](https://github.com/liftaris/bazaar-ghost/actions/runs/40558667318) passed. [PR 84](https://github.com/liftaris/bazaar-ghost/pull/84) merged as `759785dc957c6f35cecfe80a5d061d3b8d440d9e`.

[Validation deployment](https://github.com/liftaris/bazaar-ghost/actions/runs/40559647171) passed. The live `/health` endpoint returned that exact SHA and `environment=validation`. [Hosted catalog refresh](https://github.com/liftaris/bazaar-ghost/actions/runs/40560757064) passed for existing video `HklpcveV_4o`, with `enable_processing=false`. Its artifact returned existing recording ID `310520`.

The [public channel lookup](https://bazaarghost-validation.kaio-8df.workers.dev/api/v1/channels/lookup?platform=youtube&sourceId=UCeBMccz-PDZf6OB4aV6a3eA) now returns `login=Kripparrian`. Both the channel and provisional streamer return this authoritative avatar URL:

https://yt3.googleusercontent.com/ytc/AIdro_kpKF3ihJhLJhCPhqEPX3SKPm9X-GbvlUTcUOF2kq5OEA=s0

Downloaded the returned URL, fully decoded it, and visually inspected it. The image is a 250-by-250 PNG containing 109,668 bytes. Its decoded pixels exactly match the independently extracted source avatar. SHA-256 is `a8d3eb938fc47677a0476187d2d22fce77585d74f066e3adf435e8290ef3671e`. Local image evidence is `/tmp/opencode/youtube-avatar-live.png`; API evidence is `/tmp/opencode/youtube-avatar-after.json`.

Read-only live D1 checks confirm account processing remains `1`, crop profile `2`, and catalog/archive cursors `1`. Ownership row `1593` still belongs to provisional streamer `1000000000006`, with its original October 20 start time. Twitch `nl_kripp` remains separate at `29795919`. The account has four recordings, IDs `3`, `4`, `310520`, and `310521`; the two recent recordings remain completed. The refresh reused `310520` rather than adding a duplicate.

YouTube switches remain ingestion `0`, discovery `0`, processing `1`, notifications `0`. The historical cutoff remains `2026-10-16T00:00:00.000Z`. Query evidence is `/tmp/opencode/youtube-avatar-settings-after.json` and `/tmp/opencode/youtube-avatar-cutoff-after.json`.

Periodic profile refresh is wired and covered by lease-fenced polling tests. Its automatic schedule remains inactive because ingestion is disabled. No broad manual ingestion run was started just to prove refresh, since it could claim unrelated queued work. The deployed catalog refresh proves authoritative extraction, persistence, public propagation, and working image bytes. No production cutover was performed.
