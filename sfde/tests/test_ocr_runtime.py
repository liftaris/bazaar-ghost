"""PaddleOCR upgrade contracts: CPU settings, cached models and v3 results."""

from importlib.metadata import version
import base64
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from frame_processor import FrameProcessor
from ocr_runtime import create_ocr_reader


@pytest.mark.parametrize('threshold', [0.5, 0.8])
def test_cache_and_frame_processor_share_explicit_cpu_models(monkeypatch, threshold):
    constructor = Mock()
    monkeypatch.setitem(sys.modules, 'paddleocr', SimpleNamespace(PaddleOCR=constructor))
    processor = FrameProcessor({
        'emblem_detection': {'enabled': False},
        'right_edge_detection': {'enabled': False},
        'ocr': {'confidence_threshold': threshold},
    })
    assert processor.reader is constructor.return_value
    constructor.assert_called_once_with(
        text_detection_model_name='PP-OCRv5_mobile_det',
        text_recognition_model_name='en_PP-OCRv5_mobile_rec',
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device='cpu',
        cpu_threads=1,
        enable_mkldnn=False,
        text_rec_score_thresh=threshold,
    )


def test_v3_json_results_preserve_best_name_confidence_and_debug_polygons():
    processor = FrameProcessor.__new__(FrameProcessor)
    processor.logger = logging.getLogger('test.ocr')
    processor.streamer = 'test'
    processor.quality = '480p'
    processor.ocr_confidence_threshold = 0.5
    polygons = np.array([[[0, 0], [20, 0], [20, 10], [0, 10]]] * 2)
    processor.reader = Mock()
    processor.reader.predict.return_value = [SimpleNamespace(json={'res': {
        'rec_texts': ['noise', 'Name_1.-'],
        'rec_scores': [0.6, 0.95],
        'rec_polys': polygons,
    }})]
    crop = np.zeros((32, 128, 3), dtype=np.uint8)
    name, score, debug = processor._extract_usernames(crop)
    assert name == 'Name_1.-'
    assert score == 0.95
    assert debug['detections'][1] == {
        'text': 'Name_1.-', 'confidence': 0.95, 'bbox': polygons[1].tolist(),
    }
    assert processor.reader.predict.call_args.args[0] is crop


def test_installed_ocr_stack_matches_tested_pins():
    requirements = (Path(__file__).resolve().parent.parent / 'requirements.txt').read_text()
    for name, pin in [('paddleocr', '3.7.0'), ('paddlepaddle', '3.3.1'), ('paddlex', '3.7.2')]:
        requirement_name = 'paddlex[ocr-core]' if name == 'paddlex' else name
        assert f'{requirement_name}=={pin}' in requirements
        assert version(name) == pin


@pytest.fixture(scope='module')
def native_reader():
    return create_ocr_reader()


def test_cached_mobile_models_run_numpy_prediction_and_v3_result_access(native_reader):
    # This runs in the network-disabled test container. Missing model caches or
    # a Paddle executor incompatibility must fail, not skip or be mocked away.
    results = native_reader.predict(np.zeros((64, 256, 3), dtype=np.uint8))
    assert len(results) == 1
    assert results[0].get('rec_texts') == []
    assert results[0].json['res']['rec_texts'] == []


@pytest.mark.parametrize('key,expected_name,custom_edge', [
    ('217270/314.jpg', 'sakura.', None),
    ('183785/10066.jpg', 'Lillend', 0.6995),
    ('190442/10294.jpg', 'Etian', None),
])
def test_native_low_resolution_names_keep_source_timestamp_and_screenshot(
    monkeypatch, config, native_reader, key, expected_name, custom_edge,
):
    # Clean, camera-obstructed edge and low-quality 480p inputs. Share only the
    # expensive reader, not FrameProcessor's matchup/deduplication state.
    monkeypatch.setattr('frame_processor.create_ocr_reader', lambda threshold: native_reader)
    processor = FrameProcessor(config, quality='480p', profile={'custom_edge': custom_edge})
    vod_id, filename = key.split('/')
    frame = (Path(__file__).parent / 'fixtures' / 'frames' / f'{vod_id}_{filename}').read_bytes()
    timestamp = int(filename.removesuffix('.jpg'))
    result = processor.process_frame(frame, timestamp, vod_id, 'upgrade-fixture')
    assert result is not None
    assert result['username'] == expected_name
    assert result['timestamp'] == timestamp
    assert result['vod_id'] == vod_id
    assert result['chunk_id'] == 'upgrade-fixture'
    assert result['confidence'] >= 0.9
    screenshot = cv2.imdecode(np.frombuffer(base64.b64decode(result['frame_base64']), np.uint8), cv2.IMREAD_COLOR)
    source = cv2.imdecode(np.frombuffer(frame, np.uint8), cv2.IMREAD_COLOR)
    assert screenshot.shape == source.shape
