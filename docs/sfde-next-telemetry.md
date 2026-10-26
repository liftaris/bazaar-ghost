# Inspect SFDE Next job traces

1. Configure these secrets in the GitHub `validation` environment:
   - `GRAFANA_VALIDATION_OTLP_ENDPOINT`. Use the validation Grafana Cloud OTLP base endpoint, ending in `/otlp`.
   - `GRAFANA_VALIDATION_OTLP_AUTH`. Use the base64-encoded Grafana instance ID and access token. The workflow adds `Authorization=Basic`.
2. Give the token permission to write traces, metrics, and logs. SFDE exports all three through that endpoint.
3. Build and publish a tested runtime containing this change through your normal runtime-release process. Existing pinned images retain their old telemetry code.
4. Run `Process VOD` on `migration/cloudflare`, with environment `validation` and `sfde_next` enabled.
5. In Grafana Explore, select Tempo and search with TraceQL:

   ```traceql
   { resource.service.name = "sfde-next" && span.chunk.id = "<chunk UUID>" }
   ```

6. Open `process_chunk`. Inspect `github.run_id`, `github.run_attempt`, `sfde.runtime_image`, and the resource's `service.version` to identify the execution.
7. Expand each `sfde.attempt` to distinguish a failed media attempt from its successful retry.

```text
process_chunk [1]
└── sfde.attempt, once per media attempt [1a]
    ├── sfde.worker.ffmpeg [1a1]
    │   └── sfde.resolve_media [1a1a]
    ├── sfde.worker.opencv [1a2]
    └── sfde.worker.results [1a3]
        ├── sfde.enrich, once per encounter [1a3a]
        │   └── sfde.inference, once per submitted AI call [1a3a1]
        └── backend_upload, once per batch [1a3b]
```

Use worker spans to inspect elapsed stage time, including queue waits. Inspect `work.queue_read.seconds` and `work.queue_write.seconds` to separate input starvation from downstream backpressure. `work.decode_read.seconds` measures the time spent obtaining sampled frames from FFmpeg, including network and decoder waits. `work.analysis.seconds` measures Next's encounter analysis and final flush, excluding result-queue writes. These are wall times, not CPU measurements. Each operation also has a `.calls` count.

Inference spans report the task, `inference.call_index`, and returned status. The call index counts submissions within the chunk, not retries. Upload spans report `upload.attempts`, including persistence retries. Spans do not attach images, prompts, credentials, or response bodies. No per-frame spans or logs are emitted by the timing instrumentation.

For failed jobs, inspect the root and failing worker's exception events. Logs emitted inside a worker carry that worker's trace context. A recovered media attempt remains an error span without marking the completed job as failed.

Inspect `termination.reason` for `signal`, `timeout`, or `error`. A signal failure also includes `signal.number`. Check `workers.unfinished` before assuming that every daemon worker ended before the root. SIGKILL cannot flush telemetry.

Use `worker_timing` logs when a worker span is unavailable. Console JSON includes trace and span IDs, matching OTLP logs. `chunk_finished` is emitted only after the backend accepts the completed status.

For local runs, pass `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` into the container from validation-only configuration. Optional `TRACEPARENT` and `TRACESTATE` environment variables continue a caller's W3C context. The GitHub workflow starts independent job traces; it does not accept a dispatcher's trace context.

If traces are missing, check the runtime revision and exporter errors. Validation has no fallback to `GRAFANA_OTLP_*` credentials used by other environments. Without its endpoint secret, telemetry stays disabled.

Check `telemetry_trace_export` in the GitHub job log. Each batch reports the SDK export result, span counts, and the IDs and outcomes of exported roots. `SUCCESS` means the OTLP client accepted the export response, not that Tempo retained or indexed every span. `telemetry_shutdown` separately reports flush and shutdown results for traces, metrics, and logs. Failure of one provider does not skip the others.

If a correlated trace is absent from search, look it up by its trace ID. Grafana Adaptive Traces can restore dropped traces within 24 hours and marks restored spans with `grafana.adaptivetraces.restored`. Search of restored traces is best-effort. For reliable search coverage, configure an ingest sampling policy that keeps the validation service. Do not change production sampling to repair validation visibility. See [query dropped traces](https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-traces/query-dropped-traces/) and [Adaptive Traces policies API](https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-traces/manage-as-code/adaptive-traces-api/).

Metrics retain only quality, component, error type, stage, and operation attributes. Streamer, chunk, encounter, and trace IDs are not metric dimensions. A process-unique `service.instance.id` separates cumulative metric writers from concurrent jobs. This creates one target per process, not per frame. Stage wall-time histograms use seconds. Chunk and upload duration histograms use milliseconds. The old queue-depth UpDownCounter was removed because retries and Next consumers did not balance it. Use measured queue wait time instead.

Spans have at most 64 attributes and four events, with string attribute values capped at 512 characters. Exception detail can therefore be truncated. Export batching remains the SDK's bounded background queue rather than buffering an entire long-running job in memory.

The process ends its root span before exporter shutdown. Forced termination can still lose buffered telemetry, and initialization failures before `process_chunk` starts do not create a chunk span.

To run the offline regression checks in a Python environment with the SFDE runtime and test dependencies installed:

```sh
cd sfde
python -m pytest -o addopts='' -p no:cacheprovider tests/test_telemetry.py tests/test_next_processor.py tests/test_next_profile_claims.py tests/test_pipeline.py
```

The telemetry checks exercise Next's real orchestration, retry, inference-client, and upload-client methods with fake media and backend responses. They also send OTLP protobuf to a local HTTP collector and assert that the completed root arrives before process exit.
