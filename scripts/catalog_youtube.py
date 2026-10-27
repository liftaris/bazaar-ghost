#!/usr/bin/env python3
"""Catalog finite YouTube recordings and resumable channel backlogs.

Uses yt-dlp only for metadata. Media decoding remains Streamlink-first in SFDE.
Credentials come from the caller's explicitly selected environment, never .env.
"""

import argparse
from datetime import datetime, timezone
import json
import math
import re
import subprocess
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from catalog_api import api, fence
from backend_environment import verify_backend
from game_evidence import bazaar_evidence
from video_catalog import save_video
from media_source import youtube_id, youtube_metadata
from extraction_errors import ExtractionError, extraction_error, safe_error_category


def published_at(metadata: Dict[str, Any]) -> Optional[str]:
    """Use publication metadata, never claim this is the gameplay recording date."""
    stamp = metadata.get('timestamp')
    if isinstance(stamp, (int, float)) and math.isfinite(stamp):
        return datetime.fromtimestamp(stamp, timezone.utc).isoformat()
    date = metadata.get('upload_date')
    if date:
        return datetime.strptime(date, '%Y%m%d').replace(tzinfo=timezone.utc).isoformat()
    return None


def normalize_video(metadata: Dict[str, Any], assume_bazaar: bool = False,
                    chapters: Optional[List[int]] = None, template_version: str = 'auto',
                    recorded_at: Optional[str] = None) -> Dict[str, Any]:
    """Validate final media and gameplay evidence before creating processing work."""
    source_id = youtube_id(metadata['id'])
    if metadata.get('live_status') in ('is_live', 'is_upcoming', 'post_live') or metadata.get('is_live'):
        raise ValueError('Recording is live, scheduled, or awaiting its archive')
    duration = metadata.get('duration')
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('A finite positive duration is required')
    duration = math.ceil(duration)
    title = metadata.get('title') or ''
    tags = metadata.get('tags') or []
    is_bazaar = bazaar_evidence(title, tags)
    if not (is_bazaar or assume_bazaar or chapters):
        raise ValueError('No Bazaar title/tag evidence; supply verified ranges or --assume-bazaar')
    ranges = chapters if chapters is not None else [0, duration]
    if not ranges or len(ranges) % 2 or any(isinstance(t, bool) or not isinstance(t, int) for t in ranges):
        raise ValueError('Ranges must contain integer start/end pairs')
    for start, end in zip(ranges[::2], ranges[1::2]):
        if not 0 <= start < end <= duration:
            raise ValueError('Gameplay ranges must fit the source recording')
    if template_version not in ('auto', 'old', 'current'):
        raise ValueError('Unknown template version')
    if recorded_at is not None:
        stamp = datetime.fromisoformat(recorded_at.replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('Recording time must include a timezone')
        recorded_at = stamp.isoformat()
    return {
        'source': 'youtube', 'source_id': source_id, 'title': title,
        'duration_seconds': duration, 'published_at': published_at(metadata),
        'recorded_at': recorded_at, 'template_version': template_version,
        'content_kind': 'archive' if metadata.get('live_status') == 'was_live' else 'upload',
        'bazaar_chapters': ranges, 'availability': 'available', 'unavailable_since': None,
        'last_availability_check': datetime.now(timezone.utc).isoformat(),
        'ready_for_processing': True, 'notifications_enabled': False,
    }


def ensure_account(channel_id: str, name: str, enable: bool = False,
                   streamer_id: Optional[int] = None, profile_id: Optional[int] = None,
                   preserve_disabled: bool = False, job=None, channel=None) -> Dict[str, Any]:
    """Create an independent YouTube account; optionally link an existing creator."""
    if not re.fullmatch(r'UC[A-Za-z0-9_-]{22}', channel_id):
        raise ValueError('Expected an immutable YouTube channel ID')
    values = {'source': 'youtube', 'source_id': channel_id, 'display_name': name,
              **channel_profile(channel_id, channel)}
    if enable:
        values['processing_enabled'] = True
    if streamer_id is not None:
        values['streamer_id'] = streamer_id
    if profile_id is not None:
        values['sfde_profile_id'] = profile_id
    return api('accounts/upsert', body={**values, 'preserve_disabled': preserve_disabled, **fence(job)}, method='POST')


def channel_profile(channel_id: str, page=None) -> Dict[str, str]:
    if page is None:
        page = channel_page(channel_id, 1, 1, 'videos')
        if page.get('tab_absent'):
            page = channel_page(channel_id, 1, 1, 'streams')
    if (page.get('channel_id') or page.get('id')) != channel_id:
        raise ValueError('YouTube channel identity mismatch')
    profile = {}
    if page.get('channel'):
        profile['display_name'] = page['channel']
    handle = page.get('uploader_id')
    if isinstance(handle, str) and handle.startswith('@') and len(handle) > 1:
        profile['login'] = handle[1:]
    for thumbnail in page.get('thumbnails') or []:
        if thumbnail.get('id') == 'avatar_uncropped':
            url = urlparse(thumbnail['url'])
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                raise ValueError('Invalid YouTube channel avatar URL')
            profile['avatar_url'] = thumbnail['url']
            break
    return profile


def channel_page(channel: str, start: int, limit: int, tab: str) -> Dict[str, Any]:
    """Fetch a bounded page of uploads or archives; URLs are never arbitrary inputs."""
    if re.fullmatch(r'UC[A-Za-z0-9_-]{22}', channel):
        url = f'https://www.youtube.com/channel/{channel}/{tab}'
    else:
        parsed = urlparse(channel)
        if (parsed.scheme != 'https' or parsed.hostname not in ('www.youtube.com', 'youtube.com')
                or parsed.port or parsed.username or parsed.password):
            raise ValueError('Expected a YouTube channel URL or channel ID')
        path = parsed.path.rstrip('/')
        path = re.sub(r'/(videos|streams|shorts)$', '', path)
        if not re.fullmatch(r'/(@[\w.-]+|channel/UC[A-Za-z0-9_-]{22})', path):
            raise ValueError('Expected an @handle or /channel/ channel URL')
        url = f'https://www.youtube.com{path}/{tab}'
    try:
        response = subprocess.run(['yt-dlp', '--ignore-config', '--flat-playlist', '--dump-single-json',
                                   '--playlist-start', str(start), '--playlist-end', str(start + limit - 1),
                                   '--socket-timeout', '30', url], capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
        raise ExtractionError(safe_error_category(error)) from None
    if response.returncode:
        # yt-dlp explicitly distinguishes an absent tab from transport/access failures.
        # Upload-only or archive-only creators are valid accounts; retry absent tabs on future polls.
        if f'This channel does not have a {tab} tab' in response.stderr:
            return {'entries': [], 'channel_id': channel if re.fullmatch(r'UC[A-Za-z0-9_-]{22}', channel) else None,
                    'tab_absent': True}
        raise extraction_error(response.stderr)
    try:
        page = json.loads(response.stdout)
    except json.JSONDecodeError:
        raise ExtractionError('invalid_response') from None
    if not isinstance(page, dict):
        raise ExtractionError('invalid_response')
    return page


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--video', action='append', help='YouTube URL/ID; repeat for a small batch')
    group.add_argument('--channel', help='Channel ID or @handle URL; bounded page')
    group.add_argument('--account', help='Existing platform account UUID, for resumable backfills')
    parser.add_argument('--tab', choices=('videos', 'streams'), default='videos')
    parser.add_argument('--mode', choices=('recent', 'backfill'), default='recent')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--enable-processing', action='store_true')
    parser.add_argument('--streamer-id', type=int)
    parser.add_argument('--profile-id', type=int)
    parser.add_argument('--assume-bazaar', action='store_true')
    parser.add_argument('--ranges', help='Verified source-second ranges, e.g. [0,1800]')
    parser.add_argument('--templates', choices=('auto', 'old', 'current'), default='auto')
    parser.add_argument('--recorded-at')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.limit <= 50:
        parser.error('--limit must be between 1 and 50')
    if args.video and len(args.video) > 50:
        parser.error('At most 50 explicit videos per run')
    if not args.dry_run or args.account:
        verify_backend()
    ranges = json.loads(args.ranges) if args.ranges else None
    account = None
    start = 1
    page = None
    if args.account:
        rows = api('accounts', {'id': args.account, 'source': 'youtube'})
        if not rows:
            parser.error('YouTube account not found')
        account = rows[0]
        args.channel = account['source_id']
        if args.mode == 'backfill':
            start = account['archive_cursor' if args.tab == 'streams' else 'catalog_cursor']
    if args.channel:
        page = channel_page(args.channel, start, args.limit, args.tab)
        ids = [entry['id'] for entry in page.get('entries', []) if entry and entry.get('id')]
    else:
        ids = [youtube_id(value) for value in args.video]
    inspected = len(page.get('entries', [])) if page is not None else len(ids)
    result = {'cataloged': [], 'skipped': [], 'next_cursor': start + inspected, 'exhausted': inspected < args.limit}
    for source_id in dict.fromkeys(ids):
        metadata = youtube_metadata(source_id)
        try:
            video = normalize_video(metadata, args.assume_bazaar, ranges, args.templates, args.recorded_at)
        except ValueError as error:
            result['skipped'].append({'source_id': source_id, 'reason': str(error)})
            continue
        if not args.dry_run:
            account = ensure_account(metadata['channel_id'], metadata.get('channel') or metadata['channel_id'],
                                     args.enable_processing, args.streamer_id, args.profile_id, channel=page)
            saved = save_video(video, account, explicit_ranges=ranges is not None)
            result['cataloged'].append({'id': saved['id'], 'source_id': source_id, 'title': video['title']})
        else:
            result['cataloged'].append(video)
    # Advance only after the whole page persisted; failures leave the cursor untouched.
    if account and page and not args.dry_run:
        values = {'last_cataloged_at': datetime.now(timezone.utc).isoformat()}
        if args.mode == 'backfill':
            values['archive_cursor' if args.tab == 'streams' else 'catalog_cursor'] = result['next_cursor']
        api(f'accounts/{account["id"]}', body=values, method='PATCH')
        result['account_id'] = account['id']
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
