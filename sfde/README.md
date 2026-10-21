# SFDE

SFDE processes one database chunk: **Stream → Filter → Detect → Extract**. Its input is `CHUNK_ID`, not a VOD command-line range. The database supplies the Twitch source ID and the half-open time range `[start_seconds, end_seconds)`.

## Execution

The orchestrator runs three workers:

1. **Decoder:** Streamlink resolves an exact rendition URL. FFmpeg downloads and accurately seeks that playlist, normalizes dimensions, applies the profile crop, and emits JPEGs plus `showinfo` timestamps. `video.py` pairs pixels and timestamps before enqueuing them. Sampling defaults to one frame every two seconds.
2. **OCR:** OpenCV finds a rank emblem and the right edge. Only the resulting username crop reaches PaddleOCR. Missing/invalid boundaries cannot fall back to reading the whole frame. A custom opaque edge marks the result as truncated. The same continuously visible matchup is emitted once; failed OCR leaves the next sample eligible. An optional IGD region is scanned for up to 15 subsequent samples, preserving the username even if day extraction fails or EOF arrives.
3. **Results:** Batches screenshots and detections. The required screenshot is uploaded before the database insert; optional debug-image failures are logged. Stable detection IDs make a retried insert safe after a lost response. Only persisted metadata is retained for the job summary.

The two bounded queues apply backpressure. EOF signals and cancellation are separate: normal EOF drains everything; any worker failure, zero-frame decode, cancellation, or processing deadline fails the chunk. A worker claims a pending/queued chunk atomically before replacing old detections. A 35-minute lease allows the scheduler to recover abandoned workers; the processing deadline must remain shorter than that lease.

## Profiles and templates

`SFDE_PROFILE` is required JSON. `crop_region` and optional `igd_crop_region` are `[x, y, width, height]` fractions of the full video dimensions. `custom_edge` is a fraction of nameplate width; `opaque_edge` selects the overlay boundary. Regions must be finite, positive in size, and fit within the frame.

```json
{"profile_name":"example","crop_region":[0.50,0.50,0.40,0.20],"opaque_edge":false}
```

Use the streamer's database profile, not this illustrative crop, for real processing. Supported qualities are 360p, 480p, 720p, and 1080p, with 30/60 FPS renditions. Quality controls template selection and normalization; sampling rate remains independent. Pre-August-12-2025 templates exist only for 480p. The orchestrator/workflow derives that cutoff from the VOD publication date; direct runs must supply `OLD_TEMPLATES=true` when applicable. Missing required template sets fail startup.

## Build and run

From the repository root, create `.env.dev` containing only local/development settings, and export `CHUNK_ID` and `SFDE_PROFILE`. The profile can be obtained from the streamer's `sfde_profiles` relation.

```bash
docker build --build-context contracts=./contracts -t sfde:dev sfde/
docker run --rm --network host --env-file .env.dev \
  -e CHUNK_ID -e SFDE_PROFILE -e QUALITY=480p -e ENVIRONMENT=dev \
  sfde:dev
```

For a rerun, reset only an inactive local chunk to `pending`; do not reset a running worker. The Worker admin `retry-vod` endpoint rejects active workers and preserves chunk identities. A normal successful run exports `/app/output/detections_<chunk-id>.json`; mount a writable output directory to retain it. The image runs as user `sfde` (UID 1000).

To use an existing video instead of Twitch:

```bash
docker run --rm --network host --env-file .env.dev \
  -v "$PWD/.ignore/clip.mp4:/video.mp4:ro" \
  -e CHUNK_ID -e SFDE_PROFILE -e QUALITY=480p -e ENVIRONMENT=dev \
  -e TEST_MODE=true -e TEST_VIDEO=/video.mp4 sfde:dev
```

`TEST_MODE` changes video input; it still publishes detections and screenshots to the configured Worker. Use a full VOD file, or a synthetic local chunk beginning at zero, because seeking uses the database's absolute range. It is not a dry run. Credentials are never auto-loaded by Python.

`docker compose -f sfde/docker-compose.yml up --build` provides a one-shot equivalent using `.env.dev`, `CHUNK_ID`, and `SFDE_PROFILE`. The helper `sfde/build.sh` builds locally; `--test` runs the suite, and `--push` explicitly publishes the image.

## Tests and tuning

OCR uses PaddleOCR **3.7.0**, PaddlePaddle CPU **3.3.1**, and PaddleX **3.7.2**.
`src/ocr_runtime.py` shares explicit `PP-OCRv5_mobile_det` and
`en_PP-OCRv5_mobile_rec` settings between runtime and Docker cache warmup.
It uses one CPU inference thread, disables oneDNN for mobile-graph compatibility,
and leaves document orientation/unwarping and textline orientation disabled.
Explicit models avoid the larger PP-OCRv6 default; retaining v5 also preserves
the existing English name/day behavior. Docker exercises a prediction during
warmup, and the tests check cached inference without network access.

```bash
docker build --build-context contracts=./contracts --target test -t sfde:test sfde/
docker run --rm --network none sfde:test
```

The test image installs pytest separately from runtime dependencies and caches the same OCR models as production. Tests cover the validated image corpus, template boundaries, OCR cleaning, cooldown/reappearance, queue draining, worker failures, timestamp pairing, non-segment-aligned HLS seeking, IGD association, and persistence retries. Missing validated fixture images fail collection rather than silently shrinking coverage.

`config.yaml` contains the actual runtime controls: sampling/queue/deadline, detector thresholds, OCR confidence and minimum interval, storage batch/retry settings, and log level. Start with the labeled corpus when changing thresholds. Passing fixture tests does not measure recall over all Twitch frames: 0.5 FPS can miss a shorter screen, new game UI can invalidate templates, and truncated names remain partial evidence. Preserve those flags for consumers.
