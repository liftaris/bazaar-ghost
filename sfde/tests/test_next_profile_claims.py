"""NEXT preparation/startup/claim independence from legacy saved profiles."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from backend_client import BackendClient
from sfde import SFDEProcessor


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('ENVIRONMENT', 'local')
    for name in ('QUEUED_AT', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        monkeypatch.delenv(name, raising=False)
    client = BackendClient.__new__(BackendClient)
    client.url = 'http://localhost:8787'
    client.claims = {}
    client._request = Mock(return_value={'claimed': True, 'claim_token': 'owned-token'})
    return client


def test_explicit_next_claim_has_no_profile_requirement_and_keeps_era_dispatch_and_identity(client, monkeypatch):
    monkeypatch.setenv('SFDE_PROFILE', 'not JSON')
    monkeypatch.setenv('QUEUED_AT', '2026-10-21T00:00:00.000Z')
    assert client.claim_chunk('chunk', processor_mode='next', expected_old_templates=False)
    client._request.assert_called_once_with('chunks/chunk/claim', 'POST', {
        'processor_mode': 'next', 'expected_old_templates': False, 'queued_at': '2026-10-21T00:00:00.000Z'})
    assert client.claims == {'chunk': 'owned-token'}


@pytest.mark.parametrize('profile', [None, {}, 'not JSON', {'id': 999, 'crop_region': [False]}])
def test_next_does_not_transmit_even_explicit_legacy_profile(client, profile):
    assert client.claim_chunk('chunk', processor_mode='next', expected_old_templates=True, expected_profile=profile)
    assert 'expected_profile' not in client._request.call_args.args[2]


@pytest.mark.parametrize('environment,url', [
    ('production', 'http://localhost:8787'), ('dev', 'http://localhost:8787'),
    ('validation', 'https://production.example'), ('local', 'https://production.example'),
])
def test_next_claim_cannot_target_production_or_another_backend(client, monkeypatch, environment, url):
    monkeypatch.setenv('ENVIRONMENT', environment)
    client.url = url
    with pytest.raises(ValueError, match='validation/local'):
        client.claim_chunk('chunk', processor_mode='next', expected_old_templates=False)
    client._request.assert_not_called()


@pytest.mark.parametrize('old', [None, 0, 'false'])
def test_next_still_requires_typed_template_expectation(client, old):
    with pytest.raises(ValueError, match='template selection'):
        client.claim_chunk('chunk', processor_mode='next', expected_old_templates=old)
    client._request.assert_not_called()


def test_unsuccessful_next_claim_never_saves_identity(client):
    client._request.return_value = {'claimed': False, 'claim_token': None}
    assert not client.claim_chunk('chunk', processor_mode='next', expected_old_templates=False)
    assert client.claims == {}


@pytest.fixture
def startup(monkeypatch):
    import sfde
    monkeypatch.setenv('ENVIRONMENT', 'local')
    monkeypatch.setenv('BAZAARGHOST_API_URL', 'http://localhost:8787')
    monkeypatch.setenv('SFDE_NEXT_ENABLED', 'true')
    monkeypatch.delenv('OTEL_EXPORTER_OTLP_ENDPOINT', raising=False)
    backend = Mock()
    backend.get_chunk_details.return_value = {'vod_id': '123', 'vod_pk': 1, 'start_seconds': 0, 'end_seconds': 100}
    backend.claim_chunk.return_value = True
    monkeypatch.setattr(sfde, 'BackendClient', Mock(return_value=backend))
    frame_factory = Mock(return_value=SimpleNamespace(reader=Mock()))
    monkeypatch.setattr(sfde, 'FrameProcessor', frame_factory)
    monkeypatch.setattr(sfde.signal, 'signal', lambda *_: None)
    monkeypatch.setattr(SFDEProcessor, '_init_next_pipeline', Mock())
    return backend, frame_factory


@pytest.mark.parametrize('ambient', [None, 'not JSON', 'null', '[1]', '{"custom_edge":"invalid"}'])
def test_next_startup_and_precrop_claim_do_not_parse_or_use_profiles(startup, monkeypatch, ambient):
    backend, frame_factory = startup
    if ambient is None:
        monkeypatch.delenv('SFDE_PROFILE', raising=False)
    else:
        monkeypatch.setenv('SFDE_PROFILE', ambient)
    parse = Mock(side_effect=AssertionError('NEXT must not parse profiles'))
    monkeypatch.setattr(SFDEProcessor, '_parse_sfde_profile', parse)
    processor = SFDEProcessor({'chunk_id': 'chunk', 'test_mode': True})
    assert processor.profile == {} and 'profile.name' not in processor.span_attributes
    assert frame_factory.call_args.kwargs['profile'] is None
    processor._compute_combined_crop = Mock(side_effect=AssertionError('NEXT must not use legacy crops'))
    processor.export_detection_summary = Mock()
    processor.cleanup = Mock()
    processor._run_workers = lambda _: setattr(processor, 'frames_processed', 1)
    result = processor.process_vod_chunk()
    assert result['status'] == 'completed'
    assert processor._combined_crop == [854, 480, 0, 0]
    assert processor._nameplate_slice is None and processor._igd_slice is None
    backend.claim_chunk.assert_called_once_with('chunk', expected_old_templates=False, processor_mode='next')
    parse.assert_not_called()


@pytest.mark.parametrize('ambient', [None, 'not JSON', '{}'])
def test_legacy_startup_still_requires_a_valid_profile(startup, monkeypatch, ambient):
    monkeypatch.setenv('SFDE_NEXT_ENABLED', 'false')
    if ambient is None:
        monkeypatch.delenv('SFDE_PROFILE', raising=False)
    else:
        monkeypatch.setenv('SFDE_PROFILE', ambient)
    with pytest.raises(ValueError, match='SFDE_PROFILE'):
        SFDEProcessor({'chunk_id': 'chunk', 'test_mode': True})


def test_production_next_startup_rejected_before_profile_or_backend(startup, monkeypatch):
    monkeypatch.setenv('ENVIRONMENT', 'production')
    monkeypatch.setenv('SFDE_PROFILE', 'not JSON')
    with pytest.raises(ValueError, match='validation/local'):
        SFDEProcessor({'chunk_id': 'chunk', 'test_mode': True})
    startup[0].get_chunk_details.assert_not_called()
