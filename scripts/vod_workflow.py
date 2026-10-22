#!/usr/bin/env python3
"""GitHub Actions preparation and reporting; inputs are data, never shell code."""

import json
import math
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Dict, List
from urllib.parse import urlencode, urlparse
from urllib.request import Request
from uuid import UUID


sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sfde' / 'src'))
from backend_environment import open_backend, verify_backend
from media_source import resolve_media, validate_source_id
from platform_registry import platform
from renditions import select_rendition

SUPPORTED = ('360p', '480p', '720p', '1080p')


def select_quality(streams: Dict[str, Any], preferred: str, old_templates: bool) -> str:
    return select_rendition(streams, preferred, old_templates)['stream_quality']


def api(path: str, params: Dict[str, str] = None, body: Any = None, method: str = 'GET') -> Any:
    verify_backend()
    url = os.environ['BAZAARGHOST_API_URL'].rstrip('/') + '/api/processor/' + path
    if params:
        url += '?' + urlencode(params)
    key = os.environ['BAZAARGHOST_PROCESSOR_KEY']
    request = Request(url, method=method, headers={
        'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
        'Prefer': 'return=representation',
    }, data=None if body is None else json.dumps(body).encode())
    with open_backend(request, timeout=30) as response:
        data = response.read()
    return json.loads(data) if data else None


def input_chunk_ids() -> List[str]:
    ids = json.loads(os.getenv('INPUT_CHUNKS') or '[]')
    if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
        raise ValueError('chunk_uuids must be a JSON array of UUIDs')
    return list(dict.fromkeys(str(UUID(value)) for value in ids))


def get_vod() -> Dict[str, Any]:
    source_id = os.environ['VOD_ID']
    source = os.environ['VIDEO_SOURCE']
    validate_source_id(source, source_id)
    return api('vod', {'source': source, 'source_id': source_id})



def output(name: str, value: Any) -> None:
    encoded = value if isinstance(value, str) else json.dumps(value, separators=(',', ':'))
    if '\n' in encoded or '\r' in encoded:
        raise ValueError('Workflow outputs must fit on one line')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as destination:
        destination.write(f'{name}={encoded}\n')


def prepared_profile(saved: Dict[str, Any], profile: Any) -> Dict[str, Any]:
    """Only a saved operational profile can be prepared; metadata may differ.

    Compare numeric values rather than JSON spelling. The claim endpoint repeats
    this check atomically, after any concurrent operator change.
    """
    if not isinstance(saved, dict) or type(saved.get('id')) is not int or saved['id'] <= 0:
        raise ValueError('A saved SFDE profile ID is required')

    def values(profile):
        if not isinstance(profile, dict):
            raise ValueError('A saved SFDE profile is required')
        identity = profile.get('id')
        if type(identity) not in (int, float) or not math.isfinite(identity) or identity != saved['id']:
            raise ValueError('SFDE profile override must match the saved profile ID')
        result = []
        for field in ('crop_region', 'igd_crop_region'):
            region = profile.get(field)
            if field == 'igd_crop_region' and region is None:
                result.append(None)
                continue
            if (not isinstance(region, list) or len(region) != 4
                    or any(type(value) not in (int, float) or not math.isfinite(value) for value in region)):
                raise ValueError('SFDE crop must contain four finite numbers')
            result.append(tuple(region))
        edge = profile.get('custom_edge')
        if edge is not None and (type(edge) not in (int, float) or not math.isfinite(edge)):
            raise ValueError('SFDE custom edge must be a finite number')
        opaque = profile.get('opaque_edge')
        if type(opaque) is not bool:
            raise ValueError('SFDE opaque edge must be boolean')
        return (*result, edge, opaque)

    if values(profile) != values(saved):
        raise ValueError('SFDE profile override differs from saved settings; update the catalog profile first')
    # JSON may spell an equal ID as 1.0; the Python processor expects its saved
    # integer identity. Crop/edge numeric equivalence does not alter geometry.
    return {**profile, 'id': saved['id']}


def prepare() -> None:
    automatic_layout = os.getenv('SFDE_NEXT_ENABLED') == 'true'
    if automatic_layout:
        target = urlparse(os.getenv('BAZAARGHOST_API_URL', ''))
        local = target.hostname in ('localhost', '127.0.0.1', '::1', 'host.docker.internal')
        validation = target.hostname == 'bazaarghost-validation.kaio-8df.workers.dev' and target.scheme == 'https'
        if os.getenv('ENVIRONMENT') not in ('validation', 'local') or not (local or validation):
            raise ValueError('SFDE_NEXT_ENABLED requires an explicit validation/local target')
    vod = get_vod()
    if not vod['processing_enabled'] or not vod['ready_for_processing'] or vod['availability'] != 'available':
        raise ValueError('VOD is not eligible for processing')
    requested_ids = input_chunk_ids()
    params = {'vod_id': str(vod['id'])}
    if requested_ids:
        params['ids'] = json.dumps(requested_ids)
    if os.getenv('QUEUED_AT'):
        params['queued_at'] = os.environ['QUEUED_AT']
    chunks = api('chunks', params)
    ids = [chunk['id'] for chunk in chunks]
    if len(ids) > 256:
        raise ValueError('More than 256 chunks; dispatch bounded batches through process-vod')
    output('chunk_uuids', ids)
    if not ids:
        return
    # NEXT derives its layout from pixels. Do not even parse an ambient profile;
    # malformed or changed legacy settings have no bearing on automatic layout.
    profile = {} if automatic_layout else prepared_profile(
        vod['profile'], json.loads(os.environ['SFDE_PROFILE']) if os.getenv('SFDE_PROFILE') else vod['profile'])
    if os.getenv('OLD_TEMPLATES') == 'true' and not vod['old_templates']:
        raise ValueError('Requested old templates differ from the saved template era; update the catalog first')
    old = vod['old_templates']
    output('old_templates', str(old).lower())
    preferred = os.getenv('REQUESTED_QUALITY', '480p')
    if not platform(vod['source'])['capabilities']['qualitySelectable']:
        selected = '480p' if old else preferred.removesuffix('60')
        if selected not in SUPPORTED:
            raise ValueError('Unsupported processing quality')
        if os.getenv('LOCAL') != 'true':
            resolve_media(vod['source'], os.environ['VOD_ID'], selected)
    elif os.getenv('LOCAL') == 'true':
        selected = preferred
    else:
        result = subprocess.run(['streamlink', '--no-config', '--json', f'https://www.twitch.tv/videos/{os.environ["VOD_ID"]}'], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Streamlink could not fetch renditions; availability was not changed')
        streams = json.loads(result.stdout).get('streams', {})
        selected = select_quality(streams, preferred, old)
    if platform(vod['source'])['capabilities']['qualitySelectable']:
        rendition = select_rendition({selected: {}}, preferred, old)
        output('quality', rendition['quality'])
        output('stream_quality', rendition['stream_quality'])
        output('video_fps', rendition['video_fps'] if rendition['video_fps'] is not None else '')
    else:
        output('quality', selected.removesuffix('60'))
        output('stream_quality', '')
        output('video_fps', '')
    output('sfde_profile', profile)


def fail_queued() -> None:
    """Release only this dispatch's queued work; running/completed chunks retain ownership."""
    ids = input_chunk_ids()
    if not ids:
        return
    api('fail-queued', body={'ids': ids, 'queued_at': os.getenv('QUEUED_AT'), 'error': 'Workflow preparation failed'}, method='POST')


def fail_chunk() -> None:
    chunk_id = str(UUID(os.environ['CHUNK_ID']))
    api('fail-queued', body={'ids': [chunk_id], 'queued_at': os.getenv('QUEUED_AT'), 'error': 'Runner failed before claiming chunk'}, method='POST')


def summarize() -> None:
    source = Path('output') / f'detections_{os.environ["CHUNK_ID"]}.json'
    if not source.exists():
        return
    summary = json.loads(source.read_text())
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as destination:
        destination.write(f"### Chunk {summary['chunk_id']}\n\n{summary['frames_processed']} frames; {summary['matchups_found']} matchups.\n\n")
        destination.write('| Second | Username | Confidence | Rank | Day |\n|---|---|---|---|---|\n')
        for item in summary['detections']:
            name = item['username']
            if name is None:
                name = 'Masked opponent' if item.get('name_state') == 'masked' else 'Unreadable opponent'
            username = name.replace('|', '\\|').replace('\n', ' ')
            confidence = '' if item['confidence'] is None else f"{item['confidence']:.0%}"
            destination.write(f"| {item['timestamp']} | {username} | {confidence} | {item['rank']} | {item.get('igd') or ''} |\n")


def main() -> None:
    commands = {'prepare': prepare, 'fail-queued': fail_queued, 'summary': summarize, 'fail-chunk': fail_chunk}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit('Usage: vod_workflow.py prepare|fail-queued|fail-chunk|summary')
    commands[sys.argv[1]]()


if __name__ == '__main__':
    main()
