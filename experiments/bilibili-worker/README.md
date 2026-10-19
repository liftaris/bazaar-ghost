# Bilibili listing access from a Worker (spike, KAI-41)

Does Bilibili accept the anonymous listing calls that ingestion needs when they
come from Cloudflare Worker egress? **No.** Every request from the hosted Worker
was rejected with HTTP 412. GitHub-hosted runners were accepted, so Bilibili
ingestion stays on the Actions runner.

## What the probe does

`GET /probe` runs one round in sequence, with a configurable gap between calls:

1. `/x/frontend/finger/spi` — anonymous device cookie (`buvid3`/`buvid4`), cached in the isolate
2. `/x/web-interface/search/type` — `大巴扎`, newest first
3. `/x/series/recArchivesByKeywords` — first page for three known uploader UIDs
4. `/x/web-interface/view` and `/x/web-interface/card`

It reports only HTTP status, provider code and item counts, never response
bodies or cookie values. Hosted mode requires a bearer token, expires within one
hour, and disables preview URLs and traces. `run.py` repeats rounds and
summarizes outcomes per endpoint.

The client sends `User-Agent: BazaarGhost/1.0`. In local tests a browser
User-Agent without browser behavior was rejected on `view` every time, while the
plain client UA plus device cookie succeeded 9/9.

## Results — October 18, 2026

| Network | Rounds | spi | search | uploader | view | card |
|---|---:|---|---|---|---|---|
| Cloudflare Worker (SEA), 90 s apart over 25 min | 15 | 0/15 | 0/15 | 0/45 | 0/15 | 0/15 |
| GitHub-hosted runner (run 39177591750), 3 s gaps | 6 | 2/2 | 6/6 | 10/18 | 6/6 | 6/6 |
| Residential, 5 s gaps, plain UA + cookie | 3 | 1/1 | 3/3 | 3/3 | 3/3 | — |

All Cloudflare failures were HTTP 412, including the cookie bootstrap. The
runner's uploader failures were also 412 and came from consecutive uploader
calls 3 s apart; listing needs per-endpoint pacing and retry. The same runner
decoded a full 1800 s Bilibili chunk (900/900 samples in 102 s).

The hosted Worker `bazaarghost-bilibili-hosted-probe` was deleted afterward and
its token file removed. The validation Worker was not changed.

## Run locally

```sh
ln -s ../../node_modules node_modules
node_modules/.bin/cf workers types --mode local
npm run dev            # http://127.0.0.1:8792/probe?gap=3000&fresh=1
python3 run.py http://127.0.0.1:8792 5 60 /tmp/rounds.jsonl
```

For a hosted repeat, put a random `PROBE_TOKEN` in a private JSON secrets file,
set `BILIBILI_PROBE_EXPIRES` to a millisecond timestamp within the next hour,
then `cf build --mode hosted` and `cf deploy --prebuilt --mode hosted
--secrets-file <file>`. Run `run.py` with `BILIBILI_PROBE_TOKEN`, then delete
the Worker with `cf workers delete <name> --force`.
