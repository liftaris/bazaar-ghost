# YouTube PO-token experiment, October 27, 2026

## Authenticated hosted playback succeeds

[Run 40540195761](https://github.com/liftaris/bazaar-ghost/actions/runs/40540195761), at `df411fe`, passed all 12 authenticated cases for `jwxFzTcvWLs` on two GitHub-hosted runners. Each case decoded native-480p frames at 0, 220, 1800, and 3903 seconds. Both plugin-free default controls passed. PO tokens are therefore not required for this tested account, recording, and runner combination.

The experiment used YouTube-only cookies exported from the user's authorized Firefox session. Default clients, `web_creator`, and `tv_downgraded` selected HTTPS format 135. `web_safari` selected HLS format 94. All account-cookie checks passed without rejection warnings.

The first authenticated run, 40538913673, resolved formats in all 12 cases but failed decoding with generic runtime errors. The workflow did not install FFmpeg explicitly. Adding installation and version verification resolved the failures on the repeat. Those first decoding failures do not establish a YouTube media rejection.

The local authenticated control also downloaded the complete recording without plugins: 3908.133333 seconds, 852 × 480, 433240994 bytes. FFmpeg decoded the entire video with exit code 0 and no error output. The local cookie export and token-service container were removed. The hosted temporary secret was deleted after the repeat.

The three broader hosted runs at `4ff2fbd` completed successfully: [jwxFzTcvWLs](https://github.com/liftaris/bazaar-ghost/actions/runs/40541639636), [Bfr68889LR0](https://github.com/liftaris/bazaar-ghost/actions/runs/40541653356), and [62BIbb1liSU](https://github.com/liftaris/bazaar-ghost/actions/runs/40541667387). The first included full-recording verification. The workflow's `full_recording` option downloads format 135 with default clients and no plugins, decodes the entire video, records finite diagnostics, and removes the temporary media. The probe owner confirmed deletion of the temporary `YOUTUBE_PROBE_COOKIES` secret. Normal streaming jobs retain their separate validation `YOUTUBE_COOKIES` secret. See [deployed streaming acceptance](youtube-support-status.md#october-27-deployed-rollout) for the actual scheduler/OCR results.

These probes establish authenticated hosted playback. The subsequent deployed rollout provisioned the application cookie secret, updated extractor dependencies, and verified two full scheduler-driven recordings at native 480p. Cookie renewal remains an operational responsibility. The anonymous results below remain valid.

## Research before implementation

The [upstream guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) recommends `mweb` with an automatic token provider. The current [bgutil README](https://github.com/Brainicism/bgutil-ytdlp-pot-provider#readme) distinguishes token-generation failures from an earlier `LOGIN_REQUIRED` response and suggests `mweb,tv,web_safari` as another client combination.

Relevant user reports explain why one successful token is not enough:

* [bgutil #37](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/issues/37) reproduces the exact GitHub Actions problem: a token was generated, but YouTube still required login. The maintainer attributes this to datacenter-IP restrictions.
* [bgutil #242](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/issues/242) identifies a different failure: tokens were minted, but media returned 403. Pairing the homepage challenge with its matching `ytcfg` fixed that problem in 1.3.2. Our existing 2.0.2 already includes that fix.
* [yt-dlp #17368](https://github.com/yt-dlp/yt-dlp/issues/17368) contains successful anonymous `mweb` and authenticated `web_creator` reports, alongside failures on other networks. Some users could download with `web_creator` and cookies while `mweb` with cookies failed partway through. Those reports do not establish anonymous hosted access.
* [WPC](https://github.com/coletdjnz/yt-dlp-getpot-wpc) is the upstream guide's alternative provider. It launches Chrome and uses YouTube's WebPoClient to mint guest or authenticated tokens. This experiment tests guest mode.

The latest stable [yt-dlp release is 2026.10.26](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26), newer than our runtime pin of 2026.8.19. Bgutil remains at 2.0.2. WPC is 1.1.2. The [extractor options](https://github.com/yt-dlp/yt-dlp#youtube) document `fetch_pot=always`, which attempts token fetching even when a client does not normally require a token for that context.

## Experiment

The diagnostic workflow retains the installed production-version baseline before installing any token plugin. Its experimental stage upgrades only that job to yt-dlp 2026.10.26 with EJS 0.8.0 and Deno. Normal ingestion and OCR dependency pins do not change.

The workflow requires no GitHub environment or secrets. Official Data API metadata is explicitly skipped without an API key; the standalone baseline script can still check it when a caller supplies `YOUTUBE_API_KEY`. The first three dispatches were rejected by validation-environment branch protection before any runner started. They are not YouTube results.

Each video runs on two independent GitHub-hosted jobs, one with bgutil 2.0.2 and its existing digest-pinned service, one with WPC 1.1.2 and Chrome under Xvfb. Each job tries:

1. Current default clients with plugins disabled and `fetch_pot=never`.
2. `mweb` with automatic token fetching.
3. `mweb` with `fetch_pot=always`, including early player-token requests.
4. The provider's documented `mweb,tv,web_safari` alternative.
5. `web_safari` alone to distinguish its HLS behavior from a combined client result.

The same three recordings used in October's earlier experiment are the primary comparison set: `jwxFzTcvWLs`, `Bfr68889LR0`, and `62BIbb1liSU`.

Reports separate provider loading, token requests, token retrieval, player statuses, format resolution, and FFmpeg decoding. Successful extraction selects a native rendition of at least 480p and decodes frames at the start, 220 seconds, 1800 seconds, and near EOF. Saved frames are not upscaled. Token-assisted success requires both actual token retrieval and all requested frames decoding. A plugin-free success is reported separately rather than attributed to PO tokens.

Only finite diagnostics and decoded images enter artifacts. Signed media URLs, tokens, and raw verbose output stay out of reports. No catalog mutation, OCR dispatch, cookies, or proxy configuration is involved.

Run from this experiment branch:

```sh
gh workflow run check-youtube-access.yml --ref docs/youtube-support-status \
	-f video_id=jwxFzTcvWLs -f probe=po_token
```

## Results

### GitHub-hosted runners

All six jobs ran on GitHub-hosted Ubuntu at probe commit `f57107f07d0b8ad8652fe934d0a6eb1213d5f403`. Each completed dependency installation and uploaded its JSON report. The original protected-environment rejections are excluded from these results.

| Video | Run | Bgutil forced token | Final extraction result, both providers |
| --- | --- | --- | --- |
| `jwxFzTcvWLs` | [40535744865](https://github.com/liftaris/bazaar-ghost/actions/runs/40535744865) | Retrieved | `LOGIN_REQUIRED` / `auth_required` |
| `Bfr68889LR0` | [40535749790](https://github.com/liftaris/bazaar-ghost/actions/runs/40535749790) | Retrieved | `LOGIN_REQUIRED` / `auth_required` |
| `62BIbb1liSU` | [40535754413](https://github.com/liftaris/bazaar-ghost/actions/runs/40535754413) | Retrieved | `LOGIN_REQUIRED` / `auth_required` |

All 30 experimental client/policy attempts failed at extraction, including six current-version plugin-free controls. The six old-version Streamlink-first baselines also returned `auth_required`. No hosted attempt reached format selection or frame decoding.

The important new evidence is the three bgutil `mweb;fetch_pot=always` cases: each successfully retrieved a PO token before YouTube still required login. The earlier conclusion that token fetching never ran is therefore no longer complete. Forcing token generation does not resolve this hosted login restriction.

WPC loaded in all three jobs but reported no retrieved token. Its request log uses `Launching` and `Minting`, which the initial diagnostic parser did not recognize. The corrected parser was tested in [40536277752](https://github.com/liftaris/bazaar-ghost/actions/runs/40536277752) at `a8cf9fc`. On those two additional hosted runners, all ten extraction attempts again returned `LOGIN_REQUIRED`. Bgutil again retrieved a forced token. WPC was available, found Chrome, and attempted browser launch for the forced request, but no token was retrieved. The finite diagnostics do not establish why WPC's browser token generation failed. This is not evidence of a successful WPC token being rejected.

Across the primary set and diagnostic repeat, eight actual hosted jobs produced 40 failed extraction attempts. Bgutil successfully retrieved forced tokens in four of those attempts, each followed by the login rejection.

### Local control

On the local network, yt-dlp 2026.10.26 with default clients and plugins disabled selected native-480p HLS format 231. All four frames decoded at 0, 220, 1800, and 3903 seconds. Independent ffprobe inspection confirmed all four JPEGs are 852 × 480, with distinct hashes.

Bgutil `mweb` with both automatic and forced tokens, and the combined-client case, retrieved tokens and selected direct-HTTPS format 135 at 480p. Every requested frame returned HTTP 403. The isolated `web_safari` attempt retrieved a token but timed out during extraction. These failures apply to the selected rendition and FFmpeg path, not every format the extractor might expose.

Local evidence is saved under `/tmp/opencode/youtube-pot-local/`. Hosted artifacts are downloaded under `/tmp/opencode/youtube-pot-hosted/`; GitHub retains the uploaded reports for seven days. The local run is a network control, not a substitute for the six actual hosted jobs.

### Conclusion

Anonymous YouTube access remains blocked on the tested GitHub-hosted runners, even after successful forced token retrieval with the current extractor. A dependency upgrade or PO-token sidecar alone does not establish automatic support. Current yt-dlp's token-free HLS result is promising for processing on the already-working local network, but no full-recording OCR run was performed in this experiment.
