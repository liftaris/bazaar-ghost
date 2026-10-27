#!/usr/bin/env python3
"""Catalog bounded published Bilibili submissions, with one work timeline per cid.

A bare BV ID catalogs its parts (up to --limit). A ?p=N URL selects one part.
Use --start-part to resume a long submission; repeats are idempotent.
"""

import argparse
from datetime import datetime, timezone
import json
import math
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

from catalog_api import api, fence
from backend_environment import verify_backend
from game_evidence import bazaar_title
from bilibili_source import bilibili_input, find_part, video_metadata
from video_catalog import save_video


def normalize_part(metadata: Dict[str, Any], cid: str, assume_bazaar: bool = False,
                   ranges: Optional[List[int]] = None, templates: str = 'auto',
                   recorded_at: Optional[str] = None) -> Dict[str, Any]:
    """Keep publication time, part-relative timestamps, and gameplay date distinct."""
    part = find_part(metadata, cid)
    duration = math.ceil(part['duration'])
    title = metadata.get('title') or ''
    part_title = part.get('part') or ''
    if not (assume_bazaar or ranges or bazaar_title(title + ' ' + part_title)):
        raise ValueError('No Bazaar title evidence; supply verified ranges or --assume-bazaar')
    chapters = ranges if ranges is not None else [0, duration]
    if (not chapters or len(chapters) % 2 or any(type(t) is not int for t in chapters)
            or any(not 0 <= start < end <= duration for start, end in zip(chapters[::2], chapters[1::2]))):
        raise ValueError('Gameplay ranges must be integer pairs within this part')
    if templates not in ('auto', 'old', 'current'):
        raise ValueError('Unknown template version')
    if recorded_at is not None:
        stamp = datetime.fromisoformat(recorded_at.replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('Recording time must include a timezone')
        recorded_at = stamp.isoformat()
    return {
        'source': 'bilibili', 'source_id': f'{metadata["bvid"]}:{cid}',
        'source_video_id': metadata['bvid'], 'source_part_id': cid, 'source_part_index': part['page'],
        'title': f'{title} — P{part["page"]}: {part_title}',
        'duration_seconds': duration,
        'published_at': datetime.fromtimestamp(metadata['pubdate'], timezone.utc).isoformat(),
        'recorded_at': recorded_at, 'template_version': templates,
        'content_kind': 'archive' if '直播回放' in title else 'upload',
        'bazaar_chapters': chapters, 'availability': 'available', 'unavailable_since': None,
        'last_availability_check': datetime.now(timezone.utc).isoformat(),
        'ready_for_processing': True, 'notifications_enabled': False,
    }


def avatar_url(face: Any) -> Optional[str]:
    """Normalize public Bilibili avatar URLs; absent provider data never clears an avatar."""
    if not isinstance(face, str) or not face.strip():
        return None
    value = face.strip()
    parsed = urlsplit('https:' + value if value.startswith('//') else value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or not parsed.hostname.endswith('.hdslb.com') or parsed.username or parsed.password
            or parsed.netloc != parsed.hostname or not parsed.path.startswith('/bfs/face/')):
        raise ValueError('Invalid Bilibili avatar URL')
    return urlunsplit(('https', parsed.netloc, parsed.path, parsed.query, ''))


def ensure_account(owner: Dict[str, Any], enable: bool, profile_id: Optional[int],
                   streamer_id: Optional[int], preserve_disabled: bool = False, job=None) -> Dict[str, Any]:
    """Bilibili uploader UID is independent of any Twitch creator link."""
    source_id = str(owner['mid'])
    if not re.fullmatch(r'[1-9][0-9]*', source_id):
        raise ValueError('Invalid Bilibili uploader UID')
    values = {'source': 'bilibili', 'source_id': source_id, 'display_name': owner['name']}
    face = avatar_url(owner.get('face'))
    if face:
        values['avatar_url'] = face
    if enable:
        values['processing_enabled'] = True
    if profile_id is not None:
        values['sfde_profile_id'] = profile_id
    if streamer_id is not None:
        values['streamer_id'] = streamer_id
    return api('accounts/upsert', body={**values, 'preserve_disabled': preserve_disabled, **fence(job)}, method='POST')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', action='append', required=True)
    parser.add_argument('--limit', type=int, default=10, help='Total parts to catalog, maximum 50')
    parser.add_argument('--start-part', type=int, default=1)
    parser.add_argument('--enable-processing', action='store_true')
    parser.add_argument('--profile-id', type=int)
    parser.add_argument('--streamer-id', type=int)
    parser.add_argument('--ranges', help='Verified ranges in each selected part, e.g. [600,1500]')
    parser.add_argument('--templates', choices=('auto', 'old', 'current'), default='auto')
    parser.add_argument('--recorded-at', help='Recording start for the selected part; requires one ?p=N URL')
    parser.add_argument('--assume-bazaar', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.limit <= 50 or args.start_part < 1 or len(args.video) > 50:
        parser.error('Use positive bounds, at most 50 videos and 50 parts')
    if args.recorded_at and (len(args.video) != 1 or bilibili_input(args.video[0])[1] is None):
        parser.error('--recorded-at requires exactly one explicit ?p=N part')
    if not args.dry_run:
        verify_backend()
    ranges = json.loads(args.ranges) if args.ranges else None
    result = {'cataloged': [], 'skipped': []}
    inspected = 0
    for value in dict.fromkeys(args.video):
        bvid, position = bilibili_input(value)
        metadata = video_metadata(bvid)
        parts = [part for part in metadata['pages'] if
                 (part['page'] == position if position else part['page'] >= args.start_part)]
        if not parts:
            raise ValueError('Requested part does not exist')
        for part in parts:
            if inspected >= args.limit:
                result['resume'] = {'video': bvid, 'start_part': part['page']}
                print(json.dumps(result, indent=2, ensure_ascii=False))
                return
            inspected += 1
            try:
                video = normalize_part(metadata, str(part['cid']), args.assume_bazaar,
                                       ranges, args.templates, args.recorded_at)
            except ValueError as error:
                result['skipped'].append({'video': bvid, 'part': part['page'], 'reason': str(error)})
                continue
            if args.dry_run:
                result['cataloged'].append(video)
            else:
                account = ensure_account(metadata['owner'], args.enable_processing, args.profile_id, args.streamer_id)
                saved = save_video(video, account, explicit_ranges=ranges is not None)
                result['cataloged'].append({'id': saved['id'], 'source_id': video['source_id'], 'title': video['title']})
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
