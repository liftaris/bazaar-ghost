# YouTube channel avatars

## Target and TODO

- [x] Read the Principles section and trace enrollment, polling, persistence, and public output.
- [x] Reproduce Kripparrian's missing channel and provisional-streamer avatars in validation.
- [x] Choose the metadata source and account-update shape.
- [x] Implement avatar and handle persistence without changing operator settings or ownership.
- [x] Run Python, Worker, and type checks.
- [ ] Commit and push for independent review.
- [ ] Deploy validation after review and CI pass.
- [ ] Refresh the existing Kripparrian account through the deployed catalog workflow.
- [ ] Verify the public channel and streamer expose the fetched avatar and decode the image bytes.

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
