#!/usr/bin/env python3
"""GitHub Actions preparation and reporting; inputs are data, never shell code."""

import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Dict, List
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sfde' / 'src'))
from media_source import resolve_media, validate_source_id
from renditions import processing_quality, select_rendition


def select_quality(streams: Dict[str, Any], preferred: str, old_templates: bool) -> str:
    return select_rendition(streams, preferred, old_templates)['stream_quality']


def api(path: str, params: Dict[str, str] = None, body: Any = None, method: str = 'GET',
        prefer: str = 'return=representation') -> Any:
    url = os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1/' + path
    if params:
        url += '?' + urlencode(params)
    key = os.environ['SUPABASE_SECRET_KEY']
    request = Request(url, method=method, headers={
        'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
        'Prefer': prefer,
    }, data=None if body is None else json.dumps(body).encode())
    with urlopen(request, timeout=30) as response:
        data = response.read()
    return json.loads(data) if data else None


def input_chunk_ids() -> List[str]:
    ids = json.loads(os.getenv('INPUT_CHUNKS') or '[]')
    if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
        raise ValueError('chunk_uuids must be a JSON array of UUIDs')
    return list(dict.fromkeys(str(UUID(value)) for value in ids))


def get_vod() -> Dict[str, Any]:
    source_id = os.environ['VOD_ID']
    source = os.getenv('VIDEO_SOURCE', 'twitch')
    validate_source_id(source, source_id)
    vods = api('vod_processing_context', {
        'source': f'eq.{source}', 'source_id': f'eq.{source_id}', 'select': '*',
    })
    if len(vods) != 1:
        raise ValueError('VOD was not found')
    return vods[0]


def output(name: str, value: Any) -> None:
    encoded = value if isinstance(value, str) else json.dumps(value, separators=(',', ':'))
    if '\n' in encoded or '\r' in encoded:
        raise ValueError('Workflow outputs must fit on one line')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as destination:
        destination.write(f'{name}={encoded}\n')


def prepare() -> None:
    vod = get_vod()
    if not vod['processing_enabled'] or not vod['ready_for_processing'] or vod['availability'] != 'available':
        raise ValueError('VOD is not eligible for processing')
    requested_ids = input_chunk_ids()
    params = {'vod_id': f'eq.{vod["id"]}', 'status': 'in.(pending,queued)', 'select': 'id', 'order': 'chunk_index'}
    if requested_ids:
        params['id'] = 'in.(' + ','.join(requested_ids) + ')'
    chunks = api('chunks', params)
    ids = [chunk['id'] for chunk in chunks]
    if len(ids) > 256:
        raise ValueError('More than 256 chunks; dispatch bounded batches through process-vod')
    output('chunk_uuids', ids)
    if not ids:
        return
    profile = json.loads(os.environ['SFDE_PROFILE']) if os.getenv('SFDE_PROFILE') else vod['profile']
    if not isinstance(profile, dict) or not isinstance(profile.get('crop_region'), list):
        raise ValueError('A valid SFDE profile is required')
    old = os.getenv('OLD_TEMPLATES') == 'true' or vod['old_templates']
    output('old_templates', str(old).lower())
    preferred = os.getenv('REQUESTED_QUALITY', '480p')
    geometry = processing_quality(preferred)
    if vod['source'] in ('youtube', 'bilibili'):
        # The decoded geometry is independent of each platform's native rendition names.
        selected = {'quality': '480p' if old else geometry, 'stream_quality': '', 'video_fps': None}
        if os.getenv('LOCAL') != 'true':
            media = resolve_media(vod['source'], os.environ['VOD_ID'], selected['quality'])
            selected['video_fps'] = media['fps']
    elif os.getenv('LOCAL') == 'true':
        selected = select_rendition({preferred: {}}, preferred, old)
    else:
        result = subprocess.run(['streamlink', '--no-config', '--json', f'https://www.twitch.tv/videos/{os.environ["VOD_ID"]}'], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Streamlink could not fetch renditions; availability was not changed')
        streams = json.loads(result.stdout).get('streams', {})
        selected = select_rendition(streams, preferred, old)
    output('quality', selected['quality'])
    output('stream_quality', selected['stream_quality'])
    output('video_fps', '' if selected['video_fps'] is None else str(selected['video_fps']))
    output('sfde_profile', profile)


def fail_queued() -> None:
    """Release only this dispatch's queued work; running/completed chunks retain ownership."""
    ids = input_chunk_ids()
    if not ids:
        return
    vod = get_vod()
    api('chunks', {'vod_id': f'eq.{vod["id"]}', 'id': 'in.(' + ','.join(ids) + ')', 'status': 'eq.queued'},
        {'status': 'failed', 'last_error': 'Workflow preparation failed'}, 'PATCH')


def fail_chunk() -> None:
    chunk_id = str(UUID(os.environ['CHUNK_ID']))
    api('chunks', {'id': f'eq.{chunk_id}', 'status': 'eq.queued'},
        {'status': 'failed', 'last_error': 'Runner failed before claiming chunk'}, 'PATCH')


def summarize() -> None:
    source = Path('output') / f'detections_{os.environ["CHUNK_ID"]}.json'
    if not source.exists():
        return
    summary = json.loads(source.read_text())
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as destination:
        destination.write(f"### Chunk {summary['chunk_id']}\n\n{summary['frames_processed']} frames; {summary['matchups_found']} matchups.\n\n")
        destination.write('| Second | Username | Confidence | Rank | Day |\n|---|---|---|---|---|\n')
        for item in summary['detections']:
            username = str(item['username']).replace('|', '\\|').replace('\n', ' ')
            destination.write(f"| {item['timestamp']} | {username} | {item['confidence']:.0%} | {item['rank']} | {item.get('igd') or ''} |\n")


def main() -> None:
    commands = {'prepare': prepare, 'fail-queued': fail_queued, 'summary': summarize, 'fail-chunk': fail_chunk}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit('Usage: vod_workflow.py prepare|fail-queued|fail-chunk|summary')
    commands[sys.argv[1]]()


if __name__ == '__main__':
    main()
