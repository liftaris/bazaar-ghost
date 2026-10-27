"""Verify the October 27 hosted YouTube rollout against artifacts and live validation."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.request import Request
from urllib.parse import urlencode

from backend_environment import open_backend


ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://bazaarghost-validation.kaio-8df.workers.dev'
COMMIT = '130c9bd39d149384961c73a4bc85f225c4d4d81b'
RUNTIME = 'ghcr.io/liftaris/bazaar-ghost/sfde-next@sha256:44737131bd9b8526d4e2926ef4292d8fa83e9e06de1c9c67136b913e0512df51'
RECORDINGS = [('HklpcveV_4o', 310520, 40548008075), ('k3Mnp0OQ8ug', 310521, 40548009614)]


def query(sql):
    result = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'bazaarghost-validation',
                             '--remote', '--json', '--command', sql], cwd=ROOT,
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout)[0]['results']


def get(path):
    with open_backend(Request(BASE + path), timeout=30) as response:
        return json.load(response)


def verify(artifacts):
    health = get('/health')
    assert health == {'ok': True, 'environment': 'validation', 'build_commit': COMMIT}, health
    reports = []
    image_paths = set()
    for source_id, vod_id, run_id in RECORDINGS:
        vod = query(f'SELECT id,source_id,status,duration_seconds FROM vods WHERE id={vod_id}')[0]
        assert vod['source_id'] == source_id and vod['status'] == 'completed', vod
        chunks = query(f'SELECT id,status,start_seconds,end_seconds,frames_processed,detections_count '
                       f'FROM chunks WHERE vod_id={vod_id} ORDER BY start_seconds')
        assert chunks and all(c['status'] == 'completed' for c in chunks), chunks
        expected = {}
        position = 0
        samples = 0
        coverage_reports = []
        log = subprocess.check_output(['gh', 'run', 'view', str(run_id), '--log'], cwd=ROOT, text=True)
        for chunk in chunks:
            assert chunk['start_seconds'] == position, chunks
            position = chunk['end_seconds']
            paths = list(artifacts.glob(f'process-{run_id}/**/detections_{chunk["id"]}.json'))
            assert len(paths) == 1, paths
            summary = json.loads(paths[0].read_text())
            assert summary['source'] == 'youtube' and summary['vod_id'] == source_id
            assert summary['sfde_next_enabled'] is True and summary['quality'] == '480p'
            coverage = summary['decode_coverage']
            assert summary['frames_processed'] == coverage['sampled_frames'] == chunk['frames_processed']
            assert coverage['sampled_frames'] == coverage['requested_expected_frames']
            assert coverage['completion_reason'] == 'requested_range'
            assert coverage['source_gap_count'] == 0, coverage
            assert coverage['unobserved_catalog_tail_seconds'] == 0
            assert coverage['first_sample_seconds'] == chunk['start_seconds']
            assert 0 < chunk['end_seconds'] - coverage['last_sample_seconds'] <= 2
            assert summary['matchups_found'] == len(summary['detections']) == chunk['detections_count']
            resolved = [line for line in log.splitlines()
                        if f'"chunk_id": "{chunk["id"]}"' in line and 'Media resolved with' in line]
            assert resolved and all('yt-dlp (480p input)' in line for line in resolved), chunk['id']
            timing_paths = list(artifacts.glob(f'process-{run_id}/**/timing_{chunk["id"]}.json'))
            assert len(timing_paths) == 1, timing_paths
            timing = json.loads(timing_paths[0].read_text())
            assert timing['processor_revision'] == COMMIT, timing
            assert timing['runtime_image'] == RUNTIME, timing
            for detection in summary['detections']:
                assert detection['id'] not in expected
                expected[detection['id']] = detection
            samples += summary['frames_processed']
            coverage_reports.append({'chunk': chunk, 'coverage': coverage, 'timing': timing})
        assert position == vod['duration_seconds'], (position, vod)
        assert expected
        public = get('/api/v1/recordings/lookup?platform=youtube&sourceId=' + source_id)
        evidence = get(f'/api/v1/recordings/{vod_id}/detections')
        assert evidence['nextCursor'] is None
        assert {item['id'] for item in evidence['items']} == set(expected)
        assert public['matchupCount'] == len(expected)
        for item in evidence['items']:
            original = expected[item['id']]
            assert (item['at'], item['username'], item['rank'], item['encounter']['igd']) == (
                original['timestamp'], original['username'], original['rank'], original['igd'])
            assert item['encounter']['igd'] is not None
            image_paths.add(item['screenshotUrl'])
            for field in item['encounter']['fieldEvidence'].values():
                if field:
                    assert field['sourceHeight'] == 480
                    image_paths.add(field['screenshotUrl'])
        sample = evidence['items'][0]
        search = get('/api/v1/search?' + urlencode({'q': sample['username'], 'platform': 'youtube',
                                                  'recordingId': vod_id, 'limit': 10}))
        matches = [item for item in search['items'] if item['opponent']['username'] == sample['username']
                   and any(source['recording']['id'] == vod_id and source['at'] == sample['at']
                           for source in item['sources'] if source['kind'] == 'recording')]
        assert matches, search
        reports.append({'recording': vod, 'run_id': run_id, 'samples': samples,
                        'detections': len(expected), 'public_matchups': public['matchupCount'],
                        'search_matchup_id': matches[0]['id'],
                        'igd_values': [item['encounter']['igd'] for item in evidence['items']],
                        'chunks': coverage_reports})

    def image(path):
        from PIL import Image

        assert path.startswith('/detections/youtube/')
        response = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '45',
                                   '--max-filesize', '5000000', BASE + path], capture_output=True)
        if response.returncode:
            raise RuntimeError(f'Screenshot download failed: {path}: {response.stderr.decode()}')
        data = response.stdout
        assert len(data) <= 5_000_000
        with Image.open(BytesIO(data)) as decoded:
            decoded.load()
            assert decoded.format == 'JPEG' and decoded.size == (854, 480), (path, decoded.size)
        destination = artifacts / 'screenshots' / (hashlib.sha256(path.encode()).hexdigest() + '.jpg')
        destination.parent.mkdir(exist_ok=True)
        destination.write_bytes(data)
        return {'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'width': 854, 'height': 480}

    with ThreadPoolExecutor(max_workers=4) as pool:
        images = list(pool.map(image, sorted(image_paths)))
    assert get('/health') == health, 'Backend changed during verification'
    return {'health': health, 'recordings': reports, 'images': images}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', type=Path, help='Contains process-RUN_ID directories downloaded by gh run download')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.artifacts)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'recordings': len(result['recordings']),
                      'samples': sum(r['samples'] for r in result['recordings']),
                      'detections': sum(r['detections'] for r in result['recordings']),
                      'decoded_images': len(result['images'])}))
