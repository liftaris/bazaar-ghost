"""AI-parent-reviewed natural masked-intro regression; real local shared Paddle.

Five unchanged native PNGs from one Bilibili recording, not blind held-out data.
No fake locator/name observations, CV tuning, network, paid hero calls or clock.
Synthetic state/ownership boundaries are tested separately in test_mask_sequences.
"""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from encounter_pipeline import EncounterPipeline, BufferedEncounterPipeline, detection_id
from frame_processor import FrameProcessor
from ocr_runtime import create_ocr_reader


ROOT = Path(__file__).parent / 'fixtures' / 'masked_intro'
MANIFEST = json.loads((ROOT / 'manifest.json').read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture(scope='module')
def native_processor():
    # Real FrameProcessor methods use the shared factory/NameReader lazily.
    # Avoid constructing unrelated legacy detectors; one OCR model instance.
    processor = FrameProcessor.__new__(FrameProcessor)
    processor.profile = {}
    processor.old_templates = False
    processor.ocr_confidence_threshold = .5
    processor.reader = create_ocr_reader()
    return processor


def test_native_fixture_integrity_provenance_and_saved_actual_output():
    assert MANIFEST['split'] == 'regression' and MANIFEST['previouslySeen'] is True
    assert MANIFEST['blindHeldout'] is False
    assert MANIFEST['algorithmTuningBeforeOrDuringCheck'] is False
    review = MANIFEST['labelReview']
    assert 'AI parent' in review['method'] and review['independentHuman'] is False
    assert review['reviewedBeforeModelRun'] is True
    source = MANIFEST['source']
    assert source['sourceId'] == 'BV1fUn56tEwY:42856547006'
    assert source['exactSourcePts'] is True and source['timeBase'] == '1/16000'
    assert [row['atMs'] for row in MANIFEST['frames']] == [104000,106000,108000,110000,112000]
    assert {p.name for p in ROOT.iterdir()} == {
        '104.png','106.png','108.png','110.png','112.png','manifest.json','observed-name-output.json'}
    for row in MANIFEST['frames']:
        data = (ROOT / row['file']).read_bytes()
        assert digest(data) == row['sha256'] == row['originalSha256']
        assert len(data) == row['bytes'] and data.startswith(b'\x89PNG\r\n\x1a\n')
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        assert [image.shape[1],image.shape[0]] == row['dimensions'] == [852,480]
        assert round((row['sourcePts']/16000-source['sourceOriginPtsSeconds'])*1000) == row['atMs']
        assert abs(row['sourcePts']/16000-row['sourcePtsSeconds']) < 1e-9
    saved_metadata = MANIFEST['observedOutput']
    saved_bytes = (ROOT / saved_metadata['file']).read_bytes()
    assert digest(saved_bytes) == saved_metadata['sha256']
    saved = json.loads(saved_bytes)
    assert saved['modelInstances'] == 1 and saved['network'] == 'none'
    assert saved['flushEmissionCount'] == 1 and saved['secondFlush'] == []
    assert [row['at_ms'] for row in saved['reads']] == MANIFEST['labels']['positiveAtMs']
    for row in saved['reads']:
        assert row['name']['name_state'] == 'masked' and row['name']['username'] is None
        raw = json.loads(row['name']['raw_text'])
        assert raw['mask'][0][0] == '******' and raw['mask'][0][1] >= .90
    assert saved['event']['name_state'] == 'masked'
    assert saved['event']['username'] is None and saved['event']['confidence'] is None


@pytest.mark.parametrize('pipeline_type', [EncounterPipeline, BufferedEncounterPipeline])
def test_real_shared_paddle_masked_intro_emits_one_source_proven_encounter(native_processor, pipeline_type):
    observed_reads, observed_locations = [], []
    current_ms = None

    def locate(frame):
        result = native_processor.locate_full_frame(frame)
        observed_locations.append((current_ms,result))
        return result

    def read(frame, location):
        result = native_processor.read_full_name(frame,location)
        observed_reads.append((current_ms,result))
        return result

    # Real bound locator and reader calls, not mocks. Omit optional `reader`
    # capability to prevent unrelated day-interstitial OCR on the two neighbors.
    processor = SimpleNamespace(locate_full_frame=locate,read_full_name=read)
    source, span, labels = MANIFEST['source'],MANIFEST['span'],MANIFEST['labels']
    pipeline = pipeline_type(processor,recording=source['recordingIdentity'],
        vod_id=source['sourceId'],chunk_id='natural-masked-intro-regression',
        start_ms=span['startMs'],end_ms=span['endMsExclusive'],clock=None)
    pixels = {}
    for row in MANIFEST['frames']:
        current_ms = row['atMs']
        pixels[current_ms] = (ROOT / row['file']).read_bytes()
        # Actual packaged imdecode supports PNG bytes without altering pixels;
        # internal transport field names remain `jpeg`, but content is native PNG.
        assert pipeline.consume(pixels[current_ms],current_ms) == []
    events = pipeline.flush()
    assert pipeline.flush() == []
    assert len(events) == labels['emissionsAfterFlush'] == 1
    assert [at for at,location in observed_locations if location] == labels['positiveAtMs']
    assert [at for at,_ in observed_reads] == labels['positiveAtMs']
    for at,result in observed_reads:
        assert result['name_state'] == 'masked' and result['username'] is None
        assert result['method'] == 'mask-binary65-linear4x-english-ocr'
        raw = json.loads(result['raw_text'])
        assert len(raw['mask']) == 1 and raw['mask'][0][0] == labels['visibleMask'] == '******'
        assert result['confidence'] == raw['mask'][0][1] >= .90
    event = events[0]
    assert event['schema_version'] == 2 and event['is_matchup'] is True
    assert event['recording_identity'] == source['recordingIdentity']
    assert event['vod_id'] == source['sourceId']
    assert event['anchor_ms'] == labels['anchorMs'] == 106000
    assert event['timestamp'] == 106
    assert event['id'] == detection_id(source['recordingIdentity'],106000)
    assert event['detected_rank'] == labels['rank'] == 'gold'
    assert event['name_state'] == labels['nameState'] == 'masked'
    # Raw asterisks (or native OCR fragments) are evidence, NEVER identity.
    assert event['username'] is labels['username'] is None
    assert event['confidence'] is labels['confidence'] is None
    assert set(event['field_evidence']) == {'encounter','rank','username'}
    for field,proof in event['field_evidence'].items():
        at = proof['at_ms']
        assert at in labels['positiveAtMs']
        assert proof['frame_sha256'] == digest(pixels[at])
        assert event['_images'][at]['jpeg'] == pixels[at]
        assert [proof['source_width'],proof['source_height']] == [852,480]
        assert proof['phase'] == 'intro'
        x,y,w,h = proof['region']
        assert 0 <= x < 852 and 0 <= y < 480 and 0 < w <= 852-x and 0 < h <= 480-y
        if field != 'username':
            assert proof['confidence'] is None  # Similarity is not field confidence.
    assert event['field_evidence']['rank']['at_ms'] == 106000
    proof = event['field_evidence']['username']
    # The crop correction changes OCR scores, not ownership or mask semantics.
    # Evidence must refer to the strongest actually observed masked source.
    assert proof['at_ms'] == max(observed_reads, key=lambda row: row[1]['confidence'])[0]
    actual = dict(observed_reads)[proof['at_ms']]
    assert proof['raw_text'] == actual['raw_text']
    assert proof['confidence'] == actual['confidence']
    assert proof['region'] == actual['region']  # Includes upper mask input context.
    assert proof['method'] == actual['method']
    for field in ('igd','wins_remaining','lethal','ghost_hero','streamer_hero'):
        assert event[field] is None and field not in event['field_evidence']
