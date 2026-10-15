# BazaarGhost

BazaarGhost finds opponents in Twitch VODs and published YouTube/Bilibili recordings of [The Bazaar](https://www.thebazaar.gg/) and makes their appearances searchable at [bazaarghost.stream](https://bazaarghost.stream). This repository contains the Cloudflare backend, Python OCR pipeline, and GitHub Actions. The frontend lives separately.

A detection means a sampled frame contained a rank emblem and an opponent name that passed OCR validation. It records the VOD, absolute second, rank, confidence, screenshot, truncation flags, and optional in-game day. It is not a complete match history.

## Processing

1. Twitch discovery catalogs streamers with processing **enabled** using their SFDE crop profile.
2. The Worker identifies Bazaar chapter ranges and plans missing chunks of at most 1,800 seconds, including short tails. Empty ranges create no work.
3. Signed EventSub events or scheduled work update the catalog. Eligible chunks dispatch to **GitHub Actions**.
4. Each SFDE container atomically claims a chunk with an attempt token. Streamlink resolves the rendition; FFmpeg samples at 0.5 FPS; OpenCV and PaddleOCR extract the opponent and optional day.
5. Required screenshots upload to R2 before detections enter D1. Completion waits for the entire pipeline to drain. Search hides unavailable VODs and low-confidence detections.

YouTube and Bilibili use independent creator accounts, durable discovery/readiness jobs, and source-specific media resolution. Bilibili parts are identified by BV/CID, so reordered parts keep their identity. Reviewed cross-platform appearances can be grouped without merging raw detections. The existing Twitch frontend contracts remain separate. See [platform ingestion](docs/platform-ingestion.md).

The backend also provides persistent clip anchors, likes, private hearts/favorites, comments, reports, and moderation. Clip identity survives OCR replacement at the same video timestamp. User writes use Discord/Twitch login and cookie sessions; actual provider setup is required. See the [auth setup](docs/user-auth.md) and [clip API](docs/clip-api.md). These APIs do not add UI to the separate frontend.

## Local development

```bash
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run db:seed
npm run dev
```

`cf dev` serves `http://localhost:8787` with local D1/R2/Queues. External integrations are disabled by default. No Cloudflare login is needed. Use Node 24+; Docker supplies the Python/OCR runtime.

```bash
npm run types
npm run typecheck
npm test
python3 -m unittest discover -s scripts/tests
npm run build  # dry-run bundle; does not deploy
```

See [CLI commands and dependency compatibility](docs/tooling.md) for the `cf` setup. See [Cloudflare setup, API contracts, migration and cutover](docs/cloudflare-migration.md) for the real local OCR smoke test and deployment prerequisites. See [SFDE usage](sfde/README.md) for processor details. The dedicated `migration/cloudflare` branch and GitHub `validation` environment isolate platform testing from existing dev/production. See [work log and verification](docs/platform-work-log.md) for current deployment status.

## Layout

| Path | Responsibility |
| --- | --- |
| `worker/` | HTTP, Twitch, Discord, jobs, D1 processing/search, R2 persistence |
| `worker/migrations/` | Active D1 schema |
| `worker/tests/` | Integration tests running in Cloudflare's local runtime |
| `sfde/src/` | FFmpeg/OpenCV/PaddleOCR pipeline and claim-scoped backend client |
| `sfde/tests/` | Labeled OCR corpus, IGD, streaming, and persistence regressions |
| `scripts/vod_workflow.py` | Safe GitHub workflow preparation and failure reporting |
| `scripts/migration/` | Read-only Supabase export, offline D1 conversion, source-schema history |
| `.github/workflows/` | Processing, builds/tests, manual deployment, Discord commands, weekly dev storage purge |

Current Worker logs use Cloudflare observability. SFDE optionally exports OTLP using `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`; telemetry does not determine processing success.

This project is not currently accepting external contributions and has no license grant; all rights reserved.
