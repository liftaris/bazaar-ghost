"""Pixel-based clock regressions; development evidence, not a heldout claim."""
import hashlib
import json
import logging
from pathlib import Path
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from clock_reader import ClockReader


ASSETS = Path(__file__).resolve().parent.parent / 'assets' / 'clock'
NATIVE = json.loads((ASSETS / 'native480-labels.json').read_text())['cases']
PROFILE = {'igd_crop_region': [0.1458, 0.4509, 0.013, 0.0231]}


def native(case='m01'):
    return cv2.imread(str(ASSETS / 'fixtures' / f'native480-{case}.jpg'))


def bili(file='safe.png'):
    """Real native ROI at its verified source coordinates; rest is blank."""
    frame = np.zeros((480, 852, 3), dtype=np.uint8)
    frame[185:305, 80:175] = cv2.imread(str(ASSETS / file))
    return frame


def clock_crop(file, xy=(185, 410)):
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    image = cv2.imread(str(ASSETS / file))
    x, y = xy
    frame[y:y+image.shape[0], x:x+image.shape[1]] = image
    return frame


@pytest.fixture(scope='module')
def shared_paddle():
    # Existing runtime factory/models, instantiated ONCE by the caller, not the
    # module under test. The bg120-test image already contains their cache.
    from ocr_runtime import create_ocr_reader
    return create_ocr_reader()


def test_constructor_and_locate_reuse_reader_without_initializing_or_invoking_ocr():
    reader = Mock()
    clock = ClockReader(reader)
    assert clock.reader is reader
    region = clock.locate(native())
    assert region is not None
    reader.predict.assert_not_called()
    assert ClockReader(None).observe(native())['clock_region'] == region


@pytest.mark.parametrize('case', NATIVE, ids=lambda case: case['id'])
def test_labelled_native480_wins_and_safe_crown(case):
    frame = cv2.imread(str(ASSETS / case['file']))
    result = ClockReader(None).observe(frame)
    assert result['visible'] is True
    assert result['wins_remaining'] == case['truth']['wins_remaining']
    assert result['lethal'] is False
    assert result['igd'] is None  # No reader: never manufacture a day from wins.


@pytest.mark.parametrize('case', NATIVE, ids=lambda case: case['id'])
@pytest.mark.parametrize('profile', [None, PROFILE], ids=['automatic', 'profile'])
def test_shared_paddle_native_days(case, shared_paddle, profile):
    result = ClockReader(shared_paddle, profile).observe(cv2.imread(str(ASSETS / case['file'])))
    assert result['igd'] == case['truth']['igd']
    assert result['evidence']['igd']['confidence'] >= 0.9


@pytest.mark.parametrize('file,wins,lethal', [
    ('safe.png', 5, False), ('bili-3450.png', 1, True), ('bili-3520.png', 1, True),
])
def test_real_tiny_bili_cells_and_bottom_crown(file, wins, lethal):
    result = ClockReader(None).observe(bili(file))
    assert result['visible'] is True
    assert result['wins_remaining'] == wins
    assert result['lethal'] is lethal


def test_dim_bili_cells_are_unknown_not_an_invented_count():
    # Pixel-reviewed earned8/remaining2. Two dim cells do not meet the strict
    # colour support rule: retain the known recall gap instead of guessing.
    result = ClockReader(None).observe(bili('cracked.png'))
    assert result['visible'] is True
    assert result['wins_remaining'] is None
    assert result['lethal'] is True


@pytest.mark.parametrize('file,day', [('safe.png', 7), ('cracked.png', 12),
                                   ('bili-3450.png', 13), ('bili-3520.png', 13)])
def test_shared_paddle_reads_complete_native_bili_day_medallions(file, day, shared_paddle):
    result = ClockReader(shared_paddle).observe(bili(file))
    assert result['igd'] == day


@pytest.mark.parametrize('case', ['bili'] + [case['id'] for case in NATIVE])
def test_desaturating_a_real_whole_crown_never_makes_it_lethal(case):
    frame = bili() if case == 'bili' else native(case)
    patch = frame[274:295, 94:115]
    frame[274:295, 94:115] = cv2.cvtColor(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    result = ClockReader(None).observe(frame)
    assert result['visible'] is True
    assert result['lethal'] is None


def test_original1080_day12_nine_earned_pixels_are_still_countable():
    result = ClockReader(None).observe(clock_crop('safe-nine.png'))
    assert result['visible'] is True
    assert result['wins_remaining'] == 1
    assert result['lethal'] is False


@pytest.mark.parametrize('file', ['safe.png', 'cracked.png', 'bili-3450.png', 'bili-3520.png'])
def test_native_pixel_blur_is_unknown_before_upscaling(file):
    frame = bili(file)
    frame[272:296, 92:116] = cv2.GaussianBlur(frame[272:296, 92:116], (0, 0), 2.5)
    assert ClockReader(None).observe(frame)['lethal'] is None


@pytest.mark.parametrize('file', ['safe.png', 'cracked.png'])
@pytest.mark.parametrize('right', [104, 115])
def test_partially_or_fully_hidden_bottom_crown_is_unknown(file, right):
    frame = bili(file)
    frame[274:295, 94:right] = 0
    assert ClockReader(None).observe(frame)['lethal'] is None


@pytest.mark.parametrize('file,other,expected', [
    ('safe.png', 'cracked.png', False), ('cracked.png', 'safe.png', True),
])
def test_top_trophy_pixels_cannot_supply_bottom_crown_answer(file, other, expected):
    frame, alternate = bili(file), bili(other)
    frame[195:214, 88:109] = alternate[195:214, 88:109]
    assert ClockReader(None).observe(frame)['lethal'] is expected


@pytest.mark.parametrize('box', [(110, 188, 60, 25), (132, 193, 6, 12)])
def test_hidden_row_or_single_cell_is_not_counted_as_dark(box):
    frame = native('m08')
    x, y, w, h = box
    frame[y:y+h, x:x+w] = 0
    assert ClockReader(None).observe(frame)['wins_remaining'] is None


@pytest.mark.parametrize('file', ['glow-3234.png', 'glow-5709.png'])
def test_real_ten_win_glow_remains_unknown(file):
    # Both are pixel-labelled10 earned/0 remaining; current single-frame colour
    # counting cannot recover through white animation. No outcome inference.
    assert ClockReader(None).observe(clock_crop(file))['wins_remaining'] is None


def test_shifted_clock_is_only_partially_supported_and_profile_cannot_force_day():
    reader = Mock()
    reader.predict.return_value = []
    result = ClockReader(reader, PROFILE).observe(clock_crop('shifted.png', (185, 440)))
    # Revised annulus scale search matches this real layout, unlike the spike.
    # Count/crown pixels agree with its preexisting labels, but unrelated profile
    # coordinates may not force the day. Actual Paddle currently abstains here.
    assert result['visible'] is True
    assert result['wins_remaining'] == 10
    assert result['lethal'] is False
    assert result['igd'] is None
    assert reader.predict.call_count == 1


def test_explicitly_unsupported_right_side_clock_stays_unknown():
    reader = Mock()
    result = ClockReader(reader, PROFILE).observe(clock_crop('shifted.png', (1400, 440)))
    assert result['visible'] is False
    assert result['igd'] is result['wins_remaining'] is result['lethal'] is None
    reader.predict.assert_not_called()


def test_no_clock_and_wrong_profile_do_not_call_ocr_or_return_zero_false_defaults():
    reader = Mock()
    frame = np.zeros((480, 852, 3), dtype=np.uint8)
    result = ClockReader(reader, PROFILE).observe(frame)
    assert result == {'visible': False, 'igd': None, 'wins_remaining': None,
                      'lethal': None, 'evidence': {}, 'clock_region': None}
    reader.predict.assert_not_called()


def test_real_no_clock_intro_returns_no_fabricated_zero_or_false():
    reader = Mock()
    frame = cv2.imread(str(ASSETS / 'fixtures/no-clock-bili152.jpg'))
    result = ClockReader(reader, PROFILE).observe(frame)
    assert result == {'visible': False, 'igd': None, 'wins_remaining': None,
                      'lethal': None, 'evidence': {}, 'clock_region': None}
    reader.predict.assert_not_called()


def test_false_is_a_supported_safe_observation_not_unknown():
    result = ClockReader(None).observe(native('m01'))
    assert result['lethal'] is False
    assert result['wins_remaining'] == 10  # Zero earned is not an absent HUD.


@pytest.mark.parametrize('frame', [None, [], np.zeros((0, 0, 3), np.uint8),
                                  np.zeros((480, 852), np.uint8),
                                  np.zeros((480, 852, 3), np.float32)])
def test_invalid_or_empty_inputs_are_unknown(frame):
    result = ClockReader(None).observe(frame)
    assert not result['visible']
    assert result['igd'] is result['wins_remaining'] is result['lethal'] is None


def test_evidence_and_clock_regions_are_bounded_source_pixels():
    frame = native('m12')
    result = ClockReader(None).observe(frame)
    assert set(result) == {'visible', 'igd', 'wins_remaining', 'lethal', 'evidence', 'clock_region'}
    assert set(result['evidence']) == {'igd', 'wins_remaining', 'lethal'}
    for region in [result['clock_region']] + [r['region'] for r in result['evidence'].values()]:
        x, y, w, h = region
        assert all(isinstance(v, int) for v in region)
        assert 0 <= x < x+w <= frame.shape[1]
        assert 0 <= y < y+h <= frame.shape[0]
    assert result['evidence']['igd']['region'][1] >= 210  # Source, not canonical y79.


@pytest.mark.parametrize('texts,scores,expected', [
    (['1'], [0.9], 1), (['11'], [0.99], 11), (['20'], [0.99], 20),
    (['0'], [0.99], None), (['21'], [0.99], None), (['011'], [0.99], None),
    (['1I'], [0.99], None), (['day11'], [0.99], None), (['١١'], [0.99], None),
    (['11'], [0.899], None), (['11'], [float('nan')], None), (['11'], [True], None),
    (['11'], [1.1], None),
    (['1', '1'], [0.99, 0.99], None), (['11', 'other'], [0.99, 0.99], None),
    (['11'], [0.99, 0.99], None), (['11', 'noise'], [0.99, 0.5], 11),
])
def test_strict_whole_day_token_from_shared_reader(texts, scores, expected):
    reader = Mock()
    reader.predict.return_value = [{'rec_texts': texts, 'rec_scores': scores}]
    assert ClockReader(reader).observe(native())['igd'] == expected


def test_profile_fallback_keeps_exact_legacy_source_crop_and_preprocessing():
    class RecordingReader:
        def __init__(self, responses):
            self.responses = iter(responses)
            self.inputs = []

        def predict(self, image, **kwargs):
            self.inputs.append(image.copy())
            return next(self.responses)

    good = [{'rec_texts': ['1'], 'rec_scores': [0.99]}]
    reader = RecordingReader([[], good])
    result = ClockReader(reader, PROFILE).observe(native())
    assert result['igd'] == 1
    assert result['evidence']['igd']['region'] == [124, 216, 12, 12]
    assert result['evidence']['igd']['method'] == 'paddle_profile_day_crop'
    # Compare to the unchanged, independently existing legacy implementation.
    from frame_processor import FrameProcessor
    legacy = FrameProcessor.__new__(FrameProcessor)
    legacy.logger = logging.getLogger('test.clock')
    legacy.reader = RecordingReader([good])
    assert legacy.extract_igd(native()[216:228, 124:136]) == 1
    np.testing.assert_array_equal(reader.inputs[-1], legacy.reader.inputs[0])


@pytest.mark.parametrize('region', [[0.8, 0.1, 0.1, 0.1], [0, 0, 1, 1],
                                    [130/852, 221/480, 1/852, 1/480]])
def test_profile_cannot_select_unrelated_or_clipped_text_region(region):
    reader = Mock()
    reader.predict.return_value = []
    result = ClockReader(reader, {'igd_crop_region': region}).observe(native())
    assert result['igd'] is None
    assert reader.predict.call_count == 1  # Only the geometry-supported glyph.


def test_hidden_day_does_not_get_reconstructed_from_safe_crown_or_wins():
    reader = Mock()
    frame = native()
    frame[210:234, 120:141] = 0
    result = ClockReader(reader, PROFILE).observe(frame)
    assert result['igd'] is None
    reader.predict.assert_not_called()


def test_ocr_error_does_not_erase_independent_wins_or_safe_crown():
    reader = Mock()
    reader.predict.side_effect = RuntimeError('reader unavailable')
    result = ClockReader(reader).observe(native())
    assert result['igd'] is None
    assert result['wins_remaining'] == 10
    assert result['lethal'] is False


def test_readonly_source_pixels_are_unchanged_and_no_temporal_state_is_carried():
    frame = native('m12')
    before = frame.copy()
    frame.setflags(write=False)
    reader = ClockReader(None)
    first = reader.observe(frame)
    assert reader.observe(np.zeros_like(frame))['wins_remaining'] is None
    assert reader.observe(frame) == first
    np.testing.assert_array_equal(frame, before)


def test_frozen_native_source_labels_and_asset_size():
    checksums = json.loads((ASSETS / 'sha256sums.json').read_text())
    actual_files = {str(p.relative_to(ASSETS)) for p in ASSETS.rglob('*')
                    if p.is_file() and p.name != 'sha256sums.json'}
    assert actual_files == set(checksums)
    for file, digest in checksums.items():
        assert hashlib.sha256((ASSETS / file).read_bytes()).hexdigest() == digest
    frozen = json.loads((ASSETS / 'labels-freeze.json').read_text())
    for file, digest in frozen['files'].items():
        assert hashlib.sha256((ASSETS / file).read_bytes()).hexdigest() == digest
    for case in NATIVE:
        assert hashlib.sha256((ASSETS / case['file']).read_bytes()).hexdigest() == case['sha256']
    negative = json.loads((ASSETS / 'fixture-provenance.json').read_text())['natural_negative']
    assert hashlib.sha256((ASSETS / negative['file']).read_bytes()).hexdigest() == negative['sha256']
    assert sum(p.stat().st_size for p in ASSETS.rglob('*') if p.is_file()) <= 2_000_000
