"""Portable saved-output regressions, including known wrong hero predictions.

No live inference, OCR, backend access, downloads, or fixture rewriting.
"""
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from encounter_pipeline import HEROES, parse_hero


ROOT = Path(__file__).parent / 'fixtures' / 'hero_regressions'
MANIFEST = json.loads((ROOT / 'manifest.json').read_text())
CONTEXTS = {row['id']: row for row in MANIFEST['contexts']}
RESPONSES = {row['id']: row for row in MANIFEST['responses']}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(hero):
    return hero.lower().replace(' ', '_')


def asset_path(file):
    path = (ROOT / file).resolve()
    assert path.is_relative_to(ROOT.resolve())
    assert file in MANIFEST['assets']
    return path


def cached(row):
    return json.loads(asset_path(row['file']).read_text())


def task_prompt(protocol):
    document = json.loads(asset_path(protocol['promptFile']).read_text())
    return document[protocol['promptSelector']] if protocol['promptSelector'] else document


def guarded(row):
    protocol = MANIFEST['protocols'][row['protocolId']]
    assert protocol['guardCompatible'], 'Do not apply current guard to another task protocol'
    # Transport-only adapter: original result/answers/probabilities are unchanged.
    return parse_hero({'status': 'ok', 'result': cached(row)['response']['result']}, 'ghost_hero')


def test_corpus_bounds_and_recording_level_provenance():
    assert MANIFEST['previouslySeen'] is True
    assert MANIFEST['blindHeldout'] is False and MANIFEST['split'] == 'regression'
    assert set(CONTEXTS) == {'m01', 'm05', 'm09', 'm15', 'p01-youtube-dragons-360',
                             'p03-overlay-pygmalien-480', 'p04-drummer-pygmalien-480',
                             'p06-transition-jules-480'}
    assert len(MANIFEST['nameVisibility']) == 5 and len(RESPONSES) == 19
    assert len(MANIFEST['assets']) == 44
    assert sum(row['kind'] == 'image' for row in MANIFEST['assets'].values()) == 20
    assert all(row['hero'] != 'karnok' for row in CONTEXTS.values())
    partitions = {}
    for row in [*CONTEXTS.values(), *MANIFEST['nameVisibility']]:
        source = row['source']
        group = ':'.join(str(part) for part in
                         (source['platform'], source['recordingId'], source['partId']) if part is not None)
        assert row['recordingGroup'] == group
        assert row['partition'] == 'regression:' + group
        assert partitions.setdefault(group, row['partition']) == row['partition']
        assert type(source['nominalSeconds']) in (int, float)
        assert source['timeBasis'] and source['rendition']
        assert source['exactSourcePts'] is False
        assert row['labelReview']['independentHuman'] is False
        assert 'AI' in row['labelReview']['method']
        assert len(row['labelReview']['sourceLabelsSha256']) == 64
        if row['run'] is not None:
            run = row['run']
            assert source['nominalSeconds'] < run['endResultSeconds']
            if run['observedStartBracketSeconds'] is not None:
                assert run['observedStartBracketSeconds'][1] <= source['nominalSeconds']
    assert CONTEXTS['m01']['run']['observedStartBracketSeconds'] is None
    assert CONTEXTS['m15']['run']['id'] == 'kripp-local-B'
    assert len({CONTEXTS[id]['partition'] for id in ('m01', 'm05', 'm09', 'm15')}) == 1
    assert all(row['verifiedSkinId'] is None for row in CONTEXTS.values())
    referenced = {p['promptFile'] for p in MANIFEST['protocols'].values()}
    for row in CONTEXTS.values():
        referenced.add(row['file'])
        for view in row['inputs']:
            referenced.update((view['file'], view['parentFile']))
    for row in RESPONSES.values():
        referenced.update((row['file'], row['inputFile']))
        context = CONTEXTS[row['contextId']]
        assert row['inputFile'] in {context['file'], *(view['file'] for view in context['inputs'])}
    assert referenced == set(MANIFEST['assets'])


@pytest.mark.parametrize('file', sorted(MANIFEST['assets']))
def test_copied_asset_hash_dimensions_and_safe_metadata(file):
    metadata = MANIFEST['assets'][file]
    data = asset_path(file).read_bytes()
    assert digest(data) == metadata['sha256'] == metadata['originalSha256']
    assert len(data) == metadata['bytes']
    assert metadata['transformation'] == 'none; byte-identical copy'
    if metadata['kind'] == 'image':
        with Image.open(asset_path(file)) as image:
            assert list(image.size) == metadata['dimensions']
            image.verify()
    else:
        text = data.decode()
        json.loads(text)
        assert not any(word in text.lower() for word in (
            'authorization', 'bearer ', 'api_token', 'api_key', 'set-cookie',
            'http://', 'https://', 'data:image', 'image_base64'))


@pytest.mark.parametrize('id', list(CONTEXTS))
def test_input_parent_crops_and_no_upscale(id):
    row = CONTEXTS[id]
    full_width, full_height = MANIFEST['assets'][row['file']]['dimensions']
    for view in row['inputs']:
        parent = MANIFEST['assets'][view['parentFile']]
        width, height = MANIFEST['assets'][view['file']]['dimensions']
        x1, y1, x2, y2 = view['cropXyxy']
        assert 0 <= x1 < x2 <= parent['dimensions'][0]
        assert 0 <= y1 < y2 <= parent['dimensions'][1]
        assert width <= x2 - x1 and height <= y2 - y1
        if view['resize'].startswith('none'):
            assert [width, height] == [full_width // 2, full_height]
            with Image.open(asset_path(view['parentFile'])) as image:
                expected = np.asarray(image.convert('RGB'))[y1:y2, x1:x2]
            with Image.open(asset_path(view['file'])) as image:
                assert np.array_equal(np.asarray(image.convert('RGB')), expected)
        else:
            assert [width, height] == [569, 640]
            assert abs(width / height - (x2 - x1) / (y2 - y1)) < .002


@pytest.mark.parametrize('id', list(RESPONSES))
def test_raw_response_matches_original_prompt_input_and_distributions(id):
    row = RESPONSES[id]
    protocol = MANIFEST['protocols'][row['protocolId']]
    prompt = task_prompt(protocol)
    raw = cached(row)
    assert raw['request_sha256'] == row['requestSha256']
    assert raw['response']['success'] is True
    result = raw['response']['result']
    assert result['model'] == prompt['model'] == 'clef-flash'
    assert result['usage']['input_tokens'] > 0
    assert set(result['answers']) == set(prompt['questions'])
    for key, answer in result['answers'].items():
        assert answer['type'] == prompt['questions'][key]['type'] == 'choice'
        scores = answer['probabilities']
        assert set(scores) == set(prompt['questions'][key]['criteria'])
        assert all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
                   for value in scores.values())
        assert abs(sum(scores.values()) - 1) < .01
        assert max(scores, key=scores.get) == answer['choice']
    assert result['answers'][protocol['answerKey']]['choice'] == row['rawChoice']

    request = raw['request']
    if 'state' in request:
        assert request['state'] == prompt['state']
        assert request['questions'] == prompt['questions']
        input_hash = request['images'][0]['sha256']
    elif 'prompts_file_sha256' in request:
        assert request['prompts_file_sha256'] == MANIFEST['assets'][protocol['promptFile']]['sha256']
        input_hash = request['image_sha256']
    else:
        if row['protocolId'] == 'resize640-half-eight':
            prompt_hash = digest(json.dumps(prompt, sort_keys=True, ensure_ascii=False).encode())
            input_hash = request['image']['sha256']
        else:
            prompt_hash = MANIFEST['assets'][protocol['promptFile']]['sha256']
            input_hash = request['image_sha256']
        assert request['prompt_sha256'] == prompt_hash
    assert input_hash == MANIFEST['assets'][row['inputFile']]['sha256']


COMPATIBLE = [row['id'] for row in RESPONSES.values()
              if MANIFEST['protocols'][row['protocolId']]['guardCompatible']]


@pytest.mark.parametrize('id', COMPATIBLE)
def test_current_guard_on_compatible_cached_eight_choice_results(id):
    row = RESPONSES[id]
    prompt = task_prompt(MANIFEST['protocols'][row['protocolId']])
    assert {canonical(key) for key in prompt['questions']['hero']['criteria']} == HEROES
    hero, confidence = guarded(row)
    assert hero == row['expectedGuardHero']
    if hero is None:
        assert confidence is None
    else:
        answer = cached(row)['response']['result']['answers']['hero']
        assert confidence == answer['probabilities'][answer['choice']]
    known_wrong = hero is not None and hero != CONTEXTS[row['contextId']]['hero']
    assert known_wrong == row['guardExpectedKnownFailure']


def test_required_historical_failures_are_retained_not_corrected_or_hidden():
    for id in ('m05', 'm09', 'm15'):
        row = RESPONSES[id + '-original-full-ten']
        assert row['rawChoice'] == 'Stelle' and CONTEXTS[id]['hero'] != 'stelle'
    assert RESPONSES['m01-original-half-eight']['rawChoice'] == 'Mak'
    assert RESPONSES['m15-earlier-half-ten']['rawChoice'] == 'unknown'
    assert 'wrestling' in CONTEXTS['m15']['skinDescription']
    for protocol in ('robustness-half-eight', 'experimental-cues', 'experimental-visibility'):
        row = RESPONSES['p03-overlay-pygmalien-480-' + protocol]
        assert cached(row)['response']['result']['answers']['hero']['choice'] == 'Mak'
        assert CONTEXTS[row['contextId']]['hero'] == 'pygmalien'
    # This is a known accepted wrong answer, not an xfail or expected abstention.
    assert guarded(RESPONSES['p03-overlay-pygmalien-480-robustness-half-eight'])[0] == 'mak'
    assert cached(RESPONSES['p03-overlay-pygmalien-480-experimental-cues'])['response']['result']['answers']['identity_glow']['choice'] == 'unknown'
    assert cached(RESPONSES['p03-overlay-pygmalien-480-experimental-visibility'])['response']['result']['answers']['identity_visibility']['choice'] == 'clear'


def test_selective_counts_report_wrong_and_unknown_without_claiming_accuracy():
    raw_counts, guard_counts = Counter(), Counter()
    excluded = Counter()
    for row in RESPONSES.values():
        context = CONTEXTS[row['contextId']]
        if not context['identityEligible']:
            excluded['transition_responses'] += 1
            continue
        choice = canonical(cached(row)['response']['result']['answers'][MANIFEST['protocols'][row['protocolId']]['answerKey']]['choice'])
        raw_counts['unknown' if choice in ('unknown', 'obstructed') else
                   'correct' if choice == context['hero'] else 'wrong'] += 1
        if MANIFEST['protocols'][row['protocolId']]['guardCompatible']:
            hero, _ = guarded(row)
            guard_counts['unknown' if hero is None else 'correct' if hero == context['hero'] else 'wrong'] += 1
    assert raw_counts == {'correct': 10, 'wrong': 7, 'unknown': 1}
    assert guard_counts == {'correct': 5, 'wrong': 1, 'unknown': 5}
    assert excluded == {'transition_responses': 1}
    transition = CONTEXTS['p06-transition-jules-480']
    assert transition['stableIntro'] is False and transition['identityEligible'] is False
    assert guarded(RESPONSES['p06-transition-jules-480-robustness-half-eight']) == (None, None)
    print('Saved-output regression counts (correlated protocol replays, NOT independent accuracy):',
          {'raw_stable': dict(raw_counts), 'compatible_guard_stable': dict(guard_counts),
           'excluded': dict(excluded)})


@pytest.mark.parametrize('row', MANIFEST['nameVisibility'], ids=lambda row: row['id'])
def test_natural_visibility_annotations_reuse_existing_bytes_without_hidden_names(row):
    file = row['file']
    assert file.startswith('../frames/') and len(Path(file).parts) == 3
    path = (ROOT / file).resolve()
    assert path.parent == (ROOT.parent / 'frames').resolve()
    assert digest(path.read_bytes()) == row['sha256']
    with Image.open(path) as image:
        assert list(image.size) == row['dimensions']
    assert row['synthetic'] is False
    assert row['visibility'] in ('partially_covered', 'uncertain')
    assert row['visibleText'] is None and row['searchableUsername'] is None
    assert row['historicalUsernameIsVisibleTruth'] is False
    old = json.loads((ROOT.parent / 'annotations.json').read_text())[row['legacyAnnotationKey']]
    assert row['historicalUsername'] == old['username']
    assert row['historicalUsernameCorrected'] == old['username_corrected']
    assert row['source']['recordingId'] == old['twitch_vod_id']
    assert row['source']['fullFrameParentSha256'] is None
    assert row['source']['fullFrameCropXyxy'] is None
