from collections import Counter
import hashlib
import json
import math
from pathlib import Path

import pytest

from encounter_pipeline import HEROES, parse_hero


FIXTURES = Path(__file__).parent / 'fixtures'
SAVED_FILE = FIXTURES / 'hero_skins_v2/responses.json'
SAVED = json.loads(SAVED_FILE.read_text())
ROWS = {row['id']: row for row in SAVED['rows']}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def test_winning_response_fixture_provenance_and_selection():
    assert digest(SAVED_FILE.read_bytes()) == '1367b2a12bede01748703b92fa41e6e0b6a6e8583e6a97cf8d2b4a32f013fac9'
    assert SAVED['prompt_file_sha256'] == 'fb6f8dd45c3a0eaaa2eee6a358b66c7c6a72bd1f1a6a08bb4a51355961026970'
    assert SAVED['prompt_canonical_sha256'] == 'b2cdf14398601dabf14711147b35636f008d30ca4be5ea0a7a54e8069a59d7a3'
    assert SAVED['model'] == '@cf/cloudflare/clef-flash'
    assert 'not independent heldout accuracy' in SAVED['scope']
    assert len(ROWS) == len(SAVED['rows']) == 18
    assert Counter(row['domain'] for row in ROWS.values()) == {
        'skin_reference': 3, 'gameplay': 7, 'historical_gameplay': 8}
    assert {row['expected'] for row in ROWS.values()} == HEROES
    historical = json.loads((FIXTURES / 'hero_regressions/manifest.json').read_text())
    contexts = {row['id']: row for row in historical['contexts']}
    eligible = {id for id, row in contexts.items() if row['identityEligible']}
    assert {row['id'] for row in ROWS.values() if row['domain'] == 'historical_gameplay'} == {
        f'historical-{id}-ghost_hero' for id in eligible}
    for row in ROWS.values():
        for key in ('image_sha256', 'cache_key', 'original_cache_sha256', 'response_sha256'):
            assert len(row[key]) == 64 and int(row[key], 16) >= 0
        assert 0 < max(row['dimensions']) <= 640
        assert row['role'] == ('reference' if row['domain'] == 'skin_reference' else row['id'].rsplit('-', 1)[1])
        if row['domain'] == 'historical_gameplay':
            context = contexts[row['id'].removeprefix('historical-').removesuffix('-ghost_hero')]
            assert row['expected'] == context['hero']
            assert row['source']['source_sha256'] == historical['assets'][context['file']]['sha256']
        if row['domain'] == 'gameplay':
            baseline = row['baseline']
            assert baseline['top_probability'] < .60 or baseline['margin'] < .30
            assert row['source']['independent_human'] is False
    lowest_skin = ROWS['skin-636']['response']['result']['answers']['hero']
    assert lowest_skin['probabilities']['Karnok'] == .3348
    closest = ROWS['historical-p03-overlay-pygmalien-480-ghost_hero']['response']['result']['answers']['hero']
    assert closest['probabilities']['Pygmalien'] - closest['probabilities']['Mak'] == pytest.approx(.0554)


@pytest.mark.parametrize('id', list(ROWS))
def test_actual_winning_responses_parse_without_rewriting(id):
    row = ROWS[id]
    raw = row['response']
    assert digest(json.dumps(raw, sort_keys=True, separators=(',', ':')).encode()) == row['response_sha256']
    assert raw['success'] is True
    result = raw['result']
    assert result['model'] == 'clef-flash'
    assert set(result['answers']) == {'hero'}
    answer = result['answers']['hero']
    assert answer['type'] == 'choice'
    scores = answer['probabilities']
    assert {hero.lower().replace(' ', '_') for hero in scores} == HEROES
    assert all(type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 1 for score in scores.values())
    assert sum(scores.values()) == pytest.approx(1, abs=.01)
    assert max(scores, key=scores.get) == answer['choice']
    assert result['usage']['input_tokens'] > 0 and result['usage']['output_tokens'] == 0
    for role in ('ghost_hero', 'streamer_hero'):
        assert parse_hero({'status': 'completed', 'result': result}, role) == (
            row['expected'], scores[answer['choice']])
