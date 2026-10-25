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

Use worker spans to inspect elapsed stage time, including queue waits. Inference spans report the task, client attempt number, and returned status. They do not attach images, prompts, credentials, or response bodies. No per-frame spans are emitted.

For failed jobs, inspect the root and failing worker's exception events. Logs emitted inside a worker carry that worker's trace context. A recovered media attempt remains an error span without marking the completed job as failed.

For local runs, pass `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` into the container from validation-only configuration. Optional `TRACEPARENT` and `TRACESTATE` environment variables continue a caller's W3C context. The GitHub workflow starts independent job traces; it does not accept a dispatcher's trace context.

If traces are missing, check the runtime revision and exporter errors. Validation has no fallback to `GRAFANA_OTLP_*` credentials used by other environments. Without its endpoint secret, telemetry stays disabled.

The process ends its root span before exporter shutdown. Forced termination can still lose buffered telemetry, and initialization failures before `process_chunk` starts do not create a chunk span.

To run the offline regression checks in a Python environment with the SFDE runtime and test dependencies installed:

```sh
cd sfde
python -m pytest -o addopts='' -p no:cacheprovider tests/test_telemetry.py tests/test_next_processor.py tests/test_next_profile_claims.py tests/test_pipeline.py
```

The telemetry checks exercise Next's real orchestration, retry, inference-client, and upload-client methods with fake media and backend responses. They also send OTLP protobuf to a local HTTP collector and assert that the completed root arrives before process exit.
