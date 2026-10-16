# Cloudflare CLI and dependency maintenance

The project uses `cf` with `cloudflare.config.ts`. `config/environments.json` holds the separate local/dev/validation/production resource identities. Unknown modes and preview deployments are rejected. Vitest's `test` mode uses local resources. Production and dev retain their unprovisioned placeholders and deployment gates.

Wrangler remains a pinned build dependency: `cf` delegates bundling and local serving to it. `wrangler.config.ts` contains only build/dev settings; the old Wrangler JSONC configurations are removed. Cloudflare's maintained `@cloudflare/vitest-plugin` replaces the deprecated pool package. Vitest 5's filesystem module cache is disabled because workerd cannot read the host's cache files.

## Local development

```sh
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run db:seed
npm run dev
```

Local D1 operations and the dev server share `.wrangler/state/`, the current cf Wrangler-bundler default, explicitly avoiding cf's machine-wide database directory. cf dev does not accept the resource CLI's `--persist-to` flag. The new local UUID creates a separate database alongside previous local state; no old database is deleted. Local database commands always pass `--local`; `cf` otherwise defaults to remote access. The local database uses a synthetic UUID because cf migration commands reject an all-zero UUID. No hosted database uses it.

```sh
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s scripts/tests
RUN_LOCAL_D1_MIGRATION_TESTS=1 python3 -m unittest scripts.tests.test_migration_d1
```

`npm run typecheck` generates `.cloudflare/types/index.d.ts`. Generated files are ignored. Runtime compatibility remains `2026-08-22`; upgrading dependencies does not silently change Worker runtime semantics.

## Hosted validation

`cf` has its own login and does not reuse Wrangler credentials:

```sh
npx cf auth login
python3 scripts/deployment_check.py validation --ref refs/heads/migration/cloudflare
BUILD_COMMIT="$(git rev-parse HEAD)" npx cf build --mode validation
npx cf deploy --prebuilt --mode validation --dry-run
python3 scripts/database.py migrate --environment validation
npx cf deploy --prebuilt --mode validation
```

Build once, then check and deploy that exact artifact with the same mode. `BUILD_COMMIT` must be set at build time. Remote database operations use the selected environment's database ID and refuse unprovisioned/cross-environment configurations. The validation CI workflow follows this sequence with its dedicated Cloudflare token and account ID; it still skips deployment when those credentials are absent.

Set secrets in the Cloudflare dashboard, or pass a private JSON file to `cf deploy --prebuilt --mode validation --secrets-file <PATH>`. This uploads secrets as part of a deployment. Never commit the file or put secret values in command arguments. Existing hosted secrets are preserved by normal deployments. Local `.dev.vars` remains local; optional disabled provider integrations are not made required by the configuration migration.

### Configured validation deployment

On October 14, 2026, the validation GitHub environment was configured with `CLOUDFLARE_VALIDATION_API_TOKEN` and its existing account ID. [Run 38674960947](https://github.com/liftaris/bazaar-ghost/actions/runs/38674960947) completed tests, the cf build/prebuilt dry-run, remote D1 migrations, deployment, and exact-commit health verification. A green deploy job now represents an actual deployment when these credentials remain configured.

The dedicated account-owned token is named `bazaarghost-validation-github-deploy`. Its permissions are Workers Scripts Write, D1 Write, Queues Write, and Workers R2 Storage Metadata Read on the configured account. These service permissions are account-scoped; the token name and GitHub environment do not restrict it to individual validation resources. Existing branch/resource guards remain required. Renew or replace it before `2027-01-13T00:00:00Z` (January 12, 2027, 4 p.m. Pacific), then update the GitHub environment secret.

The validation Worker has its GitHub dispatch secret, and validation has a YouTube API key for the read-only runner check:

```sh
gh workflow run check-youtube-access.yml --ref migration/cloudflare -f video_id=jwxFzTcvWLs
```

This check reads official metadata and decodes one real video frame. It performs no catalog writes or OCR dispatch. [Hosted run 38675486605](https://github.com/liftaris/bazaar-ghost/actions/runs/38675486605) could read metadata but failed playback with `auth_required`; the same check passed locally. An API key does not provide media playback access. Recurring YouTube processing remains disabled until the chosen Actions runner passes playback and the pending ingestion backlog is reviewed. Twitch has separate [hosted acceptance](backend-validation-status.md#twitch-acceptance-october-16-2026). The normal catalog path still uses yt-dlp; the preflight does not silently change its readiness or duration semantics.

### YouTube PO-token probe

The same manual workflow can compare the existing resolver with yt-dlp's
[documented token-provider setup](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide):

```sh
gh workflow run check-youtube-access.yml --ref migration/cloudflare \
  -f video_id=jwxFzTcvWLs -f probe=po_token
```

It checks the baseline before installing the plugin, then starts the
`bgutil-ytdlp-pot-provider` 2.0.2 service on loopback and installs its matching
plugin. The container is pinned by digest. It tries `mweb`, then the provider's
documented `mweb,tv,web_safari` alternative if needed. Success requires evidence
that yt-dlp retrieved a PO token and decoded frames at the start, 220 seconds,
1800 seconds, and near the end, using an available video rendition of at least
480p. Shorter recordings use bounded timestamps.

The artifact contains safe JSON reports and successfully decoded JPEGs. Token
values, signed URLs, and verbose extractor output are never included. The job
stops the provider afterward. This is a read-only experiment, with no catalog
writes, OCR dispatch, cookies, or changes to normal processing dependencies.

On October 14, 2026, all three GitHub-hosted probes failed during extraction:

| Recording | Run | Result for both client configurations |
| --- | --- | --- |
| `jwxFzTcvWLs` | [38682275472](https://github.com/liftaris/bazaar-ghost/actions/runs/38682275472) | `auth_required`; no token request reached the provider |
| `Bfr68889LR0` | [38682278954](https://github.com/liftaris/bazaar-ghost/actions/runs/38682278954) | `auth_required`; no token request reached the provider |
| `62BIbb1liSU` | [38682281142](https://github.com/liftaris/bazaar-ghost/actions/runs/38682281142) | `auth_required`; no token request reached the provider |

Each runner could read official metadata, and each baseline also failed with
`auth_required`. The matching plugin loaded and the service passed its version
check. The local control did retrieve tokens, but direct 480p FFmpeg reads were
denied with HTTP 403; a separate bounded native yt-dlp download succeeded once.
Neither result establishes full playback readiness. The hosted failure happens
before the token-generation step, so adding this provider alone did not resolve
the sign-in restriction. Keep recurring YouTube processing disabled.

## October 2026 dependency update

Npm dependencies are exact-pinned in `package.json` and `package-lock.json`; Python direct dependencies are pinned in `sfde/requirements.txt`. GitHub Actions, Deno, and the disposable runner are also pinned to reviewed releases.

PaddleOCR 3.7 / PaddleX 3.7 require **PyYAML 6.0.2, OpenCV contrib 4.10.0.84, and NumPy <2.4**. NumPy 2.3.5 supports the existing Python 3.11 runtime. These constraints take precedence over newer incompatible releases. Only one OpenCV distribution is installed; the former headless package overlapped Paddle's `cv2` files. The image includes `libgl1` for the required contrib wheel.

Paddle 3.3's oneDNN executor fails on the mobile OCR graphs used here. CPU inference explicitly disables MKL-DNN; the same setting is used when caching the models. Accuracy must pass the existing offline corpus before accepting an update.

References: [cf migration](https://developers.cloudflare.com/cf/wrangler/migrate/), [cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/), [local resource data](https://developers.cloudflare.com/cf/projects/#local-resource-data), [cf CI](https://developers.cloudflare.com/cf/ci/).
