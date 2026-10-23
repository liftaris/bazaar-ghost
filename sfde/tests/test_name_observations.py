"""NEXT name observations: preserve OCR, label uncertainty, never invent text."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from frame_processor import FrameProcessor
from name_reader import NameReader, tokens
from ui_locator import UILocator


ROOT = Path(__file__).parent / 'fixtures' / 'encounters'
RECORDS = {r['id']: r for r in json.loads((ROOT / 'manifest.json').read_text())['records']}
LOCATION = {'name_region': [10, 8, 100, 24], 'complete': True, 'name_state': 'unreadable'}


def reader_with(native, mask=()):
    return SimpleNamespace(predict=Mock(side_effect=[
        [{'rec_texts': [t for t, _ in output], 'rec_scores': [c for _, c in output]}]
        for output in (native, mask)
    ]))


@pytest.mark.parametrize('text,confidence,complete,state', [
    ('Éowyn・小猫! Long.Name#42', .99, True, 'obstructed'),
    ('Éowyn・小猫!Long.Name#42', .65, True, 'complete'),
    ('Normal.Case!', .50, True, 'complete'),
    ('pArt!', .12, True, 'obstructed'),
    ('a', .0, False, 'obstructed'),
    ('ab***cd', .99, True, 'obstructed'),
    (' observed?! ', .99, False, 'obstructed'),
    ('a' * 300, .99, True, 'complete'),
])
def test_exact_native_text_survives_without_identity_gate(text, confidence, complete, state):
    native = [(text, confidence)]
    reader = reader_with(native)
    frame = np.arange(160 * 64 * 3, dtype=np.uint8).reshape(64, 160, 3)
    result = NameReader(reader).read(frame, dict(LOCATION, complete=complete))
    assert (result['username'], result['confidence'], result['name_state']) == (text, confidence, state)
    assert json.loads(result['raw_text'])['native'] == [[text, confidence]]
    # Override the shared reader's .5 recognition filter only for this call.
    assert reader.predict.call_args_list[0].kwargs == {'text_rec_score_thresh': 0.}
    assert np.array_equal(reader.predict.call_args_list[0].args[0], frame[8:32, 10:110])


def test_multi_box_native_output_preserves_every_token_and_marks_uncertainty():
    native = [('MiXeD!', .98), ('小猫..', .18), ('suffix-with-long-punctuation!?', .75)]
    result = NameReader(reader_with(native)).read(np.zeros((64, 160, 3), np.uint8), LOCATION)
    assert result['username'] == 'MiXeD!\n小猫..\nsuffix-with-long-punctuation!?'
    assert result['confidence'] == .18 and result['name_state'] == 'obstructed'
    assert json.loads(result['raw_text'])['native'] == [list(t) for t in native]


def test_name_row_retains_fragments_and_raw_chat_without_appending_chat_to_name():
    reader = SimpleNamespace(predict=Mock(side_effect=[[
        {'rec_texts': ['Main', 'Frame', 'chat overlay'], 'rec_scores': [.98,.97,.99],
         'rec_polys': [[[0,5],[35,5],[35,23],[0,23]],
                       [[38,6],[70,6],[70,24],[38,24]],
                       [[75,0],[99,0],[99,6],[75,6]]]}
    ], [{'rec_texts': [], 'rec_scores': []}]]))
    result = NameReader(reader).read(np.zeros((64,160,3),np.uint8), LOCATION)
    assert result['username'] == 'Main\nFrame'
    assert result['name_state'] == 'obstructed'
    raw = json.loads(result['raw_text'])
    assert raw['native'][-1][0] == 'chat overlay'
    assert raw['name_line_indices'] == [0,1]


def test_threshold_only_labels_obstruction_without_erasing_text():
    for threshold, state in ((.5, 'complete'), (.8, 'obstructed')):
        result = NameReader(reader_with([('Native!', .65)]), threshold).read(
            np.zeros((64, 160, 3), np.uint8), LOCATION)
        assert result['username'] == 'Native!' and result['name_state'] == state


@pytest.mark.parametrize('complete', [True, False])
def test_six_star_mask_keeps_native_and_mask_evidence_but_no_inferred_name(complete):
    native, mask = [('kokkkkk', .65)], [('******', .99)]
    reader = reader_with(native, mask)
    result = NameReader(reader).read(np.zeros((64, 160, 3), np.uint8), dict(LOCATION, complete=complete))
    assert result['username'] is None and result['name_state'] == 'masked'
    raw = json.loads(result['raw_text'])
    assert raw['native'] == [['kokkkkk', .65]] and raw['mask'] == [['******', .99]]
    assert reader.predict.call_count == 2


@pytest.mark.parametrize('confidence', [
    .8785881400108337, .8067374229431152, .5769968032836914, .6170768737792969,
])
def test_visible_six_star_masks_use_name_confidence_threshold(confidence):
    result = NameReader(reader_with([], [('******', confidence)])).read(
        np.zeros((64, 160, 3), np.uint8), LOCATION)
    assert result['name_state'] == 'masked'
    assert result['username'] is None
    assert result['confidence'] == confidence
    assert json.loads(result['raw_text'])['mask'] == [['******', confidence]]


@pytest.mark.parametrize('text,confidence,threshold', [
    ('******', .49, .5), ('******', .79, .8), ('**e***', .99, .5),
])
def test_uncertain_masks_remain_obstructed(text, confidence, threshold):
    result = NameReader(reader_with([], [(text, confidence)]), threshold).read(
        np.zeros((64, 160, 3), np.uint8), LOCATION)
    assert result['name_state'] == 'obstructed'
    assert result['username'] is None
    assert json.loads(result['raw_text'])['mask'] == [[text, confidence]]


def test_exact_source_regions_record_both_ocr_inputs_and_their_union():
    frame = np.arange(160 * 64 * 3, dtype=np.uint8).reshape(64, 160, 3)
    reader = reader_with([('Native!', .99)])
    result = NameReader(reader).read(frame, LOCATION)
    assert result['ocr_regions'] == {'native': [10, 8, 100, 24], 'mask': [20, 6, 80, 21]}
    assert result['region'] == [10, 6, 100, 26]
    assert json.loads(result['raw_text'])['regions'] == result['ocr_regions']
    enlarged = cv2.resize(frame[6:27, 20:100], None, fx=4, fy=4, interpolation=cv2.INTER_LINEAR)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)
    binary = cv2.threshold(gray, 65, 255, cv2.THRESH_BINARY)[1]
    assert np.array_equal(reader.predict.call_args_list[1].args[0], cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR))


@pytest.mark.parametrize('region', [None, [-1, 8, 10, 20], [10, 8, 0, 20], [10, 8, 151, 24]])
def test_unsupported_region_is_unknown_and_never_uses_unrelated_pixels(region):
    reader = Mock()
    result = NameReader(reader).read(np.zeros((64, 160, 3), np.uint8), dict(LOCATION, name_region=region))
    assert result['username'] is None and result['name_state'] == 'unreadable'
    reader.predict.assert_not_called()


def test_empty_incomplete_region_is_obstructed_after_actually_running_ocr():
    reader = reader_with([])
    result = NameReader(reader).read(np.zeros((64, 160, 3), np.uint8), dict(LOCATION, complete=False))
    assert reader.predict.call_count == 2
    assert result['username'] is None and result['name_state'] == 'obstructed'


def test_token_collection_does_not_silently_truncate_observations():
    native = [('x' * 300, .2)] * 17
    assert tokens(reader_with(native), np.zeros((24, 100, 3), np.uint8)) == native


def test_next_lazy_locator_does_not_accept_or_read_streamer_profiles(monkeypatch):
    factory = Mock(return_value=SimpleNamespace(locate=Mock(return_value={'observed': True})))
    monkeypatch.setattr('ui_locator.UILocator', factory)
    processor = FrameProcessor.__new__(FrameProcessor)
    processor.old_templates = False
    # Deliberately no `profile` attribute: NEXT must not consult legacy settings.
    assert processor.locate_full_frame(np.zeros((36, 64, 3), np.uint8)) == {'observed': True}
    factory.assert_called_once_with(old_templates=False)


@pytest.fixture(scope='module')
def locator():
    return UILocator()


def load(key):
    return cv2.imread(str(ROOT / RECORDS[key]['file']))


@pytest.mark.parametrize('key', ['primary360p-m16-intro', 'primary1080-m16-intro', 'boundaryA-03408'])
def test_real_missing_edge_uses_only_bounded_rank_adjacent_nameplate_strip(locator, key):
    frame = load(key)
    location = locator.locate(frame)
    assert location is not None and location['edge_score'] < .65
    assert not location['complete'] and location['name_state'] == 'obstructed'
    assert location['method'].endswith('+bounded-rank-relative-strip')
    x, y, w, h = location['name_region']
    rx, ry, rw, rh = location['rank_region']
    assert rx + rw - rh * .2 <= x <= rx + rw
    assert ry < y < y + h <= ry + rh
    assert w <= frame.shape[1] * .29 and h <= rh * .65
    reader = reader_with([('Only.observed!', .12)])
    result = NameReader(reader).read(frame, location)
    assert result['username'] == 'Only.observed!' and result['name_state'] == 'obstructed'
    assert np.array_equal(reader.predict.call_args_list[0].args[0], frame[y:y+h, x:x+w])


@pytest.mark.parametrize('key', [r['id'] for r in RECORDS.values() if r['labels']['expectedScene'] == 'not_intro'])
def test_existing_chat_card_board_and_nonintro_negatives_do_not_open_fallback(locator, key):
    assert locator.locate(load(key)) is None


@pytest.fixture(scope='module')
def native_name_reader():
    from ocr_runtime import create_ocr_reader
    return NameReader(create_ocr_reader())


@pytest.mark.parametrize('key', ['primary360p-m16-intro', 'primary1080-m16-intro'])
@pytest.mark.parametrize('partial_crop', [False, True], ids=['missing-edge', 'clipped-real-name'])
def test_real_ocr_preserves_observation_without_claiming_hidden_name_truth(locator, native_name_reader, key, partial_crop):
    frame = load(key)
    location = locator.locate(frame)
    if partial_crop:
        x, y, w, h = location['name_region']
        location = dict(location, name_region=[x, y, round(w * .45), h])
    result = native_name_reader.read(frame, location)
    native = json.loads(result['raw_text'])['native']
    observed = [(text, confidence) for text, confidence in native if text.strip()]
    assert observed, 'Expected visible text in this actual nameplate crop, not reconstructed truth'
    assert result['username'] == '\n'.join(text for text, _ in observed)
    assert result['confidence'] == min(confidence for _, confidence in observed)
    assert result['name_state'] == 'obstructed'
    assert result['ocr_regions']['native'] == location['name_region']


def test_natural_six_star_fixture_is_still_masked(locator, native_name_reader):
    frame = load('mask-00006')
    result = native_name_reader.read(frame, locator.locate(frame))
    assert result['username'] is None and result['name_state'] == 'masked'
    assert '******' in result['raw_text']


@pytest.mark.parametrize('seconds,expected', [(314, 'sakura.'), (492, 'CapMoura'),
    (772, 'wsd1050458961'), (978, 'Promotoa'), (1140, 'Zaror'), (1486, 'baolei')])
def test_existing_reviewed_ordinary_crops_keep_native_name_and_case(native_name_reader, seconds, expected):
    # Reuse already reviewed legacy crop controls; these are not layout/profile
    # configuration or freshly inferred truth for a hidden name.
    frame = cv2.imread(str(ROOT.parent / 'frames' / f'217270_{seconds}.jpg'))
    h, w = frame.shape[:2]
    trim = int(h * .24)
    result = native_name_reader.read(frame, dict(LOCATION, name_region=[0, trim, w, h - 2*trim]))
    assert (result['username'], result['name_state']) == (expected, 'complete')


@pytest.mark.parametrize('filename,expected,state', [
    ('ikarus_-1544.jpg', 'TimWolle', 'complete'),
    ('ikarus_-8686.jpg', 'Shasou19', 'complete'),
    ('layzyn-11914.jpg', 'Brockolis', 'obstructed'),
    ('layzyn-4368.jpg', 'SoloCupiu', 'obstructed'),
    ('layzyn-6548.jpg', 'akb209', 'obstructed'),
    ('loustache-2039.jpg', 'emir_2garin', 'complete'),
    ('yosi14jp-1702.jpg', 'bloddywolf', 'complete'),
])
def test_captured_validation_name_rows(locator, native_name_reader, filename, expected, state):
    # These are observed regressions, not held-out accuracy certification.
    # SoloCupiu remains the observed OCR miss; don't reconstruct SoloCupid.
    frame = cv2.imread(str(ROOT.parent / 'name-regressions' / filename))
    result = native_name_reader.read(frame, locator.locate(frame))
    assert (result['username'], result['name_state']) == (expected, state)
    if filename == 'layzyn-11914.jpg':
        raw = json.loads(result['raw_text'])
        assert len(raw['native']) > len(raw['name_line_indices'])
