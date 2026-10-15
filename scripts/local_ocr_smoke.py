#!/usr/bin/env python3
"""Exercise real FFmpeg/OpenCV/PaddleOCR against a running local cf backend.

Run inside the SFDE test image with this repo mounted at /repo and cwd=/app.
Seeds synthetic VODs through the local D1 CLI before invoking this script (see docs).
External services are never contacted; videos are generated from committed labeled crops.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import Request, urlopen

import cv2
import numpy as np
sys.path.insert(0, '/app/src')
from sfde import SFDEProcessor


def api(path, data=None):
    req = Request('http://127.0.0.1:8787' + path, data=None if data is None else json.dumps(data).encode(), headers={
        'Authorization': 'Bearer local-admin-change-me', 'Content-Type': 'application/json'})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def main():
    if api('/health')['environment'] != 'local':
        raise SystemExit('This smoke test only supports local cf')
    annotations = json.loads(Path('/app/tests/fixtures/annotations.json').read_text())
    fixtures = [a for a in annotations.values() if a.get('validated') and a['category'] == 'clean' and a['quality'] == '480p'][:3]
    output = Path('/tmp/bazaarghost-smoke')
    output.mkdir(exist_ok=True)
    results = []
    for i, fixture in enumerate(fixtures, 10):
        crop = cv2.imread(f"/app/tests/fixtures/frames/{fixture['vod_id']}_{fixture['filename']}")
        height, width = crop.shape[:2]
        frame = np.zeros((480, 854, 3), dtype=np.uint8)
        frame[:height, :width] = crop
        image, video = output / f'{i}.png', output / f'{i}.mp4'
        cv2.imwrite(str(image), frame)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', str(image), '-t', '12', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        profile = {'id': i, 'profile_name': f'local_ocr_smoke_{i}',
                   'crop_region': [0, 0, width / 854, height / 480],
                   'igd_crop_region': None, 'custom_edge': None, 'opaque_edge': False}
        api('/api/admin/profile', profile)
        plan = api('/functions/v1/process-vod', {'vod_id': i, 'dry_run': True})
        if len(plan['chunk_uuids']) != 1:
            raise AssertionError('Expected one fresh local fixture chunk')
        os.environ.update(BAZAARGHOST_API_URL='http://127.0.0.1:8787', BAZAARGHOST_PROCESSOR_KEY='local-processor-change-me', TEST_VIDEO=str(video),
            SFDE_PROFILE=json.dumps(profile), OLD_TEMPLATES='false')
        processor = SFDEProcessor({'chunk_id': plan['chunk_uuids'][0], 'test_mode': True})
        result = processor.process_vod_chunk()
        assert result['status'] == 'completed' and result['frames_processed'] == 6, result
        found = api('/rest/v1/rpc/fuzzy_search_detections', {'vod_source_id_filter': str(1000000000 + i)})
        assert len(found) == 1 and found[0]['username'] == fixture['username'] and found[0]['rank'] == fixture['original_rank'], found
        with urlopen('http://127.0.0.1:8787' + found[0]['storage_path']) as response:
            assert response.read(2) == b'\xff\xd8'
        results.append({'vod_id': i, 'frames': result['frames_processed'], 'username': found[0]['username'], 'rank': found[0]['rank'], 'screenshot': 'verified'})
    print('LOCAL_OCR_SMOKE=' + json.dumps(results))


if __name__ == '__main__':
    main()
