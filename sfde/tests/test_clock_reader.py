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


def test_dim_bili_cells_match_previously_reviewed_pixels_after_alignment_repair():
    # The frozen label was always earned8/remaining2. The old saturated-blue
    # gate abstained; cool chroma and consistent bounded row alignment now read it.
    result = ClockReader(None).observe(bili('cracked.png'))
    assert result['visible'] is True
    assert result['wins_remaining'] == 2
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
    assert reader.predict.call_count == 2


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
                      'lethal': None, 'evidence': {}, 'clock_region': None,
                      'game_mode': None, 'tournament_wins': None, 'tournament_losses': None}
    reader.predict.assert_not_called()


def test_real_no_clock_intro_returns_no_fabricated_zero_or_false():
    reader = Mock()
    frame = cv2.imread(str(ASSETS / 'fixtures/no-clock-bili152.jpg'))
    result = ClockReader(reader, PROFILE).observe(frame)
    assert result == {'visible': False, 'igd': None, 'wins_remaining': None,
                      'lethal': None, 'evidence': {}, 'clock_region': None,
                      'game_mode': None, 'tournament_wins': None, 'tournament_losses': None}
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
    assert set(result) == {'visible', 'igd', 'wins_remaining', 'lethal', 'evidence', 'clock_region',
                           'game_mode', 'tournament_wins', 'tournament_losses'}
    assert set(result['evidence']) == {'igd', 'wins_remaining', 'lethal', 'game_mode'}
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
    reader = RecordingReader([[], [], good])
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
    assert reader.predict.call_count == 2


def test_hidden_day_does_not_get_reconstructed_from_safe_crown_or_wins():
    reader = Mock()
    reader.predict.return_value = []
    frame = native()
    frame[210:234, 120:141] = 0
    result = ClockReader(reader, PROFILE).observe(frame)
    assert result['igd'] is None
    assert reader.predict.call_count == 1


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


def preintro(case):
    frame = np.zeros((480, 852, 3), dtype=np.uint8)
    frame[180:309,80:176] = cv2.imread(str(ASSETS / 'fixtures' / f'preintro-{case}.png'))
    return frame


@pytest.mark.parametrize('case,expected', [('m10',3), ('m12',1)])
def test_actual_preintro_teal_cells_are_counted_without_day_or_phase(case, expected):
    frame = preintro(case)
    reader = ClockReader(None)
    result = reader.observe(frame)
    assert result['visible'] is True
    assert result['wins_remaining'] == expected
    assert result['igd'] is None
    assert 'phase' not in result  # Counts never claim pre-fight eligibility.
    x,y,w,h = result['evidence']['wins_remaining']['region']
    assert 80 <= x < x+w <= 176 and 180 <= y < y+h <= 309


@pytest.mark.parametrize('case', ['m10','m12'])
@pytest.mark.parametrize('kind', ['black_row','black_cell','grey_cell','blur','desaturate'])
def test_preintro_missing_blurred_or_neutral_cells_are_unknown(case, kind):
    frame = preintro(case)
    if kind == 'black_row':
        frame[188:213,110:170] = 0
    elif kind in ('black_cell','grey_cell'):
        frame[192:206,141:147] = 0 if kind == 'black_cell' else 50
    elif kind == 'blur':
        frame[183:220,103:176] = cv2.GaussianBlur(frame[183:220,103:176],(0,0),2.5)
    else:
        frame[188:213,110:170] = cv2.cvtColor(cv2.cvtColor(frame[188:213,110:170],cv2.COLOR_BGR2GRAY),cv2.COLOR_GRAY2BGR)
    assert ClockReader(None).observe(frame)['wins_remaining'] is None


def test_preintro_crop_provenance_and_labels_are_not_predicted_truth():
    source = json.loads((ASSETS / 'preintro-provenance.json').read_text())
    for case in source['cases']:
        assert hashlib.sha256((ASSETS/case['file']).read_bytes()).hexdigest() == case['sha256']
        assert len(case['reviewed_cells']) == 10
        assert case['wins_remaining'] == case['reviewed_cells'].count('D')


def test_desaturated_empty_row_is_not_assumed_ten_remaining():
    frame = native('m13')
    frame[188:213,110:170] = cv2.cvtColor(cv2.cvtColor(frame[188:213,110:170],cv2.COLOR_BGR2GRAY),cv2.COLOR_GRAY2BGR)
    assert ClockReader(None).observe(frame)['wins_remaining'] is None


# Exactly18 unique derived controls: both cases x three JPEG qualities x gray50,
# row-desaturation, and a stratified extra gray brightness (30 on m10,70 on m12).
# These are development safety regressions, not18 independent source images.
@pytest.mark.parametrize('quality', [75,90,95])
@pytest.mark.parametrize('case,kind', [
    ('m10','grey50'), ('m10','grey30'), ('m10','desaturate_row'),
    ('m12','grey50'), ('m12','grey70'), ('m12','desaturate_row'),
])
def test_jpeg_compressed_uncertain_cell_or_desaturated_row_is_unknown(case, kind, quality):
    frame = preintro(case)
    if kind.startswith('grey'):
        frame[192:206,141:147] = int(kind[4:])
    else:
        frame[188:213,110:170] = cv2.cvtColor(cv2.cvtColor(frame[188:213,110:170],cv2.COLOR_BGR2GRAY),cv2.COLOR_GRAY2BGR)
    encoded_ok, encoded = cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,quality])
    assert encoded_ok
    decoded = cv2.imdecode(encoded,cv2.IMREAD_COLOR)
    result = ClockReader(None).observe(decoded)
    assert result['visible'] is True  # Actual cell abstention, not lost locator.
    assert result['wins_remaining'] is None
    assert result['evidence']['wins_remaining']['confidence'] is None


def local_border_jpeg(case, kind):
    """The same four frozen structural sanity controls; no new source pixels."""
    frame = preintro(case)
    location = ClockReader(None)._location(frame)
    geometry = cv2.imread(str(ASSETS / 'geometry.png'))
    dark = cv2.inRange(cv2.cvtColor(geometry,cv2.COLOR_BGR2HSV),(90,65,10),(130,255,100))
    window = np.zeros_like(dark)
    window[15:65,60:185] = 255
    count, components, stats, _ = cv2.connectedComponentsWithStats(dark & window)
    ids = sorted([i for i in range(1,count) if stats[i,4] > 30],key=lambda i:stats[i,0])
    box = 2 if kind == 'half_rim' else 8
    support = cv2.dilate((components == ids[box]).astype(np.uint8),np.ones((7,7),np.uint8))
    y, x = np.nonzero(support)
    scale = location['scale']
    left = int(np.floor(location['x']+x.min()*scale))
    right = int(np.ceil(location['x']+(x.max()+1)*scale))
    top = int(np.floor(location['y']+y.min()*scale))
    bottom = int(np.ceil(location['y']+(y.max()+1)*scale))
    if kind == 'half_rim':
        left = (left+right+1)//2
    patch = frame[top:bottom,left:right]
    if kind == 'half_rim':
        patch[:] = 50
    else:
        patch[:] = np.rint(.2*patch.astype(np.float32)+.8*50).astype(np.uint8)
    ok, encoded = cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,90])
    assert ok
    return cv2.imdecode(encoded,cv2.IMREAD_COLOR), encoded


@pytest.mark.parametrize('case', ['m10','m12'])
@pytest.mark.parametrize('kind', ['half_rim','transparent_box'])
def test_existing_partial_or_transparent_local_border_jpeg_abstains(case, kind):
    frame, _ = local_border_jpeg(case,kind)
    result = ClockReader(None).observe(frame)
    assert result['visible'] is True
    assert result['wins_remaining'] is None
    assert result['evidence']['wins_remaining']['confidence'] is None
    assert result['evidence']['wins_remaining']['method'] == 'clock_cells_native_row_structure_unknown'


def bounds_frame(case):
    if case == 'native':
        return native('m12')
    if case == 'native-shifted':
        frame = native('m12')
        return cv2.warpAffine(frame,np.float32([[1,0,7],[0,1,9]]),(852,480))
    if case.startswith('preintro-'):
        return preintro(case.split('-')[1])
    if case == 'bili':
        return bili('cracked.png')
    if case == 'shifted1080':
        return clock_crop('shifted.png',(185,440))
    frame = clock_crop('geometry.png')
    if case.startswith('scale-'):
        scale = float(case.split('-')[1])
        frame = cv2.resize(frame,(round(1920*scale),round(1080*scale)))
    return frame


def contains(outer, inner):
    x,y,w,h = outer
    a,b,c,d = inner
    return x <= a and y <= b and a+c <= x+w and b+d <= y+h


@pytest.mark.parametrize('case', [
    'native','native-shifted','preintro-m10','preintro-m12','bili',
    'geometry1080','shifted1080','scale-0.6','scale-0.8','scale-1.2',
])
def test_win_evidence_contains_actual_all_offset_native_reads_and_bilinear_taps(case, monkeypatch):
    from clock_reader import _canonical

    frame = bounds_frame(case)
    reader = ClockReader(None)
    location = reader._location(frame)
    assert location is not None
    actual_reads, box_calls, quality_reads, gold_calls = [], [], [], []

    class RecordingGold(np.ndarray):
        def __getitem__(self, key):
            # Capture real source array slicing in the quality implementation,
            # not a parallel copy of the evidence-union calculation.
            if self.shape == frame.shape[:2] and isinstance(key,tuple) and len(key) == 2:
                y,x = key
                if isinstance(y,slice) and isinstance(x,slice):
                    actual_reads.append([x.start,y.start,x.stop-x.start,y.stop-y.start])
            return np.asarray(super().__getitem__(key))

    original_gold = reader._native_gold
    original_boxes = reader._box_row_structure
    original_quality = reader._wins_quality

    def gold(source):
        gold_calls.append(1)
        return original_gold(source).view(RecordingGold)

    def boxes(signal, loc, offset):
        records = original_boxes(signal,loc,offset)
        box_calls.append((tuple(offset),[r['region'] for r in records]))
        assert all('visible' not in r and 'structure_supported' in r for r in records)
        return records

    def quality(crop):
        assert np.shares_memory(crop,frame)
        address = crop.__array_interface__['data'][0] - frame.__array_interface__['data'][0]
        y, row_bytes = divmod(address,frame.strides[0])
        x = row_bytes // frame.strides[1]
        quality_reads.append([x,y,crop.shape[1],crop.shape[0]])
        return original_quality(crop)

    monkeypatch.setattr(reader,'_native_gold',gold)
    monkeypatch.setattr(reader,'_box_row_structure',boxes)
    monkeypatch.setattr(reader,'_wins_quality',quality)
    result = reader.observe(frame)
    evidence = result['evidence']['wins_remaining']['region']
    assert len(gold_calls) == 1  # Hoisted once, not25 full-frame conversions.
    assert len(box_calls) == 25 and all(len(regions) == 10 for _,regions in box_calls)
    assert {offset for offset,_ in box_calls} == {(x,y) for y in range(-2,3) for x in range(-2,3)}
    assert actual_reads == [r for _,regions in box_calls for r in regions]
    assert len(actual_reads) == 250 and len(quality_reads) == 1
    assert all(contains(evidence,r) for r in actual_reads + quality_reads)
    assert contains([0,0,frame.shape[1],frame.shape[0]],evidence)
    # Observe OpenCV's real interpolation of coordinate labels through the actual
    # canonical warp. This does not mirror the source-bound estimation helper.
    sy,sx = np.indices(frame.shape[:2],dtype=np.float32)
    coordinates = _canonical(np.dstack((sx,sy,np.ones_like(sx))),location)
    left,top,w,h = evidence
    for offset,_ in box_calls:
        dx,dy = offset
        for y,x in reader._slot_pixels:
            taps = np.floor(coordinates[y+dy,x+dx,:2]).astype(np.int32)
            assert (taps[:,0] >= left).all() and (taps[:,0]+1 < left+w).all()
            assert (taps[:,1] >= top).all() and (taps[:,1]+1 < top+h).all()


@pytest.mark.parametrize('side', ['left','top','right','bottom'])
def test_clipped_any_required_row_support_abstains_with_bounded_evidence(side, monkeypatch):
    from clock_reader import _canonical

    frame = preintro('m10')
    reader = ClockReader(None)
    location = reader._location(frame)
    details = reader._win_details(_canonical(frame,location),frame,location)
    regions = [b['region'] for a in details['alignments'] for b in a['borders']]
    source_x = min(r[0] for r in regions)
    source_y = min(r[1] for r in regions)
    source_right = max(r[0]+r[2] for r in regions)
    source_bottom = max(r[1]+r[3] for r in regions)
    clipped_location = dict(location)
    if side == 'left':
        frame = frame[:,source_x+1:]
        clipped_location['x'] -= source_x+1
    elif side == 'top':
        frame = frame[source_y+1:]
        clipped_location['y'] -= source_y+1
    elif side == 'right':
        frame = frame[:,:source_right-1]
    else:
        frame = frame[:source_bottom-1]
    # Unit-test clipping after an actual registration, without claiming that a
    # mostly cropped annulus remains detectable. No replay/phase response is faked.
    monkeypatch.setattr(reader,'_location',lambda source:clipped_location)
    structural_calls = Mock(side_effect=reader._box_row_structure)
    monkeypatch.setattr(reader,'_box_row_structure',structural_calls)
    result = reader.observe(frame)
    evidence = result['evidence']['wins_remaining']
    assert result['wins_remaining'] is None and evidence['confidence'] is None
    assert evidence['method'] == 'clock_cells_native_row_structure_unknown'
    assert contains([0,0,frame.shape[1],frame.shape[0]],evidence['region'])
    structural_calls.assert_not_called()  # No synthetic border pixels scored.
