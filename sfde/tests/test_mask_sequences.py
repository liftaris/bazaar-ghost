"""Synthetic name-state/ownership contracts, NOT natural-footage or OCR accuracy.

Only name/locator observations and HTTP are fake. Exercise the packaged streaming
selector and upload serializer; no OCR models, backend, inference or media calls.
"""
from copy import deepcopy
import hashlib
import logging
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest

from backend_client import BackendClient
from encounter_pipeline import EncounterPipeline
from test_next_processor import LOCATION, image, name


RECORDINGS = [
    pytest.param('twitch:8866', '2549030240', id='twitch'),
    pytest.param('youtube:99224', '0C6bxQsDj-s', id='youtube'),
    pytest.param('bilibili:99223', 'BV1AHuC6nEGn:40830306653', id='bilibili'),
]


def observation(state, confidence=None, username=None):
    read = name(username, state, confidence)
    read.update(method='synthetic-name-state-contract',
                raw_text='******' if state == 'masked' else username or 'synthetic unreadable')
    return read


def replay(recording, vod_id, samples, reads, *, chunk, start, end):
    processor = SimpleNamespace(
        locate_full_frame=Mock(side_effect=[LOCATION if intro else None for _, _, intro in samples]),
        read_full_name=Mock(side_effect=reads),
    )
    pipeline = EncounterPipeline(processor, recording=recording, vod_id=vod_id,
                                 chunk_id=chunk, start_ms=start, end_ms=end)
    results = []
    for at_ms, jpeg, _ in samples:
        results.extend(pipeline.consume(jpeg, at_ms))
    results.extend(pipeline.flush())
    assert pipeline.flush() == []
    return results, processor


def assert_name_proof(event, pixels, at_ms, state, confidence, raw_text, method):
    assert event['name_state'] == state
    assert event['schema_version'] == 2
    proof = event['field_evidence']['username']
    assert proof['at_ms'] == at_ms
    assert proof['frame_sha256'] == hashlib.sha256(pixels[at_ms]).hexdigest()
    assert [proof['source_width'], proof['source_height']] == [64, 36]
    assert proof['region'] == LOCATION['name_region']
    assert proof['phase'] == 'intro'
    assert proof['confidence'] == confidence
    assert proof['method'] == method
    assert proof['raw_text'] == raw_text
    assert event['_images'][at_ms]['jpeg'] == pixels[at_ms]
    assert set(event['field_evidence']) == {'encounter', 'rank', 'username'}
    assert event['field_evidence']['encounter']['at_ms'] == at_ms
    assert event['field_evidence']['rank']['at_ms'] == event['anchor_ms']
    for field, evidence in event['field_evidence'].items():
        source_time = evidence['at_ms']
        assert evidence['frame_sha256'] == hashlib.sha256(pixels[source_time]).hexdigest()
        assert event['_images'][source_time]['jpeg'] == pixels[source_time]
        assert [evidence['source_width'], evidence['source_height']] == [64, 36]
        assert evidence['phase'] == 'intro'
        if field != 'username':
            assert evidence['confidence'] is None  # Locator similarities are not field confidence.
            assert evidence['region'] == LOCATION['rank_region']
    if state != 'complete':
        assert event['username'] is None and event['confidence'] is None
    # This test supplies no clock/hero observation. Do not invent their values/proofs.
    for field in ('igd', 'wins_remaining', 'lethal', 'ghost_hero', 'streamer_hero'):
        assert event[field] is None
        assert field not in event['field_evidence']


def publication(event, *, lose_first_response=False):
    """Actual serializer/retry path; fake PUT acknowledgments, never a public API."""
    client = BackendClient.__new__(BackendClient)
    client.logger = logging.getLogger(__name__)
    client.retry_attempts, client.quality, client.streamer = 2, '480p', 'synthetic-contract'
    uploads, posts = [], []

    def request(path, method, data, chunk, **kwargs):
        assert chunk == event['chunk_id']
        if method == 'PUT':
            query = parse_qs(urlsplit(path).query)
            at_ms = int(query['timestamp_ms'][0])
            assert data == event['_images'][at_ms]['jpeg']
            uploads.append(at_ms)
            return {'storage_path': f'/synthetic/{chunk}/{at_ms}-{query["kind"][0]}.jpg'}
        assert method == 'POST' and path == f'chunks/{chunk}/detections'
        posts.append(deepcopy(data))
        if lose_first_response and len(posts) == 1:
            raise TimeoutError('synthetic publication response lost')
        return {'published': 1}

    client._request = request
    assert client.upload_batch([event])
    assert uploads and posts
    if lose_first_response:
        assert len(posts) == 2 and posts[0] == posts[1]
    else:
        assert len(posts) == 1
    record = posts[-1]['detections'][0]
    assert record['id'] == event['id']
    assert record['name_state'] == event['name_state']
    assert record['username'] == event['username']
    assert record['confidence'] == event['confidence']
    proof = record['field_evidence']['username']
    assert proof['image_path'] == record['storage_path']
    assert proof['image_path'].startswith(f'/synthetic/{event["chunk_id"]}/')
    if record['name_state'] != 'complete':
        # A mask's evidence score/raw text must never become a canonical identity.
        assert record['username'] is None and record['confidence'] is None
    return record


@pytest.mark.parametrize('recording,vod_id', RECORDINGS)
@pytest.mark.parametrize('ocr_exception', [False, True], ids=['unreadable', 'ocr-exception'])
def test_observed_name_states_change_between_fights_without_sticky_mask(recording, vod_id, ocr_exception):
    states = ['complete', 'masked', 'unreadable', 'masked', 'complete']
    anchors = [0, 10000, 20000, 30000, 40000]
    reads = []
    samples = []
    for index, anchor in enumerate(anchors):
        # Three observations within one intro, then two genuinely clear samples.
        for offset in (0, 2000, 4000, 6000, 8000):
            samples.append((anchor + offset, image(32 + len(samples) * 3), offset < 6000))
        if states[index] == 'complete':
            reads.extend([observation('complete', .92, 'Weak.Read'),
                          observation('complete', .99, 'First.Name' if index == 0 else 'Recovered.Name'),
                          observation('complete', .94, 'Other.Read')])
        elif states[index] == 'masked':
            reads.extend([observation('masked', .94), observation('masked', .99), observation('masked', .96)])
        else:
            reads.extend([RuntimeError('synthetic OCR failure') if ocr_exception else observation('unreadable'),
                          observation('unreadable'), observation('unreadable')])
    pixels = {at: jpeg for at, jpeg, _ in samples}
    results, processor = replay(recording, vod_id, samples, reads, chunk='synthetic-sequence', start=0, end=50000)

    assert [e['name_state'] for e in results] == states
    assert [e['anchor_ms'] for e in results] == anchors
    assert len({e['id'] for e in results}) == 5
    assert processor.read_full_name.call_count == 15
    assert [e['username'] for e in results] == ['First.Name', None, None, None, 'Recovered.Name']
    for index, event in enumerate(results):
        assert event['recording_identity'] == recording and event['vod_id'] == vod_id
        assert event['timestamp'] == anchors[index] // 1000
        selected_at = anchors[index] if states[index] == 'unreadable' else anchors[index] + 2000
        raw = '******' if states[index] == 'masked' else event['username'] or 'synthetic unreadable'
        method = 'synthetic-name-state-contract'
        if states[index] == 'unreadable' and ocr_exception:
            raw, method = '', 'native-english-ocr-failed'
        confidence = None if states[index] == 'unreadable' else .99
        assert_name_proof(event, pixels, selected_at, states[index], confidence, raw, method)
        wire = publication(event)
        assert wire['field_evidence']['username']['at_ms'] == selected_at
    assert results[1]['id'] != results[3]['id']  # Identical masks, distinct fights.
    assert results[-1]['confidence'] == .99  # No recording-wide sticky mask flag.


@pytest.mark.parametrize('recording,vod_id', RECORDINGS)
def test_mask_intro_boundary_preroll_and_retry_keep_one_owned_identity(recording, vod_id, monkeypatch):
    monkeypatch.setattr('backend_client.time.sleep', lambda _: None)
    # Mask already visible on the FIRST preroll sample, spanning the 8s boundary.
    # It clears at 12/14s; the second masked fight begins independently at 16s.
    samples = [(at, image(40 + index * 4), at < 12000 or 16000 <= at <= 20000)
               for index, at in enumerate(range(0, 24000, 2000))]
    pixels = {at: jpeg for at, jpeg, _ in samples}
    first, _ = replay(recording, vod_id, samples[:4],
                      [observation('masked', q) for q in (.94, .99, .96, .95)],
                      chunk='synthetic-left', start=0, end=8000)
    second, processor = replay(recording, vod_id, samples,
                               [observation('masked', q) for q in (.94, .99, .96)],
                               chunk='synthetic-right', start=8000, end=24000)

    assert [e['anchor_ms'] for e in first + second] == [0, 16000]
    assert first[0]['id'] != second[0]['id']
    assert processor.read_full_name.call_count == 3  # Never reads/publishes the preroll-owned intro.
    for events, start, end, selected_at in [(first, 0, 8000, 2000), (second, 8000, 24000, 18000)]:
        assert len(events) == 1
        event = events[0]
        assert_name_proof(event, pixels, selected_at, 'masked', .99, '******', 'synthetic-name-state-contract')
        assert all(start <= at < end for at in event['_images'])
        assert all(start <= proof['at_ms'] < end for proof in event['field_evidence'].values())
        wire = publication(event, lose_first_response=True)
        assert wire['timestamp'] == event['anchor_ms'] // 1000
        assert wire['field_evidence']['username']['confidence'] == .99

    # Fresh ownership ID and a later/better selected name-state frame cannot change
    # encounter identity. A conflicting ordinary read cannot uncover a masked name.
    retry, _ = replay(recording, vod_id, samples[:4],
                      [observation('complete', .99, 'SpuriousName'), observation('masked', .94),
                       observation('masked', .99), observation('masked', .96)],
                      chunk='synthetic-fresh-ownership', start=0, end=8000)
    assert len(retry) == 1
    assert retry[0]['id'] == first[0]['id'] and retry[0]['anchor_ms'] == first[0]['anchor_ms'] == 0
    assert_name_proof(retry[0], pixels, 4000, 'masked', .99, '******', 'synthetic-name-state-contract')
    original_wire, retry_wire = publication(first[0]), publication(retry[0], lose_first_response=True)
    assert original_wire['id'] == retry_wire['id']
    assert original_wire['storage_path'] != retry_wire['storage_path']
    assert original_wire['field_evidence']['username']['at_ms'] == 2000
    assert retry_wire['field_evidence']['username']['at_ms'] == 4000
    # Changed proof/fresh ownership is a replacement body, NOT an exact-body retry.
    assert original_wire != retry_wire
