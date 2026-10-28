"""HTTP persistence must fail closed and retry with stable detection identities."""
import base64
import logging
from unittest.mock import Mock
import pytest
from backend_client import BackendClient

PROFILE = {'id': 7, 'crop_region': [0.1, 0.2, 0.3, 0.4], 'igd_crop_region': [0.01, 0.02, 0.03, 0.04],
           'custom_edge': None, 'opaque_edge': True}


def test_processor_credentials_never_follow_an_http_redirect():
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    received = []

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append((self.path, self.headers.get('Authorization'), self.headers.get('User-Agent')))
            self.send_response(302)
            self.send_header('Location', '/unexpected-destination')
            self.end_headers()

        def log_message(self, *_):
            pass

    server = HTTPServer(('127.0.0.1', 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = BackendClient.__new__(BackendClient)
    client.url = f'http://127.0.0.1:{server.server_port}'
    client.key, client.timeout, client.claims = 'disposable-test-key', 2, {}
    try:
        with pytest.raises(ValueError, match='redirect'):
            client._request('chunks/example')
        assert received == [('/api/processor/chunks/example', 'Bearer disposable-test-key',
                             'BazaarGhost/1.0 (+https://github.com/liftaris/bazaar-ghost)')]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

@pytest.fixture
def client(monkeypatch):
    value = BackendClient.__new__(BackendClient)
    value.logger = logging.getLogger('test')
    value.quality, value.streamer = '480p', 'example'
    value.retry_attempts, value.claims = 2, {'abc': 'claim-token'}
    value._request = Mock(return_value={'storage_path': '/detections/123/abc/claim-token/detection_14.jpg'})
    monkeypatch.setattr('backend_client.time.sleep', lambda _: None)
    for name in ('QUEUED_AT', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        monkeypatch.delenv(name, raising=False)
    return value

def matchup():
    return {'vod_id': '123', 'chunk_id': 'abc', 'timestamp': 14, 'username': 'Opponent',
            'confidence': .95, 'igd': 9, 'frame_base64': base64.b64encode(b'jpeg').decode()}

def test_lost_insert_response_reuses_id(client):
    records = []
    def request(path, method, data, chunk, **kwargs):
        if method == 'PUT':
            return {'storage_path': '/detections/123/abc/claim-token/detection_14.jpg'}
        records.append(data['detections'])
        if len(records) == 1:
            raise TimeoutError('response lost')
        return {'published': 1}
    client._request.side_effect = request
    assert client.upload_batch([matchup()])
    assert records[0] == records[1]
    assert records[0][0]['igd'] == 9

def test_image_failure_never_publishes_detection(client):
    client._request.side_effect = RuntimeError('storage unavailable')
    with pytest.raises(RuntimeError, match='storage unavailable'):
        client.upload_batch([matchup()])
    assert all(call.args[1] == 'PUT' for call in client._request.call_args_list)

def test_missing_screenshot_is_not_published(client):
    item = matchup()
    del item['frame_base64']
    with pytest.raises(ValueError, match='screenshot'):
        client.upload_batch([item])
    client._request.assert_not_called()

def test_claim_token_is_kept_only_after_success(client):
    client._request.return_value = {'claimed': False, 'claim_token': None}
    assert not client.claim_chunk('new', expected_profile=PROFILE, expected_old_templates=False)
    assert 'new' not in client.claims
    client._request.return_value = {'claimed': True, 'claim_token': 'new-token'}
    assert client.claim_chunk('new', expected_profile=PROFILE, expected_old_templates=False)
    assert client.claims['new'] == 'new-token'


@pytest.mark.parametrize('old', [True, False])
def test_claim_carries_prepared_profile_template_and_dispatch_fences(client, monkeypatch, old):
    # Attest the actual parsed runtime values, even when ambient inputs differ.
    monkeypatch.setenv('OLD_TEMPLATES', str(not old).lower())
    monkeypatch.setenv('SFDE_PROFILE', '{"id":999}')
    monkeypatch.setenv('QUEUED_AT', '2026-09-07T00:00:00.000Z')
    client._request.return_value = {'claimed': True, 'claim_token': 'new-token'}
    assert client.claim_chunk('new', expected_profile=PROFILE, expected_old_templates=old)
    client._request.assert_called_once_with('chunks/new/claim', 'POST', {
        'queued_at': '2026-09-07T00:00:00.000Z', 'expected_profile': PROFILE,
        'expected_old_templates': old,
    })


@pytest.mark.parametrize('run_id,attempt,expected', [
    ('987654321', '2', {'github_run_id': 987654321, 'github_run_attempt': 2}),
    ('', '', {}),
    ('0', 'x', {}),
])
def test_claim_reports_the_github_run_that_owns_it(client, monkeypatch, run_id, attempt, expected):
    monkeypatch.setenv('GITHUB_RUN_ID', run_id)
    monkeypatch.setenv('GITHUB_RUN_ATTEMPT', attempt)
    client._request.return_value = {'claimed': True, 'claim_token': 'new-token'}
    assert client.claim_chunk('new', expected_profile=PROFILE, expected_old_templates=False)
    client._request.assert_called_once_with('chunks/new/claim', 'POST', {
        'queued_at': None, 'expected_profile': PROFILE, 'expected_old_templates': False, **expected,
    })


@pytest.mark.parametrize('profile', [None, '', [], {}, {'id': True}, {'id': 0}, {'id': '7'}])
def test_invalid_profile_never_sends_an_unfenced_claim(client, profile):
    with pytest.raises(ValueError, match='SFDE_PROFILE'):
        client.claim_chunk('new', expected_profile=profile, expected_old_templates=False)
    client._request.assert_not_called()
    assert 'new' not in client.claims


@pytest.mark.parametrize('old', [None, 'false', 'true', 0, 1])
def test_invalid_template_flag_never_sends_an_ambiguous_claim(client, old):
    with pytest.raises(ValueError, match='template selection'):
        client.claim_chunk('new', expected_profile=PROFILE, expected_old_templates=old)
    client._request.assert_not_called()


def test_missing_profile_or_template_cannot_fall_back_to_an_unfenced_claim(client):
    for kwargs in ({}, {'expected_profile': PROFILE}, {'expected_old_templates': False}):
        with pytest.raises(TypeError):
            client.claim_chunk('new', **kwargs)
    client._request.assert_not_called()


def test_stale_profile_rejection_never_saves_a_claim_token_or_retries_without_fences(client):
    client._request.side_effect = RuntimeError('Backend POST chunks/new/claim failed: HTTP 409')
    with pytest.raises(RuntimeError, match='HTTP 409'):
        client.claim_chunk('new', expected_profile=PROFILE, expected_old_templates=False)
    assert client._request.call_count == 1
    assert client._request.call_args.args[2]['expected_profile'] == PROFILE
    assert 'new' not in client.claims
