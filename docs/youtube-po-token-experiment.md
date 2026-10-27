# YouTube PO-token experiment, October 27, 2026

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

Pending execution. Tests of diagnostic parsing are not evidence of YouTube access.
