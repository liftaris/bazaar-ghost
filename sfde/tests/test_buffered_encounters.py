"""Production scheduling: bounded pre-fight pixels, owned anchors and cooldown."""
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from encounter_pipeline import BufferedEncounterPipeline
from test_next_processor import LOCATION, image, name, clock
from ui_locator import UILocator


def make_pipeline(start=0):
    processor = SimpleNamespace(locate_full_frame=Mock(return_value=None),
                                read_full_name=Mock(return_value=name('Observed.Name', 'complete', .99)))
    reader = SimpleNamespace(observe=Mock(return_value=clock(day=7, wins=3)))
    p = BufferedEncounterPipeline(processor, recording='twitch:recording', vod_id='vod',
                                  chunk_id='chunk', start_ms=start, end_ms=240000, clock=reader)
    return p


def feed(p, at, intro=False):
    p.processor.locate_full_frame.return_value = LOCATION if intro else None
    return p.consume(image(), at)


def test_idle_frames_do_not_read_clock_and_keep_only_bounded_raw_evidence():
    p = make_pipeline()
    for at in range(0, 100000, 2000):
        assert feed(p, at) == []
    p.clock.observe.assert_not_called()
    assert len(p.pending_frames) == 4
    assert [t for _, t in p.pending_frames] == [92000, 94000, 96000, 98000]
    feed(p, 100000, True)
    event = p.flush()[0]
    assert event['timestamp'] == 100 and event['igd'] == 7 and event['wins_remaining'] == 3
    assert event['field_evidence']['igd']['at_ms'] == 98000
    assert event['field_evidence']['igd']['phase'] == 'pre_fight'
    assert event['_images'][98000]['jpeg'] == image()
    assert p.clock.observe.call_count == 5
    assert not p.pending_frames


def test_cooldown_finishes_evidence_then_resumes_90s_from_anchor_and_reads_next_fight():
    p = make_pipeline()
    for t in range(0, 10000, 2000):
        feed(p, t)
    feed(p, 10000, True)
    feed(p, 12000, True)
    for t in range(14000, 42000, 2000):
        feed(p, t)
    events = feed(p, 42000)
    assert [e['anchor_ms'] for e in events] == [10000]
    before = p.processor.locate_full_frame.call_count, p.clock.observe.call_count
    for t in range(44000, 100000, 2000):
        assert feed(p, t) == []
    assert (p.processor.locate_full_frame.call_count, p.clock.observe.call_count) == before
    assert p.stats['cooldown_samples'] == 29
    for t in range(100000, 120000, 2000):
        feed(p, t)
    p.clock.observe.return_value = clock(day=8, wins=2)
    feed(p, 120000, True)  # Real minimum observed interval: 110 seconds.
    second = p.flush()[0]
    assert second['anchor_ms'] == 120000 and second['igd'] == 8
    assert second['field_evidence']['igd']['at_ms'] == 118000
    assert p.resume_ms == 210000


def test_new_chunk_does_not_inherit_cooldown_or_claim_preroll_intro():
    p = make_pipeline(start=10000)
    feed(p, 8000, True)
    feed(p, 10000, True)
    assert p.active is None and p.resume_ms == 0
    feed(p, 12000)
    feed(p, 14000)
    feed(p, 16000, True)
    assert p.flush()[0]['anchor_ms'] == 16000


def test_gap_does_not_turn_stale_buffer_into_prefight_evidence():
    p = make_pipeline()
    feed(p, 0)
    feed(p, 2000)
    feed(p, 20000, True)
    result = p.flush()[0]
    assert 'igd' not in result['field_evidence']
    assert p.stats['buffer_replays'] == 0


def test_monotonic_timestamp_validation_still_runs_during_cooldown():
    p = make_pipeline()
    feed(p, 0, True)
    feed(p, 32000)
    with pytest.raises(ValueError, match='strictly advance'):
        feed(p, 32000)


@pytest.mark.parametrize('old', [False, True])
def test_known_template_era_has_five_rank_searches_and_native_geometry(old):
    locator = UILocator(old_templates=old)
    assert len(locator.bank) == 5
    frame = np.zeros((480, 896, 3), np.uint8)
    rank, template, mask, filename, scale = locator.bank[2]
    h, w = template.shape[:2]
    frame[350:350+h, 573:573+w] = template
    location = locator.locate(frame)
    assert location is not None and location['rank'] == rank
    assert location['rank_region'] == [573, 350, w, h]
    assert location['template'] == filename and filename.startswith('_') == old
    assert locator.locate(np.zeros_like(frame)) is None


@pytest.mark.parametrize('timestamp,rank', [(226, None), (230, 'diamond'), (390, 'diamond'), (550, 'silver')])
def test_real_896x480_fights_are_not_rejected_before_search(timestamp, rank):
    frame = cv2.imread(str(Path(__file__).parent / 'fixtures' / 'native-wide' / f'swordlless-{timestamp}.jpg'))
    assert frame.shape[:2] == (480, 896)
    found = UILocator().locate(frame)
    if rank is None:
        assert found is None
    else:
        assert found is not None and found['rank'] == rank
        x, y, w, h = found['rank_region']
        assert 0 <= x < x+w <= 896 and 0 <= y < y+h <= 480
