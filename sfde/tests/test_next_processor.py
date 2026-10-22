"""Next SFDE selection/transport regressions. No live AI or backend calls."""
import base64
from copy import deepcopy
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import subprocess
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from backend_client import BackendClient
from encounter_pipeline import EncounterPipeline, EncounterEnricher, detection_id, parse_hero, HEROES
from name_reader import NameReader
from run_context import ObservedRun, PlayerState
from sfde import SFDEProcessor, next_enabled
from ui_locator import UILocator


ROOT = Path(__file__).parent / 'fixtures' / 'encounters'
MANIFEST = json.loads((ROOT / 'manifest.json').read_text())
RECORDS = {r['id']: r for r in MANIFEST['records']}
LOCATION = {'rank': 'silver', 'rank_region': [40, 22, 5, 8], 'score': .8,
            'name_region': [45, 24, 14, 6], 'complete': True, 'name_state': 'unreadable',
            'method': 'spatial-masked-rank-480+verified-right-edge'}


def image(value=32):
    y,x = np.indices((36,64))
    texture = np.clip(value+np.where((x//4+y//4)%2,24,-24),0,255).astype(np.uint8)
    return cv2.imencode('.jpg', np.repeat(texture[:,:,None],3,axis=2))[1].tobytes()


def name(text=None, state='unreadable', confidence=None):
    return {'username': text, 'name_state': state, 'confidence': confidence, 'raw_text': text or '', 'method': 'test-native'}


def clock(day=8, wins=0, lethal=False, visible=True, **extra):
    return {'visible': visible, 'igd': day, 'wins_remaining': wins, 'lethal': lethal,
            'phase': 'pre_fight',
            'clock_region': [4, 9, 14, 19], 'evidence': {
                field: {'region': [6, 10, 6, 5], 'confidence': None, 'method': 'test-local-clock'}
                for field in ('igd', 'wins_remaining', 'lethal')}, **extra}


def pipeline(locations, reads=None, clocks=None, start=0, end=120000):
    processor = SimpleNamespace(locate_full_frame=Mock(side_effect=locations),
                                read_full_name=Mock(side_effect=reads or [name()] * 4))
    reader = SimpleNamespace(observe=Mock(side_effect=clocks)) if clocks is not None else None
    return EncounterPipeline(processor, recording='twitch:recording', vod_id='vod', chunk_id='chunk',
                             start_ms=start, end_ms=end, clock=reader)


def event(day=8, at_ms=0, segment='chunk:1', supported=True):
    p = pipeline([LOCATION], [name()])
    p.consume(image(), at_ms)
    result = p.flush()[0]
    result.update(igd=day, _continuity_segment=segment, _continuity_supported=supported)
    # Unit transport fixture supplies an explicitly reviewed synthetic hero frame
    # and day proof; real replay below never overrides selector/phase/continuity.
    result['_hero_ms'] = at_ms
    if type(day) is int:
        result['field_evidence']['igd'] = p._evidence(result['_images'][at_ms],[4,9,14,19],
            'test-supported-day','pre_fight','unit_fixture')
    return result


def response(role, hero='stelle', **extra):
    return {'status': 'ok', 'model': 'test-fixed-model', 'prompt_version': 'test-v1',
            'result': {'hero': hero, 'confidence': .99, 'reliable': True,
                       'probabilities': {h:(.99 if h==hero else .01/7) for h in HEROES}, **extra}}


@pytest.mark.parametrize('flag,environment,url,expected', [
    (None, 'production', 'https://production.example', False),
    ('TRUE', 'validation', 'https://bazaarghost-validation.kaio-8df.workers.dev', False),
    ('true', 'validation', 'https://bazaarghost-validation.kaio-8df.workers.dev', True),
    ('true', 'local', 'http://127.0.0.1:8787', True),
])
def test_explicit_opt_in_and_target_fences(monkeypatch, flag, environment, url, expected):
    monkeypatch.setenv('SFDE_NEXT_ENABLED', flag or '')
    monkeypatch.setenv('ENVIRONMENT', environment)
    monkeypatch.setenv('BAZAARGHOST_API_URL', url)
    assert next_enabled() is expected


@pytest.mark.parametrize('environment,url', [
    ('production', 'http://localhost:8787'), ('validation', 'https://production.example'),
    ('local', 'https://bazaarghost-validation.kaio-8df.workers.dev.evil.example'),
    ('validation', 'http://bazaarghost-validation.kaio-8df.workers.dev'),
])
def test_opt_in_cannot_enable_production(monkeypatch, environment, url):
    monkeypatch.setenv('SFDE_NEXT_ENABLED', 'true')
    monkeypatch.setenv('ENVIRONMENT', environment)
    monkeypatch.setenv('BAZAARGHOST_API_URL', url)
    with pytest.raises(ValueError, match='validation/local'):
        next_enabled()


def test_neighbor_selection_keeps_anchor_rank_and_name_independent():
    stronger_rank = dict(LOCATION, rank='gold', score=.95)
    p = pipeline([LOCATION, stronger_rank, LOCATION],
                 [name(), name('weak', 'complete', .91), name('Best.Name', 'complete', .99)])
    for at_ms in (1250, 3250, 5250):
        assert p.consume(image(at_ms//1000), at_ms) == []
    result = p.flush()[0]
    assert result['timestamp'] == 1 and result['anchor_ms'] == 1250
    assert result['id'] == detection_id('twitch:recording', 1250)
    assert result['username'] == 'Best.Name'
    assert result['detected_rank'] == 'gold'
    assert {f: e['at_ms'] for f, e in result['field_evidence'].items()} == {
        'encounter': 5250, 'rank': 3250, 'username': 5250}
    assert result['_intro_ms'] == 5250
    for field in result['field_evidence'].values():
        source = result['_images'][field['at_ms']]
        assert field['frame_sha256'] == hashlib.sha256(source['jpeg']).hexdigest()
        assert [field['source_width'], field['source_height']] == [64, 36]
    assert p.flush() == []


@pytest.mark.parametrize('reads,expected,score', [
    ([name('MiXeD.', 'obstructed', .21), name(None, 'obstructed', .99)], 'MiXeD.', .21),
    ([name(None, 'partial', .99), name('Two\nparts!', 'obstructed', .31)], 'Two\nparts!', .31),
    ([name('fragment', 'obstructed', .99), name('Whole.Name', 'complete', .51)], 'Whole.Name', .51),
])
def test_pipeline_keeps_observed_names_and_their_source_when_neighbors_are_empty(reads, expected, score):
    p = pipeline([LOCATION] * len(reads), reads)
    for index in range(len(reads)):
        p.consume(image(), index * 2000)
    result = p.flush()[0]
    assert result['username'] == expected and result['confidence'] == score
    source_index = next(i for i, read in enumerate(reads) if read['username'] == expected)
    proof = result['field_evidence']['username']
    assert proof['at_ms'] == source_index * 2000 and proof['raw_text'] == expected
    assert result['name_state'] == reads[source_index]['name_state']


def test_intro_read_window_is_bounded_and_does_not_lock_on_weak_first_read():
    p = pipeline([LOCATION] * 20, [name('weak', 'complete', .91), name('better', 'complete', .99), name(), name()])
    result = []
    for at_ms in range(0, 40000, 2000):
        result += p.consume(image(), at_ms)
    assert p.processor.read_full_name.call_count == 4
    # No second encounter just because the same intro stays visible for 40s.
    assert p.flush() == []
    assert len(result) == 1 and result[0]['username'] == 'better'


def test_oversized_observed_name_keeps_original_locally_and_explicit_wire_excerpt():
    text = '😀' * 90
    raw = json.dumps({'native': [[text, .3]], 'mask': [['x' * 1200, .1]]}, ensure_ascii=False)
    read = dict(name(text, 'obstructed', .3), raw_text=raw)
    p = pipeline([LOCATION], [read])
    p.consume(image(), 0)
    result = p.flush()[0]
    assert result['username'] == '😀' * 64 and result['name_state'] == 'obstructed'
    assert result['_name_observation']['username'] == text
    assert result['_name_observation']['raw_text'] == raw
    evidence = result['field_evidence']['username']['raw_text']
    assert len(evidence.encode('utf-16-le')) // 2 <= 1024
    excerpt = json.loads(evidence)
    assert excerpt['truncated'] and excerpt['sha256'] == hashlib.sha256(raw.encode()).hexdigest()


@pytest.mark.parametrize('state', ['masked', 'partial', 'obstructed', 'unreadable'])
def test_unknown_names_are_real_encounters(state):
    p = pipeline([LOCATION], [name(None, state)])
    p.consume(image(), 0)
    result = p.flush()[0]
    assert result['username'] is None and result['name_state'] == state
    assert result['confidence'] is None and result['schema_version'] == 2


def test_same_opponent_after_clear_scene_is_a_separate_encounter():
    p = pipeline([LOCATION, None, None, LOCATION], [name('same', 'complete', .99)]*2)
    result = []
    for at_ms in range(0, 8000, 2000):
        result += p.consume(image(), at_ms)
    result += p.flush()
    assert [r['anchor_ms'] for r in result] == [0, 6000]
    assert len({r['id'] for r in result}) == 2


def test_single_locator_fade_miss_does_not_duplicate_encounter():
    p = pipeline([LOCATION, None, LOCATION])
    result = []
    for at_ms in (0, 2000, 4000):
        result += p.consume(image(), at_ms)
    result += p.flush()
    assert len(result) == 1


def test_preroll_owns_intro_and_retry_identity_ignores_chunk_or_best_frame():
    p = pipeline([LOCATION, LOCATION, LOCATION, None, None, LOCATION], start=4000)
    result = []
    for at_ms in range(0, 12000, 2000):
        result += p.consume(image(), at_ms)
    result += p.flush()
    assert [r['anchor_ms'] for r in result] == [10000]
    again = pipeline([LOCATION], start=4000)
    again.chunk_id = 'retry-other-chunk'
    again.consume(image(), 10000)
    assert again.flush()[0]['id'] == result[0]['id']


def test_clock_keeps_first_readable_evidence_and_zero_false():
    p = pipeline([LOCATION, None, None, None], clocks=[clock(visible=False), clock(), clock(), clock()])
    for at_ms in (1250, 3250, 5250, 7250):
        p.consume(image(), at_ms)
    result = p.flush()[0]
    assert result['igd'] == 8 and result['wins_remaining'] == 0 and result['lethal'] is False
    assert result['field_evidence']['username']['at_ms'] == 1250
    for field in ('igd', 'wins_remaining', 'lethal'):
        evidence = result['field_evidence'][field]
        assert evidence['at_ms'] == 3250 and evidence['phase'] == 'pre_fight'
    assert result['_images'][3250]['kind'] == 'clock'


def test_one_clock_field_failure_cannot_erase_other_fields():
    p = pipeline([LOCATION, None, None, None], clocks=[clock(visible=False)] + [clock(day=None)]*3)
    for at_ms in range(0, 8000, 2000):
        p.consume(image(), at_ms)
    result = p.flush()[0]
    assert result['igd'] is None
    assert result['wins_remaining'] == 0 and result['lethal'] is False
    assert result['_clock_fallback_ms'] == 6000


def test_later_counter_change_does_not_replace_first_reading():
    readings = [clock(visible=False),clock(wins=1),clock(wins=0),clock(wins=0),clock(wins=0)]
    p = pipeline([LOCATION]+[None]*4,clocks=readings)
    for index in range(5):
        p.consume(image(),index*2000)
    result = p.flush()[0]
    assert result['wins_remaining'] == 1 and result['igd'] == 8
    assert result['field_evidence']['wins_remaining']['at_ms'] == 2000
    assert '_clock_fallback_ms' not in result


def test_real_reader_without_phase_accepts_single_combat_clock_reading():
    # ClockReader's real interface has no phase; readable combat values count.
    observation = clock()
    observation.pop('phase')
    p = pipeline([LOCATION, None], clocks=[clock(visible=False), observation])
    for at_ms in (0, 2000):
        p.consume(image(),at_ms)
    result = p.flush()[0]
    assert (result['igd'], result['wins_remaining'], result['lethal']) == (8, 0, False)
    assert '_clock_fallback_ms' not in result
    assert result['field_evidence']['wins_remaining']['phase'] == 'unknown'
    assert result['field_evidence']['igd']['at_ms'] == 2000


def test_combat_clock_can_fill_a_field_missing_from_pre_intro_evidence():
    before = clock(day=None, wins=4, phase=None)
    after = clock(day=8, wins=4, phase=None)
    p = pipeline([None, None, LOCATION, None],
                 clocks=[before, before, clock(visible=False), after])
    for at_ms in (0, 2000, 4000, 6000):
        p.consume(image(), at_ms)
    result = p.flush()[0]
    assert result['igd'] == 8 and result['wins_remaining'] == 4
    assert result['field_evidence']['igd']['at_ms'] == 6000
    assert result['field_evidence']['wins_remaining']['at_ms'] == 2000


def test_owned_pre_intro_context_proves_clock_phase_at_its_true_time():
    p = pipeline([None,None,None,LOCATION],clocks=[clock(phase=None)]*3+[clock(visible=False)])
    for at_ms in (0,2000,4000,6000):
        p.consume(image(),at_ms)
    result = p.flush()[0]
    assert result['timestamp'] == 6 and result['igd'] == 8
    assert result['wins_remaining'] == 0 and result['lethal'] is False
    evidence = result['field_evidence']['igd']
    assert evidence['at_ms'] == 4000 and evidence['phase'] == 'pre_fight'
    assert [s['at_ms'] for s in evidence['samples']] == [0,2000,4000,6000]
    assert result['field_evidence']['encounter']['at_ms'] == 6000


def test_preroll_clock_context_cannot_publish_out_of_chunk_samples():
    p = pipeline([None,None,None,LOCATION],start=6000,
                 clocks=[clock(phase=None)]*3+[clock(visible=False)])
    for at_ms in (0,2000,4000,6000):
        p.consume(image(),at_ms)
    result = p.flush()[0]
    assert result['igd'] is None and all(t >= 6000 for t in result['_images'])


def test_local_day_unknown_can_fallback_on_proven_owned_pre_intro_full_clock():
    p = pipeline([None,None,None,LOCATION],
                 clocks=[clock(day=None,phase=None)]*3+[clock(visible=False)])
    for at_ms in (0,2000,4000,6000):
        p.consume(image(),at_ms)
    result = p.flush()[0]
    backend = Mock()
    backend.infer.side_effect = lambda _,**kwargs: ({'status':'completed','result':{
        'truncated':False,'answers':{'day':{'type':'number','value':1}}}}
        if kwargs['task'] == 'clock_day' else response(kwargs['task']))
    EncounterEnricher(backend).enrich(result)
    assert result['igd'] == 1 and result['field_evidence']['igd']['at_ms'] == 4000
    day_calls = [c for c in backend.infer.call_args_list if c.kwargs['task'] == 'clock_day']
    assert len(day_calls) == 1 and day_calls[0].kwargs['at_ms'] == 4000


def test_long_clock_window_has_bounded_jpeg_storage_and_never_corrects_days():
    p = pipeline([LOCATION]+[None]*30,clocks=[clock(visible=False)]+[clock(day=None)]*30)
    output = []
    for index in range(31):
        output += p.consume(image(),index*1000)
        if p.active:
            assert len(p.active['_images']) <= 15
    output += p.flush()
    assert len(output) == 1 and output[0]['igd'] is None


def test_invalid_or_oversized_sample_fails_without_inventing_evidence():
    p = pipeline([LOCATION])
    with pytest.raises(ValueError,match='decode'):
        p.consume(b'not jpeg',0)
    with pytest.raises(ValueError,match='bounds'):
        p.consume(b'x'*(2*1024*1024+1),0)
    p.consume(image(),1250)
    with pytest.raises(ValueError,match='advance'):
        p.consume(image(),1250)


@pytest.mark.parametrize('observations', [
    [clock(visible=False)]*6 + [clock(), clock(), clock()],
    [clock(visible=False), clock(phase='post_fight'), clock(), clock(), clock()],
])
def test_missing_late_and_post_result_clocks_never_fill_fields(observations):
    p = pipeline([LOCATION] + [None]*(len(observations)-1), clocks=observations)
    for index in range(len(observations)):
        p.consume(image(), index*2000)
    result = p.flush()[0]
    assert all(result[field] is None for field in ('igd', 'wins_remaining', 'lethal'))
    assert '_clock_fallback_ms' not in result


def test_local_name_and_clock_failure_do_not_drop_encounter():
    p = pipeline([LOCATION, None], [RuntimeError('ocr failed')], [RuntimeError('clock failed')]*2)
    p.consume(image(), 0)
    p.consume(image(), 2000)
    result = p.flush()[0]
    assert result['username'] is None and result['igd'] is None


@pytest.mark.parametrize('raw,mask,state,username', [
    ([('normal.', .99)], [], 'complete', 'normal.'),
    ([('ab***cd', .99)], [], 'obstructed', 'ab***cd'),
    ([('kokkkkk', .65)], [('******', .99)], 'masked', None),
    ([], [('******', .89)], 'obstructed', None),
    ([('partial', .65)], [], 'complete', 'partial'),
    ([('low', .25)], [], 'obstructed', 'low'),
    ([('two', .99), ('fragments', .99)], [], 'obstructed', 'two\nfragments'),
    ([('ab cd', .99)], [], 'obstructed', 'ab cd'),
])
def test_name_whole_tokens_mask_before_cleanup(monkeypatch, raw, mask, state, username):
    monkeypatch.setattr('name_reader.tokens', Mock(side_effect=[raw, mask]))
    read = NameReader(Mock()).read(np.zeros((36, 64, 3), np.uint8), LOCATION)
    assert (read['name_state'], read['username']) == (state, username)
    assert json.loads(read['raw_text']) == {'native': [list(r) for r in raw], 'mask': [list(r) for r in mask],
                                          'regions': read['ocr_regions']}


@pytest.mark.parametrize('state', ['partial', 'obstructed'])
def test_incomplete_name_runs_ocr_and_retains_observed_fragment(state):
    reader = Mock()
    reader.predict.side_effect = [[{'rec_texts': ['MiXeD.'], 'rec_scores': [.31]}], []]
    read = NameReader(reader).read(np.zeros((36, 64, 3), np.uint8), dict(LOCATION, complete=False, name_state=state))
    assert read['username'] == 'MiXeD.' and read['name_state'] == 'obstructed'
    assert read['confidence'] == .31
    assert reader.predict.call_count == 2


def test_inference_hero_halves_full_height_bounded_no_upscale_and_unknown_name():
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: response(kwargs['task'])
    enrich = EncounterEnricher(backend)
    result = event()
    enrich.enrich(result)
    assert result['username'] is None and result['ghost_hero'] == 'stelle'
    assert [c.kwargs['task'] for c in backend.infer.call_args_list] == ['ghost_hero', 'streamer_hero']
    for call in backend.infer.call_args_list:
        encoded = base64.b64decode(call.kwargs['image_base64'])
        assert encoded.startswith(b'\x89PNG')
        pixels = cv2.imdecode(np.frombuffer(encoded, np.uint8), 1)
        assert pixels.shape[:2] == (36, 32)
    source = dict(next(iter(result['_images'].values())), jpeg=cv2.imencode('.jpg', np.zeros((1080, 1920, 3), np.uint8))[1].tobytes())
    png = enrich._png(source, [960, 0, 960, 1080])
    assert cv2.imdecode(np.frombuffer(base64.b64decode(png), np.uint8), 1).shape[:2] == (640, 569)


@pytest.mark.parametrize('value', [None, [], {}, {'status':'ok','result':{'hero':[]}},
    {'status':'unknown','result':{'hero':'stelle','confidence':1}},
    {'status':'ok','result':{'hero':'karnok','confidence':.99,'reliable':False}},
    {'status':'ok','result':{'hero':'stelle','confidence':.99,'probabilities':[]}},
])
def test_unknown_model_results_are_safe(value):
    assert parse_hero(value, 'ghost_hero') == (None, None)


def test_streamer_reliability_and_probabilities_guard():
    assert parse_hero(response('streamer_hero', reliable=None), 'streamer_hero') == (None, None)
    probabilities = {hero: (.99 if hero == 'stelle' else .01/7) for hero in HEROES}
    assert parse_hero(response('streamer_hero', probabilities=probabilities), 'streamer_hero') == ('stelle', .99)
    probabilities['mak'], probabilities['stelle'] = .48, .51
    assert parse_hero(response('streamer_hero', probabilities=probabilities), 'streamer_hero') == (None, None)


def test_optional_api_failures_keep_all_local_fields_and_do_not_retry():
    backend = Mock()
    backend.infer.side_effect = TimeoutError('uncertain response')
    enrich = EncounterEnricher(backend)
    result = event()
    enrich.enrich(result)
    assert backend.infer.call_count == 2 and result['_paid_attempts'] == 2
    assert result['igd'] == 8 and result['ghost_hero'] is None and result['streamer_hero'] is None
    assert result['field_evidence']['ghost_hero']['raw_text'] == 'null'


def test_chunk_client_cap_counts_failures_and_is_independent_of_server():
    backend = Mock()
    backend.infer.side_effect = RuntimeError('failed')
    enrich = EncounterEnricher(backend)
    for index in range(40):
        enrich.enrich(event(at_ms=index*1000))
    assert backend.infer.call_count == enrich.attempts == 64


def test_backend_infer_is_one_submission_and_has_its_own_cap():
    client = BackendClient.__new__(BackendClient)
    client._request = Mock(side_effect=TimeoutError('uncertain'))
    for _ in range(64):
        with pytest.raises(TimeoutError):
            client.infer('chunk', request_id='same', task='ghost_hero', at_ms=1250, image_base64='png')
    with pytest.raises(ValueError, match='limit'):
        client.infer('chunk', request_id='same', task='ghost_hero', at_ms=1250, image_base64='png')
    assert client._request.call_count == 64


@pytest.mark.parametrize('day,expected', [(1,1), (20,20), ('1',None), (True,None), (21,None), (1.0,None)])
def test_day_fallback_only_registered_full_clock_strict_integer(day, expected):
    p = pipeline([LOCATION, LOCATION, None, None, None], clocks=[clock(visible=False)]*2+[clock(day=None)]*3)
    for at_ms in range(0, 10000, 2000):
        p.consume(image(), at_ms)
    result = p.flush()[0]
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: ({'status':'ok', 'result': {'day':day}}
        if kwargs['task'] == 'clock_day' else response(kwargs['task']))
    EncounterEnricher(backend).enrich(result)
    assert result['igd'] == expected
    call = backend.infer.call_args_list[0]
    assert call.kwargs['task'] == 'clock_day' and call.kwargs['at_ms'] == 8000
    pixels = cv2.imdecode(np.frombuffer(base64.b64decode(call.kwargs['image_base64']), np.uint8), 1)
    assert pixels.shape[:2] == (19,14)
    assert result['_paid_attempts'] == 3


def test_both_heroes_are_rechecked_with_each_fights_own_evidence():
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: response(kwargs['task'])
    enrich = EncounterEnricher(backend)
    first, second, third = event(8, 0), event(9, 20000), event(10, 40000)
    enrich.enrich(first)
    first['field_evidence']['streamer_hero']['image_path'] = '/original-intro.jpg'
    enrich.enrich(second)
    enrich.enrich(third)
    assert [c.kwargs['task'] for c in backend.infer.call_args_list] == ['ghost_hero','streamer_hero'] * 3
    evidence = third['field_evidence']['streamer_hero']
    assert evidence['at_ms'] == 40000 and 'image_path' not in evidence
    assert 'inherited_from' not in evidence


@pytest.mark.parametrize('day,segment,supported', [(8,'chunk:1',True), (1,'chunk:1',True),
    (None,'chunk:1',True), (9,'chunk:2',True), (9,'otherchunk:1',True), (9,'chunk:1',False)])
def test_both_hero_calls_are_independent_of_day_and_chunk(day, segment, supported):
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: response(kwargs['task'])
    enrich = EncounterEnricher(backend)
    enrich.enrich(event())
    second = event(day, 20000, segment, supported)
    enrich.enrich(second)
    assert [c.kwargs['task'] for c in backend.infer.call_args_list] == ['ghost_hero','streamer_hero'] * 2
    assert second['field_evidence']['streamer_hero']['at_ms'] == 20000
    assert 'inherited_from' not in second['field_evidence']['streamer_hero']


def test_new_payload_uploads_every_source_before_publish_even_unknown_name():
    result = event()
    result['igd'] = None
    client = BackendClient.__new__(BackendClient)
    client.logger = logging.getLogger('test')
    client.retry_attempts, client.quality, client.streamer = 2, '480p', 'test'
    calls = []
    def request(path, method, data, chunk, **kwargs):
        calls.append((path, method, data))
        if method == 'PUT':
            return {'storage_path':'/intro-0.jpg'}
        assert all(e['image_path'] == '/intro-0.jpg' for e in data['detections'][0]['field_evidence'].values())
        return {'published':1}
    client._request = request
    assert client.upload_batch([result])
    assert [c[1] for c in calls] == ['PUT','POST']
    assert 'timestamp_ms=0&kind=intro' in calls[0][0]
    record = calls[1][2]['detections'][0]
    assert record['schema_version'] == 2 and record['username'] is None and record['confidence'] is None
    assert record['id'] == result['id'] and record['storage_path'] == '/intro-0.jpg'


def test_new_retry_uploads_ms_sources_and_preserves_exact_payload_identity(monkeypatch):
    better = dict(LOCATION,score=.95,rank='gold')
    p = pipeline([LOCATION,better,LOCATION,None,None,None],
                 [name(),name('weak','complete',.91),name('Best.Name','complete',.99)],
                 [clock(visible=False)]*3+[clock()]*3)
    for at_ms in range(0,12000,2000):
        p.consume(image(),at_ms)
    result = p.flush()[0]
    client = BackendClient.__new__(BackendClient)
    client.logger = logging.getLogger('test')
    client.retry_attempts,client.quality,client.streamer = 2,'480p','test'
    posts,uploads = [],[]
    def request(path,method,data,chunk,**kwargs):
        if method == 'PUT':
            uploads.append(path)
            return {'storage_path':'/detections/'+path.split('?')[1]+'.jpg'}
        posts.append(deepcopy(data))
        if len(posts) == 1:
            raise TimeoutError('publication succeeded, response lost')
        return {'published':1}
    client._request = request
    monkeypatch.setattr('backend_client.time.sleep',lambda _:None)
    assert client.upload_batch([result])
    assert posts[0] == posts[1]
    record = posts[1]['detections'][0]
    assert record['timestamp'] == 0 and record['username'] == 'Best.Name'
    assert 'timestamp_ms=4000&kind=intro' in record['storage_path']
    assert record['field_evidence']['encounter']['image_path'] == record['storage_path']
    assert 'timestamp_ms=2000&kind=intro' in record['field_evidence']['rank']['image_path']
    assert 'timestamp_ms=6000&kind=clock' in record['field_evidence']['igd']['image_path']
    assert uploads[:len(uploads)//2] == uploads[len(uploads)//2:]


def test_new_required_clock_upload_failure_never_publishes(monkeypatch):
    p = pipeline([LOCATION,None,None,None],clocks=[clock(visible=False)]+[clock()]*3)
    for at_ms in range(0,8000,2000):
        p.consume(image(),at_ms)
    result = p.flush()[0]
    client = BackendClient.__new__(BackendClient)
    client.logger = logging.getLogger('test')
    client.retry_attempts,client.quality,client.streamer = 2,'480p','test'
    calls = []
    def request(path,method,data,chunk,**kwargs):
        calls.append(method)
        if 'kind=clock' in path:
            raise RuntimeError('required clock image unavailable')
        return {'storage_path':'/intro.jpg'}
    client._request = request
    monkeypatch.setattr('backend_client.time.sleep',lambda _:None)
    with pytest.raises(RuntimeError,match='required clock'):
        client.upload_batch([result])
    assert 'POST' not in calls and result['igd'] == 8


def test_encounter_attempt_limit_cannot_be_exceeded():
    backend = Mock()
    result = event()
    result['_paid_attempts'] = 4
    EncounterEnricher(backend).enrich(result)
    backend.infer.assert_not_called()
    assert result['username'] is None and result['igd'] == 8


@pytest.fixture(scope='module')
def locator():
    return UILocator()


@pytest.mark.parametrize('key', list(RECORDS))
def test_frozen_native_fullframe_locator_regressions(locator, key):
    record = RECORDS[key]
    data = (ROOT / record['file']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == record['sha256']
    frame = cv2.imdecode(np.frombuffer(data, np.uint8), 1)
    assert [frame.shape[1],frame.shape[0]] == record['dimensions']
    found = locator.locate(frame)
    if record['labels']['expectedScene'] == 'not_intro':
        assert found is None
    elif key == 'boundaryA-03402':
        assert found is None  # Frozen transition abstention, later frames retain encounter.
    else:
        assert found is not None
        if 'right-edge-matcher-abstention-not-obstruction' in record['tags'] or key == 'boundaryA-03408':
            # The fallback is uncertain, not evidence of a physical obstruction.
            assert not found['complete'] and found['name_state'] == 'obstructed'
            assert found['name_region'] is not None
        else:
            assert found['complete']


@pytest.mark.parametrize('boundary', MANIFEST['runBoundaries'], ids=lambda row: row['id'])
def test_real_same_stelle_reset_frames_force_fresh_streamer_check(locator, boundary):
    # Real negative frames go through CV; neither an unchanged hero nor a stale
    # run ID is fed into the detector. Sparse/gapped coverage itself invalidates.
    p = EncounterPipeline(SimpleNamespace(locate_full_frame=locator.locate, read_full_name=lambda *_:name()),
        recording='twitch:2549030240', vod_id='2549030240', chunk_id='chunk', start_ms=0, end_ms=7000000)
    old_epoch = p.continuity_epoch
    for key in boundary['evidenceIds']:
        record = RECORDS[key]
        p.consume((ROOT/record['file']).read_bytes(), round(record['source']['nominalSeconds']*1000))
    latest = p.flush()[0]
    assert p.continuity_epoch > old_epoch
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: response(kwargs['task'])
    enrich = EncounterEnricher(backend)
    enrich.enrich(event())
    enrich.enrich(latest)
    assert 'inherited_from' not in latest['field_evidence']['streamer_hero']
    assert [c.kwargs['task'] for c in backend.infer.call_args_list].count('streamer_hero') == 2


@pytest.fixture(scope='module')
def native_name_reader():
    from ocr_runtime import create_ocr_reader
    return NameReader(create_ocr_reader())


def test_real_mask_native_ocr_shared_factory_not_searchable(locator, native_name_reader):
    # Uses cached models in the existing bg120 image, never a paid API.
    frame = cv2.imread(str(ROOT / RECORDS['mask-00006']['file']))
    read = native_name_reader.read(frame, locator.locate(frame))
    assert read['name_state'] == 'masked' and read['username'] is None
    assert '******' in read['raw_text'] and 'native' in read['raw_text']


@pytest.mark.parametrize('seconds,expected', [(314,'sakura.'),(492,'CapMoura'),(772,'wsd1050458961'),
    (978,'Promotoa'),(1140,'Zaror'),(1486,'baolei')])
def test_native_ordinary_name_controls_unchanged_no_false_masks(native_name_reader, seconds, expected):
    frame = cv2.imread(str(Path(__file__).parent/'fixtures'/'frames'/f'217270_{seconds}.jpg'))
    h,w = frame.shape[:2]
    trim = int(h*.24)
    # These legacy crops have reviewed nameplate truth, not full-frame locator
    # credit. Preserve the existing normal path's vertical crop, no binary input.
    location = dict(LOCATION, name_region=[0,trim,w,h-2*trim])
    read = native_name_reader.read(frame, location)
    assert (read['name_state'],read['username']) == ('complete',expected)


def test_real_fade_neighbor_window_retains_first_accepted_anchor(locator):
    p = EncounterPipeline(SimpleNamespace(locate_full_frame=locator.locate, read_full_name=lambda *_:name()),
        recording='twitch:2549030240',vod_id='2549030240',chunk_id='chunk',start_ms=3400000,end_ms=3500000)
    result = []
    for key in ('boundaryA-03402','twitch-2549030240-3406','boundaryA-03408'):
        record = RECORDS[key]
        result += p.consume((ROOT/record['file']).read_bytes(),round(record['source']['nominalSeconds']*1000))
    result += p.flush()
    assert len(result) == 1
    assert result[0]['anchor_ms'] == 3406000
    assert result[0]['username'] is None


@pytest.fixture
def next_processor(monkeypatch):
    import sfde
    monkeypatch.setenv('SFDE_NEXT_ENABLED', 'true')
    monkeypatch.setenv('ENVIRONMENT', 'local')
    monkeypatch.setenv('BAZAARGHOST_API_URL', 'http://localhost:8787')
    monkeypatch.setenv('SFDE_PROFILE', '{"id":7,"crop_region":[0.5,0.5,0.4,0.2]}')
    monkeypatch.delenv('OTEL_EXPORTER_OTLP_ENDPOINT', raising=False)
    db = Mock()
    db.get_chunk_details.return_value = {'vod_id':'123', 'vod_pk':123, 'start_seconds':0, 'end_seconds':300}
    db.claim_chunk.return_value = True
    monkeypatch.setattr(sfde, 'BackendClient', Mock(return_value=db))
    reader = SimpleNamespace(reader=Mock(), locate_full_frame=Mock(return_value=None),
                             read_full_name=Mock(return_value=name()), reset_state=Mock())
    monkeypatch.setattr(sfde, 'FrameProcessor', Mock(return_value=reader))
    monkeypatch.setattr(sfde.signal, 'signal', lambda *_: None)
    value = SFDEProcessor({'chunk_id':'chunk', 'test_mode':True})
    value.encounters.clock = None
    value.export_detection_summary = lambda: None
    return value


def test_bounded_next_queues_flush_and_paid_calls_only_on_results_thread(next_processor):
    p = next_processor
    assert p.frame_queue.maxsize == 4 and p.result_queue.maxsize == 2
    def decode():
        for at_ms in range(0, 40000, 2000):
            p._put(p.frame_queue, (image(), at_ms, True))
    p.ffmpeg_worker = decode
    p.frame_processor.locate_full_frame.side_effect = [LOCATION, LOCATION] + [None]*8 + [LOCATION,LOCATION] + [None]*8
    threads = []
    def infer(_, **kwargs):
        threads.append(threading.current_thread().name)
        return response(kwargs['task'])
    p.backend.infer.side_effect = infer
    result = p.process_vod_chunk()
    assert result['frames_processed'] == 20 and result['matchups_found'] == 2
    assert threads == ['results']*4
    assert len(p.all_detections) == 2 and p.backend.upload_batch.call_count == 2
    assert p.all_detections[0]['name_state'] == 'unreadable'
    assert all('field_evidence' in row and '_images' not in row for row in p.all_detections)
    assert not any(thread.is_alive() for thread in p.threads)


@pytest.mark.parametrize('start,end,rate,owned,preroll', [(0,7,.5,4,0), (5,9,.5,2,2), (8,12,.5,2,4), (5,9,2,8,10)])
def test_real_fullframe_decode_keeps_owned_and_preroll_coverage_separate(next_processor, monkeypatch, tmp_path,
        start, end, rate, owned, preroll):
    p = next_processor
    source = tmp_path/'source.mp4'
    subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i',
                    'color=red:s=160x90:r=10:d=12','-c:v','libx264',str(source)], check=True, timeout=30)
    monkeypatch.setenv('TEST_VIDEO', str(source))
    p.start_time, p.end_time = start, end
    p.config['processing']['frame_rate'] = rate
    p._init_next_pipeline()
    p.encounters.clock = None
    sizes = []
    p.frame_processor.locate_full_frame.side_effect = lambda frame: sizes.append(frame.shape[:2])
    result = p.process_vod_chunk()
    assert result['frames_processed'] == owned
    assert p.preroll_frames_processed == preroll
    assert result['decode_coverage']['sampled_frames'] == owned
    assert result['decode_coverage']['first_sample_seconds'] == start
    assert result['decode_coverage']['source_frame_interval_seconds'] == .1
    assert sizes == [(90,160)]*(owned+preroll)  # Not a crop or fabricated 854x480.
    if preroll:
        assert p.preroll_coverage['sampled_frames'] == preroll
        assert p.preroll_coverage['requested_end_seconds'] == start


def test_next_queue_fractional_sample_precision_and_clock_failure_flush(next_processor):
    p = next_processor
    p.frame_processor.locate_full_frame.side_effect = [LOCATION, LOCATION, None, None]
    p.encounters.clock = SimpleNamespace(observe=Mock(side_effect=ValueError('optional clock failure')))
    def decode():
        for at_ms in (1250,1750,2250,2750):
            p._put(p.frame_queue, (image(), at_ms, True))
    p.ffmpeg_worker = decode
    p.backend.infer.side_effect = RuntimeError('optional AI unavailable')
    result = p.process_vod_chunk()
    assert result['matchups_found'] == 1
    assert p.all_detections[0]['field_evidence']['encounter']['at_ms'] == 1250
    assert p.all_detections[0]['timestamp'] == 1
    assert p.all_detections[0]['igd'] is None


def test_next_retries_keep_paid_cap_and_replace_request_without_assuming_deletion(next_processor):
    p = next_processor
    previous_enricher = p.enricher
    p.enricher.attempts = 12
    p._reset_for_retry()
    assert p.enricher is previous_enricher and p.enricher.attempts == 12
    p.backend.delete_chunk_detections.assert_called_once_with('chunk')
    assert p.frames_processed == p.preroll_frames_processed == 0


def test_nested_native_model_answers_parse_with_distribution_guard():
    probabilities = {hero.replace('_',' ').title(): (.99 if hero == 'stelle' else .01/7) for hero in HEROES}
    native = {'status':'completed', 'result': {'answers': {'hero': {
        'type':'choice', 'choice':'Stelle','confidence':.99, 'probabilities':probabilities}}}}
    assert parse_hero(native, 'streamer_hero') == ('stelle',.99)


def test_mask_payload_has_null_name_confidence_but_keeps_mask_score_in_evidence():
    p = pipeline([LOCATION], [name(None,'masked',.999)])
    p.consume(image(),0)
    result = p.flush()[0]
    assert result['confidence'] is None
    assert result['field_evidence']['username']['confidence'] == .999


def test_obsolete_reuse_setting_cannot_enable_hero_reuse(monkeypatch):
    monkeypatch.setenv('SFDE_NEXT_RUN_REUSE_ENABLED', 'true')
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: response(kwargs['task'])
    enrich = EncounterEnricher(backend)
    enrich.enrich(event(8,0))
    second = event(9,20000)
    enrich.enrich(second)
    assert backend.infer.call_count == 4
    assert 'inherited_from' not in second['field_evidence']['streamer_hero']


def scene(seed=1):
    return np.random.default_rng(seed).integers(20,230,(54,96,3),dtype=np.uint8)


def player_scene(seed=1):
    return np.random.default_rng(seed).integers(20,230,(480,852,3),dtype=np.uint8)


def default_clock(**kwargs):
    return clock(**kwargs) | {'clock_region':[82,182,92,123]}


def test_observed_continuity_survives_clock_deadline_and_ordinary_transitions():
    frames = [None]*3+[LOCATION]*2+[None]*18+[LOCATION]*2
    readings = [clock(day=8,phase=None)]*3+[clock(visible=False)]*2
    readings += [clock(day=9,phase=None)]*18+[clock(visible=False)]*2
    readings = [dict(r,clock_region=[82,182,92,123]) for r in readings]
    p = pipeline(frames,clocks=readings,reads=[name()]*4)
    pixels = player_scene()
    y,x = np.indices(pixels[:240].shape[:2])
    pixels[:240] = np.repeat(np.where((x//24+y//24)%2,220,30).astype(np.uint8)[:,:,None],3,axis=2)
    jpeg = cv2.imencode('.jpg',pixels)[1].tobytes()
    output = []
    for i in range(len(frames)):
        output += p.consume(jpeg,i*2000)
    output += p.flush()
    assert [e['igd'] for e in output] == [8,9]
    assert output[0]['_clock_closed'] is True
    assert all(e['_continuity_supported'] for e in output)
    assert output[0]['_continuity_segment'] == output[1]['_continuity_segment']
    backend = Mock()
    backend.infer.side_effect = lambda _,**k: response(k['task'])
    enrich = EncounterEnricher(backend)
    for e in output:
        enrich.enrich(e)
    assert backend.infer.call_count == 4
    assert 'inherited_from' not in output[1]['field_evidence']['streamer_hero']


@pytest.mark.parametrize('fault', ['gap','day_regression','day_jump','menu','loading','run_end','blackout','cut','unknown_gap'])
def test_observed_run_abstains_on_real_ambiguity_not_just_clock_timeout(fault):
    run = ObservedRun()
    frame = player_scene()
    run.observe(0,frame,intro=False,clock=default_clock(day=8))
    run.observe(2000,frame,intro=False,clock=default_clock(day=8))
    before = run.epoch
    if fault == 'unknown_gap':
        for t in range(4000,14000,2000):
            run.observe(t,player_scene(3),intro=False,clock={})
    else:
        observation = default_clock(day=7 if fault=='day_regression' else 10 if fault=='day_jump' else 8)
        if fault in ('menu','loading','run_end'):
            observation['continuity_signal'] = fault
        if fault == 'blackout':
            frame = np.zeros_like(frame)
        elif fault == 'cut':
            frame = 250-player_scene(2)//8
        if fault=='cut':
            for t in range(4000,14000,2000):
                run.observe(t,frame,intro=False,clock=observation)
        else:
            run.observe(8000 if fault=='gap' else 4000,frame,intro=False,clock=observation)
    assert run.epoch > before


def test_two_sided_transition_proof_rejects_one_sided_stale_scene_then_cut():
    a,b = scene().astype(np.float32), (250-scene(2)//8).astype(np.float32)
    assert ObservedRun.bridge_proof(a,[a,a],b) is None
    proof = ObservedRun.bridge_proof(a,[a*.7+b*.3,a*.3+b*.7],b)
    assert proof['method'] == 'two_sided_convex_crossfade'
    assert ObservedRun.bridge_proof(a,[scene(3).astype(np.float32)],b) is None


def test_later_phase_label_does_not_relabel_an_earlier_clock_reading():
    p = pipeline([LOCATION]+[None]*4,clocks=[clock(visible=False),clock(phase=None)]+[clock()]*3)
    for i in range(5):
        p.consume(image(),i*2000)
    result = p.flush()[0]
    assert result['igd'] == 8 and result['wins_remaining'] == 0 and result['lethal'] is False
    assert result['field_evidence']['igd']['phase'] == 'unknown'
    assert result['field_evidence']['igd']['at_ms'] == 2000


def test_single_quality_owned_preintro_field_independent_of_other_unknown_fields():
    reading = clock(day=8,wins=None,lethal=None,phase=None)
    reading['evidence']['igd'].update(confidence=.99,method='paddle_day_glyph')
    p = pipeline([None,LOCATION],clocks=[reading,clock(visible=False)])
    p.consume(image(),0); p.consume(image(),2000)
    result = p.flush()[0]
    assert result['igd'] == 8 and result['wins_remaining'] is None and result['lethal'] is None
    evidence = result['field_evidence']['igd']
    assert evidence['at_ms'] == 0 and [s['at_ms'] for s in evidence['samples']] == [0,2000]
    assert result['_phase_anchor_ms'] == 2000


def test_weak_single_preintro_read_abstains_and_cannot_move_older_value_to_null_source():
    reading = clock(phase=None)
    p = pipeline([None,None,LOCATION],clocks=[reading,clock(day=None,phase=None),clock(visible=False)])
    for i in range(3):
        p.consume(image(),i*2000)
    result = p.flush()[0]
    assert result['igd'] is None
    reading['evidence']['igd'].update(confidence=.99,method='paddle_day_glyph')
    p = pipeline([None,None,LOCATION],clocks=[reading,clock(day=None,phase=None),clock(visible=False)])
    for i in range(3):
        p.consume(image(),i*2000)
    result = p.flush()[0]
    assert result['igd'] == 8 and result['field_evidence']['igd']['at_ms'] == 0


def test_phase_bridge_archives_actual_gap_pixels_and_immutable_intro_anchor():
    p = pipeline([None,None,None,LOCATION],clocks=[clock(phase=None),clock(phase=None),{},{}])
    for i in range(4):
        p.consume(image(),i*2000)
    result = p.flush()[0]
    assert result['igd'] == 8 and result['_phase_anchor_ms'] == 6000
    assert result['_phase_bridge']['samples'] == [4000]
    assert [s['at_ms'] for s in result['field_evidence']['igd']['samples']] == [0,2000,4000,6000]
    assert 4000 in result['_images']


def test_hero_selection_is_independent_of_name_and_rejects_first_fade():
    p = pipeline([LOCATION]*4,[name('Best','complete',.99),name(),name(),name()])
    p.consume(cv2.imencode('.jpg',np.full((36,64,3),8,np.uint8))[1].tobytes(),0)
    for t in (2000,4000,6000):
        p.consume(image(100),t)
    result = p.flush()[0]
    assert result['_intro_ms'] == 0 and result['username'] == 'Best'
    assert result['_hero_ms'] in (4000,6000) and result['_hero_previous_ms'] >= 2000
    backend = Mock()
    backend.infer.side_effect = lambda _,**k: response(k['task'])
    EncounterEnricher(backend).enrich(result)
    for call in backend.infer.call_args_list:
        assert call.kwargs['at_ms'] == result['_hero_ms']
        full = cv2.imdecode(np.frombuffer(result['_images'][result['_hero_ms']]['jpeg'],np.uint8),1)
        wanted = full[:,32:] if call.kwargs['task']=='ghost_hero' else full[:,:32]
        actual = cv2.imdecode(np.frombuffer(base64.b64decode(call.kwargs['image_base64']),np.uint8),1)
        assert np.array_equal(actual,wanted)
    p = pipeline([dict(LOCATION,complete=False)]*2,[name(None,'obstructed')]*2)
    p.consume(image(100),0); p.consume(image(100),2000)
    assert p.flush()[0]['_hero_ms'] == 2000  # Nameplate completeness is not hero quality.


def test_single_intro_still_checks_both_heroes_without_a_stable_pair():
    p = pipeline([LOCATION])
    p.consume(image(),0)
    result = p.flush()[0]
    backend = Mock()
    backend.infer.side_effect = lambda _, **kwargs: response(kwargs['task'])
    EncounterEnricher(backend).enrich(result)
    assert [call.kwargs['task'] for call in backend.infer.call_args_list] == ['ghost_hero', 'streamer_hero']
    for role in ('ghost_hero', 'streamer_hero'):
        proof = result['field_evidence'][role]
        assert proof['at_ms'] == result['_intro_ms']
        assert 'no_stable_pair' in proof['selection_reason']
        assert 'inherited_from' not in proof


@pytest.mark.parametrize('role',['ghost_hero','streamer_hero'])
def test_original_exploratory_hero_guard_both_roles_not_a_calibration(role):
    scores = {h:(.60 if h=='stelle' else .30 if h=='mak' else .10/6) for h in HEROES}
    assert parse_hero(response(role,probabilities=scores),role) == ('stelle',.60)
    scores['stelle'],scores['mak'] = .59,.31
    assert parse_hero(response(role,probabilities=scores),role) == (None,None)
    scores['stelle'],scores['mak'] = .64,.35
    # Fix total to one; margin, not a newly invented .8/.9 role floor, abstains.
    for h in HEROES-{'stelle','mak'}:
        scores[h] = .01/6
    assert parse_hero(response(role,probabilities=scores),role) == (None,None)


def test_hero_evidence_does_not_depend_on_prefight_day_proof():
    backend = Mock()
    backend.infer.side_effect = lambda _,**k: response(k['task'])
    enrich = EncounterEnricher(backend)
    first = event(8,0)
    enrich.enrich(first)
    assert 'run_segment_id' not in first['field_evidence']['streamer_hero']
    second = event(9,20000)
    enrich.enrich(second)
    assert second['field_evidence']['streamer_hero']['at_ms'] == 20000
    assert 'inherited_from' not in second['field_evidence']['streamer_hero']
    third = event(10,40000)
    third['field_evidence']['igd']['phase'] = 'unknown'
    enrich.enrich(third)
    assert 'run_segment_id' not in third['field_evidence']['streamer_hero']
    assert 'inherited_from' not in third['field_evidence']['streamer_hero']
    assert backend.infer.call_count == 6


def test_spatially_persistent_shop_survives_extended_clock_registration_failure():
    run = ObservedRun()
    frame = player_scene()
    run.observe(0,frame,intro=False,clock=default_clock())
    original = run.epoch
    for t in range(2000,24000,2000):
        run.observe(t,frame,intro=False,clock={})
    run.observe(24000,frame,intro=False,clock=default_clock())
    assert run.epoch == original
    # Actual changing/dimmed pixels still need distributed structural support.
    before = PlayerState.describe(frame,run.layout)
    after = PlayerState.describe((frame*.5).astype(np.uint8),run.layout)
    assert PlayerState.compare(before,after,'board')['supported']


@pytest.mark.parametrize('card_day,return_day,expected_bridge',[(9,9,True),(8,9,False),(1,9,False),(9,None,False)])
def test_native_day_card_continuity_requires_returning_independent_registered_next_day(card_day,return_day,expected_bridge):
    run = ObservedRun()
    game = player_scene()
    card = 250-player_scene(3)//8
    run.observe(0,game,intro=False,clock=default_clock(day=8))
    before = run.epoch
    run.observe(2000,card,intro=False,clock={},scene={'kind':'day_transition','day':card_day})
    run.observe(4000,card,intro=False,clock={},scene={'kind':'day_transition','day':card_day})
    run.observe(6000,game,intro=False,clock=default_clock(day=return_day))
    assert (run.epoch==before) is expected_bridge
    if expected_bridge:
        assert run.bridge['method'] == 'day_interstitial_then_same_player_board_and_registered_next_day'


def test_scene_ocr_is_bounded_native_optional_and_never_assigns_canonical_day(monkeypatch):
    raw = Mock(return_value=[('Day 9',.99)])
    monkeypatch.setattr('encounter_pipeline.tokens',raw)
    p = pipeline([None]*70,clocks=[clock(day=8)]+[{}]*69)
    p.processor.reader = object()
    p.run_observation.needs_scene_read = lambda _:True
    for i in range(70):
        p.consume(image(),i*2000)
    assert p.active is None and raw.call_count == p._scene_attempts == 64


def test_optional_intro_candidate_at_evidence_budget_preserves_encounter():
    p = pipeline([LOCATION,LOCATION])
    p.consume(image(),0)
    source = p.active['_images'][0]
    # Stress an already full valid-sized cache; optional extraction cannot throw
    # away the encounter to make room for a sixteenth source image.
    p.active['_images'].update({10000+i*2000:dict(source,at_ms=10000+i*2000) for i in range(14)})
    p.consume(image(),2000)
    result = p.flush()[0]
    assert result['anchor_ms'] == 0 and result['_evidence_budget_abstentions'] == 1
    assert len(result['_images']) <= 15


def test_player_state_uses_distributed_dynamic_texture_not_portrait_or_two_corners():
    a,b = player_scene(),player_scene(2)
    layout = PlayerState.layout(a,default_clock())
    # Same portrait, decorations and whole frame outside the player board/hud;
    # only actual player-state interiors change. Two surviving patches do not
    # establish continuity, even though most full-screen pixels still match.
    altered = a.copy()
    for region in layout['board']+layout['hud']:
        x,y,w,h = region
        altered[y:y+h,x:x+w] = b[y:y+h,x:x+w]
    for group in ('board','hud'):
        for index in (0,5):
            x,y,w,h = layout[group][index]
            altered[y:y+h,x:x+w] = a[y:y+h,x:x+w]
    before,after = PlayerState.describe(a,layout),PlayerState.describe(altered,layout)
    assert not PlayerState.compare(before,after,'board')['supported']
    assert not PlayerState.compare(before,after,'hud')['supported']


def test_inventory_changes_with_same_rich_skills_and_day_continue_and_refresh_references():
    """Parent revised the former wrong-board negative: purchases are not resets.

    The original negative/test construction is preserved in the failed replay's
    history. Rich dynamic skills are independent proof; hero alone never is.
    """
    run = ObservedRun()
    a = player_scene()
    layout = PlayerState.layout(a,default_clock())
    run.observe(0,a,intro=False,clock=default_clock())
    before = run.epoch
    for index,t in enumerate(range(2000,10000,2000)):
        purchased = a.copy()
        texture = player_scene(index+2)
        for x,y,w,h in layout['board']:
            purchased[y:y+h,x:x+w] = texture[y:y+h,x:x+w]
        run.observe(t,purchased,intro=False,clock=default_clock())
        assert run.last_match['hud']['supported'] and run.last_match['board_changed']
        assert not run.last_match['board']['supported']
        assert run.last_match['continuity_support']=='distributed_hud_match_despite_board_change'
        update = run.last_match['reference_updates']['board']
        assert update == {'at_ms':t,'previous_ms':t-2000,
                          'supported_by':'distributed_hud_match_despite_board_change'}
        assert run.board[0]==run.hud[0]==t and run.epoch==before and not run.pending


def test_different_board_and_skills_same_portrait_and_day_stays_unknown_then_splits():
    run = ObservedRun()
    a,b = player_scene(),player_scene(2)
    layout = PlayerState.layout(a,default_clock())
    other_run = a.copy()  # Portrait and all non-player-state pixels stay identical.
    for x,y,w,h in layout['board']+layout['hud']:
        other_run[y:y+h,x:x+w] = b[y:y+h,x:x+w]
    run.observe(0,a,intro=False,clock=default_clock())
    before = run.epoch
    run.observe(2000,other_run,intro=False,clock=default_clock())
    assert not run.last_match['hud']['supported'] and not run.last_match['board']['supported']
    assert run.anchor==0 and run.board[0]==run.hud[0]==0
    run.observe(4000,other_run,intro=True,clock={})
    assert not run.intro_supported
    for t in range(6000,12000,2000):
        run.observe(t,other_run,intro=False,clock=default_clock())
    assert run.epoch > before


@pytest.mark.parametrize('shape,region', [((360,640,3),[1,1,92,123]),
    ((480,640,3),[82,182,92,123]),((300,533,3),[51,114,57,77])])
def test_unsupported_or_unregistered_layout_does_not_establish_player_continuity(shape,region):
    frame = np.zeros(shape,np.uint8)
    assert PlayerState.layout(frame,default_clock() | {'clock_region':region}) is None
    run = ObservedRun()
    run.observe(0,frame,intro=False,clock={})
    run.observe(2000,frame,intro=True,clock={})
    assert run.layout is None and not run.intro_supported


@pytest.mark.parametrize('return_group',['board','hud'])
def test_opaque_interval_accepts_only_actual_returning_distributed_state(return_group):
    run = ObservedRun()
    a,b = player_scene(),player_scene(2)
    layout = PlayerState.layout(a,default_clock())
    returning = b.copy()
    for x,y,w,h in layout[return_group]:
        returning[y:y+h,x:x+w] = a[y:y+h,x:x+w]
    run.observe(0,a,intro=False,clock=default_clock())
    original = run.epoch
    for t in (2000,4000,6000):
        run.observe(t,np.full_like(a,80),intro=False,clock={})
        assert run.anchor==0 and run.board[0]==run.hud[0]==0
    run.observe(8000,returning,intro=False,clock=default_clock())
    assert run.epoch==original
    assert run.last_match[return_group]['supported']
    assert run.bridge['samples']==[2000,4000,6000]
    assert run.bridge['method']=='bounded_endpoint_corroboration_then_same_player_state'
    assert run.bridge['intermediate_pixels_trusted'] is False
    assert run.bridge['from_ms']==0 and run.bridge['to_ms']==8000


def test_partial_dynamic_hud_is_not_continuity_until_strong_state_returns():
    run = ObservedRun()
    a,b = player_scene(),player_scene(2)
    layout = PlayerState.layout(a,default_clock())
    for i in (3,4):
        x,y,w,h = layout['hud'][i]
        b[y:y+h,x:x+w] = a[y:y+h,x:x+w]
    run.observe(0,a,intro=False,clock=default_clock())
    original = run.epoch
    run.observe(2000,b,intro=False,clock={})
    assert not run.last_match['hud']['supported'] and len(run.last_match['hud']['matched'])==2
    assert run.anchor==0 and run.board[0]==run.hud[0]==0
    run.observe(4000,a,intro=False,clock=default_clock())
    assert run.epoch==original and run.bridge['samples']==[2000]
    assert run.last_match['board']['supported']


@pytest.mark.parametrize('fault',['sampling_gap','timeout','blackout','day_skip','day_regression','end','different_return'])
def test_opaque_endpoint_corroboration_cannot_bypass_sampling_reset_or_mismatching_state(fault):
    run = ObservedRun()
    a = player_scene()
    run.observe(0,a,intro=False,clock=default_clock(day=8))
    before = run.epoch
    run.observe(2000,np.full_like(a,80),intro=False,clock={})
    if fault=='sampling_gap':
        run.observe(8000,a,intro=False,clock=default_clock(day=8))
    elif fault in ('timeout','different_return'):
        for t in (4000,6000,8000):
            frame = player_scene(2) if fault=='different_return' else np.full_like(a,80)
            run.observe(t,frame,intro=False,clock=default_clock(day=8) if fault=='different_return' else {})
        run.observe(10000,a,intro=False,clock=default_clock(day=8))
    elif fault=='blackout':
        run.observe(4000,np.zeros_like(a),intro=False,clock={})
        run.observe(6000,a,intro=False,clock=default_clock(day=8))
    else:
        observation = default_clock(day=10 if fault=='day_skip' else 1 if fault=='day_regression' else 8)
        if fault=='end':
            observation['continuity_signal']='run_end'
        run.observe(4000,a,intro=False,clock=observation)
    assert run.epoch>before and run.bridge is None


def test_missing_or_partial_skills_with_nonmatching_inventory_never_refresh_trusted_references():
    for survivors in ([],[0,5]):
        run = ObservedRun()
        a,b = player_scene(),player_scene(2)
        layout = PlayerState.layout(a,default_clock())
        for x,y,w,h in layout['hud']:
            b[y:y+h,x:x+w] = 80
        for index in survivors:
            x,y,w,h = layout['hud'][index]
            b[y:y+h,x:x+w] = a[y:y+h,x:x+w]
        run.observe(0,a,intro=False,clock=default_clock())
        run.observe(2000,b,intro=False,clock=default_clock())
        assert not run.last_match['hud']['supported'] and not run.last_match['board']['supported']
        assert run.last_match['reference_updates']=={}
        assert run.anchor==0 and run.board[0]==run.hud[0]==0


@pytest.mark.skipif(not os.getenv('SFDE_REPAIR_OUTPUT'),reason='Explicit bounded cached-media replay only')
def test_cached_continuous_repair_replay():
    """Bounded native replay; fake hero responses test provenance, NOT accuracy.

    Fresh output directory required. Real shared OCR, locator, clock, phase,
    selection, continuity, enrichment and upload serializer; only HTTP is fake.
    No output is fed back into a detector or patched into an event.
    """
    import resource
    import time
    import yaml
    from urllib.parse import parse_qs, urlsplit
    from clock_reader import ClockReader
    from frame_processor import FrameProcessor

    root = Path(__file__).resolve().parents[2]
    out = Path(os.environ['SFDE_REPAIR_OUTPUT'])
    out.mkdir(parents=True,exist_ok=True)
    player_state_only = os.getenv('SFDE_REPAIR_PLAYER_STATE') == 'true'
    approved_continuity = os.getenv('SFDE_REPAIR_CONTINUITY_APPROVED') == 'true'
    assert not approved_continuity or player_state_only
    if player_state_only:
        import importlib.util
        clock_file = out/'frozen/sfde/src/clock_reader.py'
        spec = importlib.util.spec_from_file_location('repair_frozen_clock',clock_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        ClockReader = module.ClockReader
    assert not (out/'observations.jsonl').exists(), 'Append-only replay already exists'
    frozen = root/'.ignore/sfde-next/processor-replay'
    baseline = json.loads((frozen/'protocol.json').read_text())
    video = Path(os.environ['SFDE_REPAIR_VIDEO'])
    mask = root/'.ignore/sfde-next/capture/mask-BV1AHuC6nEGn/source-146-166.mp4'
    def digest(path):
        h = hashlib.sha256()
        with path.open('rb') as f:
            for part in iter(lambda:f.read(1024*1024),b''):
                h.update(part)
        return h.hexdigest()
    def snapshots():
        paths = list((root/'sfde/src').glob('*.py'))+[Path(__file__).resolve()]
        if player_state_only:
            paths = [p for p in paths if p.name!='clock_reader.py']
        else:
            paths += [p for p in (root/'sfde/assets/clock').rglob('*') if p.is_file()]
        paths += [p for p in frozen.iterdir() if p.is_file()]
        return {str(p.relative_to(root)):digest(p) for p in sorted(paths)}
    before = snapshots()
    assert digest(video) == baseline['media']['twitch']['sha256']
    assert digest(mask) == baseline['media']['mask']['sha256']
    continuous = {'id':'continuous','recording':'twitch:2549030240','source_offset_ms':0,
                  'start_ms':2964000,'end_ms':3428000,'count':232,'media':'twitch'}
    isolated = [w for w in baseline['windows'] if w['id'] not in ('m11','m12','m13')]
    pair_only = os.getenv('SFDE_REPAIR_PAIR_ONLY') == 'true'
    if player_state_only:
        continuous.update(start_ms=2974000,end_ms=3428000,count=227)
        isolated = []
    elif pair_only:
        continuous.update(start_ms=2974000,end_ms=3210000,count=118)
        isolated = []
    windows = [continuous]+isolated
    planned = sum(w['count'] for w in windows)
    assert planned == (227 if player_state_only else 118 if pair_only else 327)
    cap = 250 if approved_continuity else 300 if player_state_only else 500
    assert planned <= cap
    protocol = {'windows':windows,'planned_frames':planned,'hard_cap':cap,'cpu':2,'fps':.5,
                'profile':baseline['profile_for_all_windows'],'before_hashes':before,
                'fake_model':'stelle for both roles; no day fallback answer; no hero accuracy claim',
                'http':'in-memory infer/upload/ack only; not backend validation',
                'time_basis':'nominal source sample grid, not certified original PTS',
                'media_sha256':{'twitch':digest(video),'mask':digest(mask)}}
    if player_state_only:
        snapshot = json.loads((out/'clock-snapshot.json').read_text())
        assert all(digest(out/'frozen/sfde'/k)==v for k,v in snapshot.items())
        protocol['clock_snapshot'] = snapshot
        protocol['source_archive'] = '.ignore/sfde-next/processor-repair/frames/continuous'
    if approved_continuity:
        import ast
        text = (root/'sfde/src/run_context.py').read_text()
        node = next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='PlayerState')
        feature_hash = hashlib.sha256(ast.get_source_segment(text,node).encode()).hexdigest()
        assert feature_hash==(out/'feature-method-sha256.txt').read_text().strip()
        previous = root/'.ignore/sfde-next/processor-player-state'
        prior_hashes = json.loads((out/'prior-failure-hashes.json').read_text())
        assert all(digest(previous/k)==v for k,v in prior_hashes.items())
        protocol['semantic_contract']='parent-approved rich HUD OR board; bounded endpoint corroboration; strict day/reset guards'
        protocol['feature_method_sha256']=feature_hash
    (out/'protocol.json').write_text(json.dumps(protocol,indent=2)+'\n')
    started = time.perf_counter()
    cv2.setNumThreads(2)
    processor = FrameProcessor(yaml.safe_load((root/'sfde/config.yaml').read_text()),quality='480p',
                               old_templates=False,profile=protocol['profile'],streamer='offline_repair')
    reader = ClockReader(processor.reader,profile=protocol['profile'])
    assert reader.reader is processor.reader
    observations,events,calls,publications = [],[],[],[]
    context = {}
    for obj,method,label in [(processor,'locate_full_frame','location'),
                             (processor,'read_full_name','name'),(reader,'observe','clock')]:
        original = getattr(obj,method)
        def wrapped(*a,_original=original,_label=label,**k):
            result = _original(*a,**k)
            context[_label] = result
            return result
        setattr(obj,method,wrapped)
    backend = BackendClient.__new__(BackendClient)
    backend.retry_attempts,backend.quality,backend.streamer = 1,'480p','offline_repair'
    backend.logger = logging.getLogger('offline_repair')
    uploads,acknowledged = {},{}
    def request(path,method,data,chunk,**kwargs):
        if method == 'PUT':
            params = parse_qs(urlsplit(path).query)
            at_ms = int(params['timestamp_ms'][0])
            image_path = f'/offline/{chunk}/{at_ms}-{params["kind"][0]}.jpg'
            uploads[image_path] = hashlib.sha256(data).hexdigest()
            return {'storage_path':image_path}
        if path.endswith('/inference'):
            encoded = base64.b64decode(data['image_base64'])
            calls.append({k:v for k,v in data.items() if k!='image_base64'} |
                         {'chunk':chunk,'png_sha256':hashlib.sha256(encoded).hexdigest()})
            return ({'status':'unknown','result':None} if data['task']=='clock_day'
                    else response(data['task']))
        assert path.endswith('/detections') and len(data['detections']) == 1
        record = deepcopy(data['detections'][0])
        for field in record['field_evidence'].values():
            assert uploads[field['image_path']] == field['frame_sha256']
            assert all(s['image_path'] in uploads for s in field.get('samples',[]))
        hero_proof = record['field_evidence']['streamer_hero']
        if 'inherited_from' in hero_proof:
            root_record = acknowledged[hero_proof['inherited_from']['detection_id']]
            root_proof = root_record['field_evidence']['streamer_hero']
            assert 'inherited_from' not in root_proof
            assert {k:v for k,v in hero_proof.items() if k not in ('inherited_from','selection_reason')} == {
                k:v for k,v in root_proof.items() if k!='selection_reason'}
            previous = [p for p in publications if p['chunk']==chunk][-1]['record']
            assert previous['igd']+1 == record['igd']
            assert previous['streamer_hero'] == record['streamer_hero']
            assert hero_proof['run_segment_id'] == hero_proof['inherited_from']['run_segment_id'] == root_proof['run_segment_id']
            assert hero_proof['at_ms'] == hero_proof['inherited_from']['at_ms']
            assert root_record['timestamp'] < previous['timestamp'] or root_record['id']==previous['id']
            if previous['id']!=root_record['id']:
                assert previous['field_evidence']['streamer_hero']['inherited_from'] == hero_proof['inherited_from']
            for original in (root_proof,root_record['field_evidence']['igd']):
                assert original['at_ms'] < record['timestamp']*1000
                assert all(s['at_ms'] < record['timestamp']*1000 for s in original.get('samples',[]))
        publications.append({'chunk':chunk,'record':record})
        acknowledged[record['id']] = record
        return {'published':1}
    backend._request = request
    ledger = (out/'observations.jsonl').open('x')
    for window in windows:
        wid = window['id']
        processor.reset_state()
        pipeline = EncounterPipeline(processor,recording=window['recording'],vod_id=window['recording'],
            chunk_id='offline-repair-'+wid,start_ms=window['start_ms'],end_ms=window['end_ms'],clock=reader)
        enrich = EncounterEnricher(backend)
        source = video if window['media']=='twitch' else mask
        cmd = ['ffmpeg','-hide_banner','-loglevel','error','-threads','2','-filter_threads','1',
               '-ss',str((window['start_ms']-window['source_offset_ms'])/1000),'-i',str(source),
               '-t',str((window['end_ms']-window['start_ms'])/1000),'-map','0:v:0','-an',
               '-vf','fps=0.5:eof_action=pass','-frames:v',str(window['count']),'-threads','2',
               '-fps_mode','passthrough','-f','image2pipe','-vcodec','mjpeg','-pix_fmt','yuvj420p','pipe:1']
        if player_state_only:
            archive = root/protocol['source_archive']
            old_rows = [json.loads(l) for l in (archive.parents[1]/'observations.jsonl').read_text().splitlines()]
            hashes = {r['at_ms']:r['sha256'] for r in old_rows if r['window']=='continuous'}
            jpegs = [(archive/f'{t}.jpg').read_bytes() for t in range(window['start_ms'],window['end_ms'],2000)]
            assert all(hashlib.sha256(j).hexdigest()==hashes[window['start_ms']+i*2000] for i,j in enumerate(jpegs))
            (out/'archive-input.json').write_text(json.dumps({'source':str(archive),'count':len(jpegs),
                'original_decode':json.loads((archive.parents[1]/'ffmpeg-continuous.json').read_text())},indent=2))
        else:
            decoded = subprocess.run(cmd,capture_output=True,check=True,timeout=90)
            (out/f'ffmpeg-{wid}.json').write_text(json.dumps({'command':cmd,'stderr':decoded.stderr.decode()}))
            jpegs = [part[part.find(b'\xff\xd8'):]+b'\xff\xd9'
                     for part in decoded.stdout.split(b'\xff\xd9') if b'\xff\xd8' in part]
        assert len(jpegs) == window['count']
        (out/'frames'/wid).mkdir(parents=True,exist_ok=True)
        def emit(e):
            enrich.enrich(e)
            assert backend.upload_batch([e])
            clean = {k:v for k,v in e.items() if k!='_images'}
            clean['_images'] = {t:{k:v for k,v in s.items() if k!='jpeg'} for t,s in e['_images'].items()}
            clean['_replay_window'] = wid
            events.append(clean)
        for i,jpeg in enumerate(jpegs):
            assert len(observations) < cap
            at_ms = window['start_ms']+i*2000
            assert cv2.imdecode(np.frombuffer(jpeg,np.uint8),1).shape[:2] == (480,852)
            (out/'frames'/wid/f'{at_ms}.jpg').write_bytes(jpeg)
            context.clear()
            prior_epoch = pipeline.continuity_epoch
            for e in pipeline.consume(jpeg,at_ms):
                emit(e)
            row = {'window':wid,'at_ms':at_ms,'sha256':hashlib.sha256(jpeg).hexdigest(),
                   **context,'epoch':pipeline.continuity_epoch,'split':prior_epoch!=pipeline.continuity_epoch,
                   'continuity_reason':pipeline.run_observation.reason,'bridge':pipeline.run_observation.bridge,
                   'run_scene':pipeline._last_run_scene,
                   'player_match':pipeline.run_observation.last_match,
                   'player_layout':pipeline.run_observation.layout,
                   'intro_supported':pipeline.run_observation.intro_supported,
                   'pending':list(pipeline.run_observation.pending),
                   'pre_clock':[s['at_ms'] for s,_ in pipeline.pre_clock],
                   'active':({k:pipeline.active.get(k) for k in ('anchor_ms','igd','wins_remaining','lethal',
                       '_prefight_proven','_hero_ms','_hero_selection','_clock_closed')} if pipeline.active else None)}
            if pipeline.active:
                assert len(pipeline.active['_images']) <= 15
            observations.append(row)
            ledger.write(json.dumps(row,ensure_ascii=False)+'\n'); ledger.flush()
        for e in pipeline.flush():
            emit(e)
        assert pipeline.flush() == []
    ledger.close()
    summary = {'frames':len(observations),'event_count':len(events),'fake_inference_calls':len(calls),
               'streamer_calls':sum(c['task']=='streamer_hero' for c in calls),
               'inherited':sum('inherited_from' in e['field_evidence']['streamer_hero'] for e in events),
               'coverage':{f:sum(e[f] is not None for e in events) for f in ('igd','wins_remaining','lethal')},
               'wall_seconds':time.perf_counter()-started,
               'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
               'after_hashes':snapshots(),'frozen_files_unchanged':snapshots()==before}
    if player_state_only:
        summary['clock_snapshot_unchanged'] = all(digest(out/'frozen/sfde'/k)==v for k,v in protocol['clock_snapshot'].items())
    if approved_continuity:
        summary['previous_failed_replay_unchanged'] = all(digest(previous/k)==v for k,v in prior_hashes.items())
    for filename,value in [('events.json',events),('fake-calls.json',calls),('publications.json',publications),('summary.json',summary)]:
        (out/filename).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
    assert summary['frames'] == planned
    assert summary['frozen_files_unchanged']
    if player_state_only:
        assert summary['clock_snapshot_unchanged']
        assert [e['username'] for e in events] == ['limonerism','Meninim','RedMint']
        first,second,after_reset = events
        assert 'inherited_from' not in second['field_evidence']['streamer_hero']
        assert 'inherited_from' not in after_reset['field_evidence']['streamer_hero']
        assert first['_continuity_segment']==second['_continuity_segment']!=after_reset['_continuity_segment']
    if approved_continuity:
        assert summary['previous_failed_replay_unchanged']
        assert summary['inherited']==0 and summary['streamer_calls']==len(events)
    assert len([e for e in events if e['_replay_window']=='continuous']) == (2 if pair_only else 3)
