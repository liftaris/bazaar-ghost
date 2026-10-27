import json
from pathlib import Path

import cv2
import pytest

from clock_reader import ClockReader
from ocr_runtime import create_clock_text_reader, create_ocr_reader


FIXTURES = Path(__file__).parent / 'fixtures' / 'clock_modes'
CASES = json.loads((FIXTURES / 'labels.json').read_text())['cases']


@pytest.fixture(scope='module')
def clock():
    return ClockReader(create_ocr_reader(), text_reader=create_clock_text_reader())


@pytest.mark.parametrize('case', CASES, ids=lambda case: str(case['id']))
def test_reviewed_clock_day_and_score_are_separate(case, clock):
    frame = cv2.imread(str(FIXTURES / f"igd-full-{case['id']}.jpg"))
    actual = clock.observe(frame)
    assert actual['visible']
    assert actual['igd'] in (None, case['day'])
    assert actual['tournament_wins'] == case['wins']
    assert actual['tournament_losses'] == case['losses']
    if case['wins'] is not None:
        assert actual['game_mode'] == 'tournament'
        assert actual['wins_remaining'] is None
        assert actual['lethal'] is None
        day_region = actual['evidence']['igd']['region']
        score_region = actual['evidence']['tournament_wins']['region']
        assert day_region[1] >= score_region[1] + score_region[3]
    else:
        assert actual['game_mode'] != 'tournament'


@pytest.mark.parametrize('id,day', [(32237, 7), (32224, 13), (32220, 4), (34127, 14)])
def test_previously_incorrect_days_are_now_read(id, day, clock):
    frame = cv2.imread(str(FIXTURES / f'igd-full-{id}.jpg'))
    assert clock.observe(frame)['igd'] == day
