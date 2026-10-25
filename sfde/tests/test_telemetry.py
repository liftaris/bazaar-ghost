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
