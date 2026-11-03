import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify_youtube_rollout as rollout


class RolloutCoverageTests(unittest.TestCase):
    def test_rejects_source_gaps_despite_successful_counts_and_completion_reason(self):
        source_id, vod_id, run_id = rollout.RECORDINGS[0]
        vod = {'source_id': source_id, 'status': 'completed', 'duration_seconds': 1800}
        chunk = {'id': 'chunk', 'status': 'completed', 'start_seconds': 0, 'end_seconds': 1800,
                 'frames_processed': 900, 'detections_count': 1}
        summary = {
            'source': 'youtube', 'vod_id': source_id, 'sfde_next_enabled': True,
            'quality': '480p', 'frames_processed': 900, 'matchups_found': 1,
            'detections': [{'id': 'detection', 'timestamp': 10, 'username': 'name', 'rank': 'gold', 'igd': 1}],
            'decode_coverage': {
                'sampled_frames': 900, 'requested_expected_frames': 900,
                'completion_reason': 'requested_range', 'source_gap_count': 100,
                'max_source_gap_seconds': 60, 'unobserved_catalog_tail_seconds': 0,
                'first_sample_seconds': 0, 'last_sample_seconds': 1798,
            },
        }
        health = {'ok': True, 'environment': 'validation', 'build_commit': rollout.COMMIT}
        public = {'matchupCount': 1}
        evidence = {'nextCursor': None, 'items': [{
            'id': 'detection', 'at': 10, 'username': 'name', 'rank': 'gold', 'screenshotUrl': '/detections/youtube/test.jpg',
            'encounter': {'igd': 1, 'fieldEvidence': {}},
        }]}
        search = {'items': [{'id': 1, 'opponent': {'username': 'name'},
                            'sources': [{'kind': 'recording', 'recording': {'id': vod_id}, 'at': 10}]}]}
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory)
            target = artifacts / f'process-{run_id}'
            target.mkdir()
            (target / 'detections_chunk.json').write_text(json.dumps(summary))
            (target / 'timing_chunk.json').write_text(json.dumps({
                'processor_revision': rollout.COMMIT, 'runtime_image': rollout.RUNTIME,
            }))
            with patch.object(rollout, 'RECORDINGS', [rollout.RECORDINGS[0]]), \
                    patch.object(rollout, 'get', side_effect=[health, public, evidence, search, health]), \
                    patch.object(rollout, 'query', side_effect=[[vod], [chunk]]), \
                    patch.object(rollout.subprocess, 'check_output', return_value='"chunk_id": "chunk" Media resolved with yt-dlp (480p input)'), \
                    patch.object(rollout, 'ThreadPoolExecutor') as pool:
                pool.return_value.__enter__.return_value.map.return_value = []
                with self.assertRaisesRegex(AssertionError, "'source_gap_count': 100"):
                    rollout.verify(artifacts)


if __name__ == '__main__':
    unittest.main()
