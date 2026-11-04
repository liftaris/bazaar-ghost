import json
from pathlib import Path

import cv2
import pytest

from clock_reader import ClockReader
from ocr_runtime import create_clock_text_reader, create_ocr_reader


FIXTURES = Path(__file__).parent / 'fixtures' / 'clock_prestige'
CASES = json.loads((FIXTURES / 'labels.json').read_text())['cases']


@pytest.fixture(scope='module')
def clock():
    return ClockReader(create_ocr_reader(), text_reader=create_clock_text_reader())


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_reviewed_prestige_meter(case, clock):
    actual = clock.observe(cv2.imread(str(FIXTURES / f"{case['id']}.jpg")))
    assert actual['visible']
    assert actual['prestige'] == case['prestige']
    if 'lethal' in case:
        assert actual['lethal'] is case['lethal']
    region = actual['evidence']['prestige']['region']
    assert region[1] > actual['clock_region'][1] + actual['clock_region'][3] * .75


@pytest.mark.parametrize('text,score,expected', [
    ('20/20', .99, 20), ('0/20', .99, 0), ('1/20', .98, 1), ('11 / 20', .95, 11),
    ('187/20', .97, 18), ('117/20', .92, 11),
    ('21/20', .99, None), ('27/20', .99, None), ('20/20', .89, None),
    ('020/20', .99, None), ('20/10', .99, None), ('TenepBB', .99, None), ('20/20', True, None),
])
def test_prestige_text_parsing(text, score, expected):
    class Reader:
        def predict(self, image):
            return [{'rec_text': text, 'rec_score': score}]
    import numpy as np
    value, _ = ClockReader(None, text_reader=Reader())._prestige(np.zeros((40, 120, 3), np.uint8), [0, 0, 120, 40])
    assert value == expected
