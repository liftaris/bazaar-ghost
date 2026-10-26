"""SFDE Next trace contracts without backend, media, or inference network calls."""

from types import SimpleNamespace
from unittest.mock import Mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

import encounter_pipeline
import sfde
import telemetry
from backend_client import BackendClient
from sfde import MediaReadError


@pytest.fixture
def traces(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(exporter, schedule_delay_millis=60000))
    monkeypatch.setattr(telemetry, '_tracer', provider.get_tracer('sfde-test'))
    yield provider, exporter
    provider.shutdown()


@pytest.fixture
def next_job(monkeypatch):
    monkeypatch.setenv('SFDE_NEXT_ENABLED', 'true')
    monkeypatch.setenv('ENVIRONMENT', 'local')
    monkeypatch.setenv('BAZAARGHOST_API_URL', 'http://localhost:8787')
    monkeypatch.setenv('BAZAARGHOST_PROCESSOR_KEY', 'test-secret')
    monkeypatch.setenv('CHUNK_ID', 'test')
    monkeypatch.setenv('GITHUB_RUN_ID', '1234')
    monkeypatch.delenv('OTEL_EXPORTER_OTLP_ENDPOINT', raising=False)
    monkeypatch.setattr(sfde.signal, 'signal', Mock())
    monkeypatch.setattr(sfde, 'FrameProcessor', Mock())

    def request(self, path, method='GET', data=None, chunk_id=None, raw=False):
        if method == 'GET':
            return {'vod_id': '123', 'start_seconds': 0, 'end_seconds': 300, 'status': 'pending'}
        if path.endswith('/claim'):
            return {'claimed': True, 'claim_token': 'test-claim'}
        if method == 'DELETE':
            return {'deleted': 0}
        if '/images?' in path:
            return {'storage_path': 'test/image.jpg'}
        return {'status': 'ok'}

    monkeypatch.setattr(BackendClient, '_request', request)

    def consume(jpeg, at_ms):
        return [{
            'schema_version': 2, 'id': 'encounter', 'chunk_id': 'test', 'timestamp': 0,
            'anchor_ms': 0, 'recording_identity': 'twitch:123', 'field_evidence': {},
            '_intro_ms': 0, '_images': {0: {'jpeg': jpeg, 'kind': 'intro'}},
        }]

    monkeypatch.setattr(encounter_pipeline, 'BufferedEncounterPipeline', Mock(return_value=SimpleNamespace(
        consume=consume, flush=lambda: [], stats={'samples': 1},
    )))
    processor = sfde.SFDEProcessor({'chunk_id': 'test', 'test_mode': True})
    processor.enricher = SimpleNamespace(enrich=lambda event: processor.backend.infer(
        'test', request_id='request', task='ghost_hero', at_ms=0, image_base64='private-image',
    ))
    processor.ffmpeg_worker = lambda: processor._put(processor.frame_queue, (b'jpeg', 0, True))
    processor.export_detection_summary = Mock()
    monkeypatch.setattr(sfde, 'MEDIA_RETRY_DELAY_SECONDS', 0)
    return processor


def test_next_trace_tree_and_remote_parent(next_job, traces):
    provider, exporter = traces
    next_job.trace_context = telemetry.extract_trace_context({
        'traceparent': '00-12345678901234567890123456789012-1234567890123456-01',
        'tracestate': 'vendor=value',
    })
    assert next_job.process_vod_chunk()['status'] == 'completed'
    provider.force_flush()
    spans = {span.name: span for span in exporter.get_finished_spans()}
    parents = {
        'sfde.attempt': 'process_chunk',
        'sfde.worker.ffmpeg': 'sfde.attempt',
        'sfde.worker.opencv': 'sfde.attempt',
        'sfde.worker.results': 'sfde.attempt',
        'sfde.enrich': 'sfde.worker.results',
        'sfde.inference': 'sfde.enrich',
        'backend_upload': 'sfde.worker.results',
    }
    root = spans['process_chunk']
    assert root.context.trace_id == int('12345678901234567890123456789012', 16)
    assert root.parent.span_id == int('1234567890123456', 16)
    assert root.context.trace_state.get('vendor') == 'value'
    assert root.attributes['sfde.processor_mode'] == 'next'
    assert root.attributes['github.run_id'] == '1234'
    for name, parent in parents.items():
        assert spans[name].parent.span_id == spans[parent].context.span_id
        assert spans[name].context.trace_id == root.context.trace_id
    assert len(spans) == 8
    assert spans['sfde.inference'].attributes['inference.status'] == 'ok'
    assert spans['sfde.inference'].attributes['inference.call_index'] == 1
    assert 'inference.attempt' not in spans['sfde.inference'].attributes
    assert spans['backend_upload'].attributes['upload.attempts'] == 1
    assert root.attributes['workers.unfinished'] == 0
    assert 'private-image' not in str([dict(span.attributes) for span in spans.values()])


def test_retry_keeps_failed_attempt_and_successful_root(next_job, traces):
    provider, exporter = traces
    decode = next_job.ffmpeg_worker
    attempts = []

    def retry_decode():
        attempts.append(1)
        if len(attempts) == 1:
            raise MediaReadError('temporary media failure')
        decode()

    next_job.ffmpeg_worker = retry_decode
    next_job.process_vod_chunk()
    provider.force_flush()
    spans = exporter.get_finished_spans()
    attempts = sorted((s for s in spans if s.name == 'sfde.attempt'), key=lambda s: s.attributes['attempt'])
    assert len(attempts) == 2
    assert attempts[0].status.status_code == StatusCode.ERROR
    assert attempts[1].status.status_code == StatusCode.UNSET
    root = next(s for s in spans if s.name == 'process_chunk')
    assert root.attributes['status'] == 'completed'
    assert root.status.status_code != StatusCode.ERROR
    for attempt in attempts:
        workers = [s for s in spans if s.parent and s.parent.span_id == attempt.context.span_id]
        assert len(workers) == 3
        assert all(s.end_time <= attempt.end_time for s in workers)


@pytest.mark.parametrize('fails', [False, True])
def test_main_exports_root_after_success_or_failure(next_job, traces, monkeypatch, fails):
    provider, exporter = traces
    if fails:
        next_job.ffmpeg_worker = Mock(side_effect=RuntimeError('decoder failed'))
    monkeypatch.setattr(sfde, 'SFDEProcessor', Mock(return_value=next_job))
    monkeypatch.setattr(sfde, 'shutdown_telemetry', provider.shutdown)
    with pytest.raises(SystemExit) as exited:
        sfde.main()
    assert exited.value.code == int(fails)
    spans = exporter.get_finished_spans()
    root = next(s for s in spans if s.name == 'process_chunk')
    assert root.attributes['status'] == ('failed' if fails else 'completed')
    if fails:
        for span in (root, next(s for s in spans if s.name == 'sfde.worker.ffmpeg')):
            assert span.status.status_code == StatusCode.ERROR
            assert len([event for event in span.events if event.name == 'exception']) == 1


def test_disabled_telemetry_and_invalid_parent(monkeypatch):
    monkeypatch.setattr(telemetry, '_tracer', None)
    with telemetry.create_span('disabled') as span:
        assert span is None
    context = telemetry.extract_trace_context({'traceparent': 'invalid'})
    assert not trace.get_current_span(context).get_span_context().is_valid


def test_next_service_identity(next_job, monkeypatch):
    initialize = Mock(return_value=True)
    monkeypatch.setattr(sfde, 'init_telemetry', initialize)
    monkeypatch.setenv('BUILD_COMMIT', 'runtime-commit')
    next_job._init_telemetry()
    initialize.assert_called_once_with(service_name='sfde-next', service_version='runtime-commit', environment='local')


def test_job_reaches_otlp_http_collector_before_exit(next_job, monkeypatch):
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    from opentelemetry.sdk.resources import Resource

    received = []

    class Collector(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(('127.0.0.1', 0), Collector)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    provider = TracerProvider(resource=Resource.create({'service.name': 'sfde-next'}))
    exporter = OTLPSpanExporter(endpoint=f'http://127.0.0.1:{server.server_port}/v1/traces', timeout=2)
    provider.add_span_processor(BatchSpanProcessor(exporter, schedule_delay_millis=60000))
    monkeypatch.setattr(telemetry, '_tracer', provider.get_tracer('sfde-test'))
    monkeypatch.setattr(sfde, 'SFDEProcessor', Mock(return_value=next_job))
    monkeypatch.setattr(sfde, 'shutdown_telemetry', provider.shutdown)
    try:
        with pytest.raises(SystemExit) as exited:
            sfde.main()
        assert exited.value.code == 0
        assert received and all(path == '/v1/traces' for path, _ in received)
        spans = []
        for _, body in received:
            request = ExportTraceServiceRequest.FromString(body)
            for resource in request.resource_spans:
                assert any(a.key == 'service.name' and a.value.string_value == 'sfde-next'
                           for a in resource.resource.attributes)
                spans.extend(span for scope in resource.scope_spans for span in scope.spans)
        assert len(spans) == 8
        root = next(span for span in spans if span.name == 'process_chunk')
        assert root.end_time_unix_nano > root.start_time_unix_nano
        assert all(span.trace_id == root.trace_id for span in spans)
    finally:
        provider.shutdown()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_worker_timing_accounts_waits_without_frame_spans(next_job, traces):
    provider, exporter = traces
    next_job.encounters.consume = lambda *_: []
    next_job.ffmpeg_worker = lambda: [next_job._put(next_job.frame_queue, (b'jpeg', n, True)) for n in range(500)]
    next_job.process_vod_chunk()
    provider.force_flush()
    spans = exporter.get_finished_spans()
    assert len(spans) == 5
    cv = next(s for s in spans if s.name == 'sfde.worker.opencv')
    assert cv.attributes['work.analysis.calls'] == 501
    assert cv.attributes['work.queue_read.calls'] >= 500
    assert cv.attributes['work.analysis.seconds'] >= 0
    assert cv.attributes['work.queue_read.seconds'] >= 0
    decode = next(s for s in spans if s.name == 'sfde.worker.ffmpeg')
    assert decode.attributes['work.queue_write.calls'] == 500


def test_timers_do_not_include_consumer_work(monkeypatch):
    clock = iter((0., 2., 10., 13., 20., 21.))
    monkeypatch.setattr(telemetry.time, 'perf_counter', lambda: next(clock))
    span = Mock()
    with telemetry.worker_timing('ffmpeg', span):
        assert list(telemetry.measured_frames(['one', 'two'])) == ['one', 'two']
    values = dict(call.args for call in span.set_attribute.call_args_list)
    assert values['work.decode_read.seconds'] == 6
    assert values['work.decode_read.calls'] == 3
    assert values['work.queue_write.seconds'] == 0


def test_metric_attributes_exclude_job_identity(monkeypatch):
    metric = Mock()
    monkeypatch.setattr(telemetry, '_metrics', {'test': metric})
    attrs = {'streamer': 'person', 'chunk_id': 'id', 'trace_id': 'trace', 'quality': '480p', 'stage': 'opencv'}
    telemetry.record_counter('test', 1, attrs)
    telemetry.record_histogram('test', 2, attrs)
    metric.add.assert_called_once_with(1, {'quality': '480p', 'stage': 'opencv'})
    metric.record.assert_called_once_with(2, {'quality': '480p', 'stage': 'opencv'})


def test_completion_update_failure_never_logs_success(next_job, traces, monkeypatch):
    monkeypatch.setattr(next_job.logger, 'info', Mock())
    def update(chunk, status, **fields):
        if status == 'completed':
            raise RuntimeError('completion unavailable')
    next_job.backend.update_chunk = update
    with pytest.raises(RuntimeError, match='completion unavailable'):
        next_job.process_vod_chunk()
    assert all(call.args[0] != 'chunk_finished' for call in next_job.logger.info.call_args_list)
    traces[0].force_flush()
    root = next(s for s in traces[1].get_finished_spans() if s.name == 'process_chunk')
    assert root.attributes['status'] == 'failed'


@pytest.mark.parametrize('reason', ['signal', 'timeout'])
def test_interruption_has_terminal_reason(next_job, traces, reason):
    if reason == 'signal':
        next_job._handle_shutdown(15, None)
    else:
        next_job._run_workers = Mock(side_effect=TimeoutError('deadline'))
    with pytest.raises((RuntimeError, TimeoutError)):
        next_job.process_vod_chunk()
    traces[0].force_flush()
    root = next(s for s in traces[1].get_finished_spans() if s.name == 'process_chunk')
    assert root.attributes['termination.reason'] == reason
    assert root.status.status_code == StatusCode.ERROR


def test_shutdown_isolates_flush_failure_and_reports_timeout(monkeypatch, capsys):
    import json
    providers = [Mock(), Mock(), Mock()]
    providers[0].force_flush.side_effect = RuntimeError('trace flush failed')
    providers[1].force_flush.return_value = False
    monkeypatch.setattr(telemetry, '_initialized', True)
    monkeypatch.setattr(telemetry, '_logger_provider', providers[2])
    monkeypatch.setattr(telemetry, '_otel_handler', None)
    monkeypatch.setattr(telemetry.trace, 'get_tracer_provider', lambda: providers[0])
    monkeypatch.setattr(telemetry.metrics, 'get_meter_provider', lambda: providers[1])
    telemetry.shutdown_telemetry(100)
    telemetry.shutdown_telemetry(100)
    for provider in providers:
        provider.force_flush.assert_called_once_with(100)
        provider.shutdown.assert_called_once()
    report = json.loads(capsys.readouterr().out)
    assert report['providers']['traces.force_flush'] == 'RuntimeError'
    assert report['providers']['metrics.force_flush'] == 'timeout'


def test_export_audit_reports_root_without_payload(next_job, traces, monkeypatch, capsys):
    import json
    from opentelemetry.sdk.trace.export import SpanExportResult
    next_job.process_vod_chunk()
    traces[0].force_flush()
    monkeypatch.setattr(telemetry.OTLPSpanExporter, 'export', lambda *_: SpanExportResult.SUCCESS)
    exporter = telemetry.AuditedSpanExporter(endpoint='http://localhost:1')
    exporter.export(traces[1].get_finished_spans())
    exporter.shutdown()
    reports = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    report = next(r for r in reports if r.get('event') == 'telemetry_trace_export')
    assert report['result'] == 'SUCCESS'
    assert report['roots'][0]['status'] == 'completed'
    assert len(report['roots'][0]['trace_id']) == 32
    assert 'private-image' not in str(report)


def test_real_providers_flush_all_signals_in_subprocess():
    import os
    import subprocess
    import sys
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
    from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
    received = []
    class Collector(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass
    server = HTTPServer(('127.0.0.1', 0), Collector)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {k: v for k, v in os.environ.items() if not k.startswith('OTEL_')}
    env.update(OTEL_EXPORTER_OTLP_ENDPOINT=f'http://127.0.0.1:{server.server_port}',
               PYTHONPATH=os.path.dirname(telemetry.__file__))
    try:
        result = subprocess.run([sys.executable, '-c', '''
import logging
import telemetry
logging.getLogger('sfde').setLevel(logging.INFO)
assert telemetry.init_telemetry('sfde-next', 'test-revision', 'local')
with telemetry.create_span('process_chunk', {'status': 'completed'}):
    telemetry.record_counter('chunks_completed', 1, {'quality': '480p', 'streamer': 'private-person'})
    logging.getLogger('sfde').info('chunk_finished')
telemetry.shutdown_telemetry(5000)
'''], env=env, capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
        assert 'telemetry_trace_export' in result.stdout
        assert '"traces.force_flush": "completed"' in result.stdout
        assert {path for path, _ in received} == {'/v1/traces', '/v1/metrics', '/v1/logs'}
        spans, records = [], []
        for path, body in received:
            if path == '/v1/traces':
                request = ExportTraceServiceRequest.FromString(body)
                spans.extend(s for r in request.resource_spans for scope in r.scope_spans for s in scope.spans)
            elif path == '/v1/logs':
                request = ExportLogsServiceRequest.FromString(body)
                records.extend(l for r in request.resource_logs for scope in r.scope_logs for l in scope.log_records)
            else:
                request = ExportMetricsServiceRequest.FromString(body)
                assert 'private-person' not in str(request)
                assert 'sfde.chunks.completed' in str(request)
        assert len(spans) == 1
        terminal = next(r for r in records if r.body.string_value == 'chunk_finished')
        assert terminal.trace_id == spans[0].trace_id
        assert terminal.span_id == spans[0].span_id
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
