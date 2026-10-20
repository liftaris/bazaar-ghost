#!/usr/bin/env python3
"""Enroll creators and drain durable discovery/poll/archive jobs (explicit environment only)."""

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, Optional

from catalog_api import api, fence, runner_context
from backend_environment import verify_backend
from game_evidence import bazaar_evidence
from catalog_youtube import ensure_account as youtube_account, normalize_video, channel_page
from catalog_bilibili import ensure_account as bilibili_account, normalize_part
from media_source import youtube_metadata
from extraction_errors import safe_error_category
from bilibili_source import video_metadata
from platform_discovery import account_page, bazaar_title, bilibili_api, bilibili_candidates, discover
from platform_registry import ingestion_sources
from video_catalog import save_video


def enqueue(source: str, kind: str, identity: str, account_id: Optional[str] = None, job=None, wake=False) -> None:
    """Persist work before advancing discovery progress; fence automatic mutations."""
    api('jobs/enqueue', body={'source': source, 'kind': kind, 'source_id': identity,
                             'account_id': account_id, 'wake': wake, **fence(job)}, method='POST')


def enroll(source: str, identity: str, profile_id: Optional[int] = None,
           streamer_id: Optional[int] = None) -> Dict[str, Any]:
    """Explicit enrollment enables an account; discovery preserves operator disables."""
    if source == 'youtube':
        channel = 'https://www.youtube.com/' + identity if identity.startswith('@') else identity
        page = channel_page(channel, 1, 1, 'videos')
        if page.get('tab_absent'):
            page = channel_page(channel, 1, 1, 'streams')
        return youtube_account(page.get('channel_id') or page['id'],
                               page.get('channel') or page.get('title') or identity,
                               True, streamer_id, profile_id)
    if not identity.isascii() or not identity.isdecimal() or int(identity) <= 0:
        raise ValueError('Bilibili enrollment expects the uploader UID from space.bilibili.com/<UID>')
    owner = bilibili_api('/x/web-interface/card', {'mid': identity})['card']
    if str(owner['mid']) != identity:
        raise ValueError('Uploader identity mismatch')
    return bilibili_account(owner, True, profile_id, streamer_id)


def renew_subscription(account: Dict[str, Any], job=None) -> None:
    """The Worker owns the hub request and all callback secrets."""
    api('subscriptions/renew', body={'account_id': account['id'], **fence(job)}, method='POST')


def poll_account(job: Dict[str, Any]) -> Dict[str, Any]:
    """Catch up across bounded pages to the previous head, retaining unfinished work."""
    source = job['source']
    account = api('accounts', {'id': job['account_id']})[0]
    state = dict(job['state'])
    errors = []
    error_categories = []
    catching_up = False
    for tab in (('videos', 'streams') if source == 'youtube' else ('videos',)):
        cursor = dict(state.get(tab, {}))
        start = cursor.get('start', 1)
        try:
            page = account_page(source, account['source_id'], tab, start)
            ids, inspected = page['ids'], page['inspected']
            for identity in ids:
                enqueue(source, 'video', identity, account['id'], job=job)
            head = cursor.get('scan_head') or (ids[0] if ids else cursor.get('head'))
            previous_head = cursor.get('head')
            if previous_head and previous_head not in ids and inspected == 20:
                state[tab] = {'head': previous_head, 'scan_head': head, 'start': start + inspected}
                catching_up = True
            else:
                state[tab] = {'head': head, 'start': 1}
        except Exception as error:
            category = safe_error_category(error)
            errors.append(f'{tab}: {category}; public catalog unavailable')
            error_categories.append(category)
    if source == 'youtube':
        try:
            renew_subscription(account, job=job)
        except Exception as error:
            category = safe_error_category(error)
            errors.append(f'websub: {category}; subscription persistence failed')
            error_categories.append(category)
    delay = 900
    if errors:
        delay *= 2 ** min(max(job.get('attempts', 1) - 1, 0), 4)
    if catching_up:
        delay = 60
    return {'status': 'waiting', 'delay': delay,
            'state': state, 'error': '; '.join(errors) or None,
            'error_categories': sorted(set(error_categories))}


def verified_account(source: str, metadata: Dict[str, Any], job: Dict[str, Any]) -> Dict[str, Any]:
    """Validate the candidate's actual owner and preserve existing processing settings."""
    identity = metadata['channel_id'] if source == 'youtube' else str(metadata['owner']['mid'])
    rows = api('accounts', {'source': source, 'source_id': identity})
    if job.get('account_id') and (not rows or rows[0]['id'] != job['account_id']):
        raise ValueError('Candidate owner does not match the enrolled account')
    if rows:
        return rows[0]
    # Like Twitch discovery, new game-matching creators are enabled. An operator disable wins thereafter.
    if source == 'youtube':
        return youtube_account(identity, metadata.get('channel') or identity, True, preserve_disabled=True, job=job)
    return bilibili_account(metadata['owner'], True, None, None, preserve_disabled=True, job=job)


# Automatic ingestion skips shorter Bilibili parts (compilation clips).
BILIBILI_MIN_PART_SECONDS = 300

def ingest_video(job: Dict[str, Any]) -> Dict[str, Any]:
    """Wait for final recordings; ingest every published Bilibili part idempotently."""
    source = job['source']
    metadata = youtube_metadata(job['source_id']) if source == 'youtube' else video_metadata(job['source_id'])
    if source == 'youtube':
        evidence = bazaar_evidence(metadata.get('title') or '', metadata.get('tags') or [])
    else:
        evidence = bazaar_title(metadata.get('title') or '') or any(
            bazaar_title(p.get('part') or '') for p in metadata['pages'])
    if not evidence:
        return {'status': 'skipped', 'state': {'reason': 'No Bazaar title/tag evidence'}}
    account = verified_account(source, metadata, job)
    attached = api('jobs/attach-account', body={'id': job['id'], 'token': job['lease_token'],
                                               'account_id': account['id']}, method='POST')
    if attached is not True:
        raise RuntimeError('Ingestion lease no longer owns the candidate')
    if not account['processing_enabled']:
        return {'status': 'skipped', 'state': {'reason': 'Account disabled'}}
    if source == 'youtube' and (metadata.get('live_status') in ('is_live', 'is_upcoming', 'post_live') or metadata.get('is_live')):
        return {'status': 'waiting', 'delay': 900, 'state': {'archive_state': metadata.get('live_status')}}
    if source == 'youtube':
        videos = [normalize_video(metadata)]
        continuation = None
    else:
        seen = set(job['state'].get('seen_cids', []))
        remaining = [p for p in metadata['pages'] if str(p['cid']) not in seen]
        selected = remaining[:20]
        bazaar = [p for p in selected if bazaar_title(metadata.get('title') or '') or bazaar_title(p.get('part') or '')]
        # Short compilation clips rarely show a matchup but each costs an OCR run.
        # They still count as seen; the manual catalog CLI can add one explicitly.
        videos = [normalize_part(metadata, str(p['cid'])) for p in bazaar if p['duration'] >= BILIBILI_MIN_PART_SECONDS]
        short = len(bazaar) - len(videos)
        continuation = sorted(seen | {str(p['cid']) for p in selected}) if len(remaining) > len(selected) else None
        if not videos and continuation is None and short:
            return {'status': 'skipped', 'state': {'reason': f'All Bazaar parts are shorter than {BILIBILI_MIN_PART_SECONDS} s',
                                                   'short_parts': short}}
    ids = [save_video(video, account, job=job)['id'] for video in videos]
    return {'status': 'waiting' if continuation is not None else 'completed', 'delay': 60,
            'state': {'seen_cids': continuation} if continuation is not None else {}, 'vod_ids': ids}


def handle_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """Process one lease. Transport/media failures retry without losing the candidate."""
    if job['kind'] == 'account':
        return poll_account(job)
    if job['kind'] == 'discovery':
        if job['source'] == 'bilibili':
            ids, state = bilibili_candidates(job.get('state') or {})
        else:
            ids = discover(job['source'])
            state = {'candidates': len(ids)}
        # Candidates persist before the returned high-water mark is committed.
        for identity in ids:
            enqueue(job['source'], 'video', identity, job=job)
        return {'status': 'waiting', 'delay': 21600, 'state': state}
    return ingest_video(job)


def dispatch_pending(limit: int, dry_run: bool = False) -> int:
    """Dispatch only to the environment independently verified by the runner."""
    environment = verify_backend()
    result = api('dispatch', body={'limit': limit, 'dry_run': dry_run,
                                  'expected_environment': environment}, method='POST')
    return result['dispatched']


# Provider rejections and network failures that a later attempt usually clears.
# They stay errors once a job has failed this many consecutive attempts.
TRANSIENT_CATEGORIES = frozenset({'http_412', 'http_429', 'provider_feed_rejected', 'transport_timeout', 'transport_failure'})
PERSISTENT_ATTEMPTS = 3


def transient_failure(job: Dict[str, Any], result: Dict[str, Any], finished: bool) -> bool:
    """A retryable provider blip on a job that kept its lease and has not failed repeatedly."""
    categories = set(result.get('error_categories') or [])
    return (bool(result.get('error')) and finished and bool(categories) and categories <= TRANSIENT_CATEGORIES
            and job.get('attempts', 1) < PERSISTENT_ATTEMPTS)


def run(limit: int, seconds: int, discovery: bool = True, dispatch: bool = False,
        initialize_discovery: bool = True) -> Dict[str, Any]:
    """Drain bounded work and report partial failures while preserving durable retries."""
    context = runner_context()
    if context and (initialize_discovery or not discovery):
        raise ValueError('Automatic ingestion requires existing-work mode')
    if discovery and initialize_discovery:
        for source in ingestion_sources():
            enqueue(source, 'discovery', 'bazaar')
    deadline = time.monotonic() + seconds
    summary = {'jobs': 0, 'errors': 0, 'warnings': 0, 'cataloged': 0, 'dispatched': 0}
    while summary['jobs'] < limit and time.monotonic() < deadline:
        jobs = api('jobs/claim', body={'include_discovery': discovery, **context}, method='POST')
        if not jobs:
            break
        job = jobs[0]
        try:
            result = handle_job(job)
        except Exception as error:
            # Only finite categories cross the boundary; upstream exceptions may contain credentials.
            category = safe_error_category(error)
            result = {'status': 'waiting', 'delay': min(21600, 300 * 2 ** min(job['attempts'], 6)),
                      'state': job['state'], 'error': category + ': ingestion failed; retry scheduled',
                      'error_categories': [category]}
        finished = api('jobs/finish', body={'id': job['id'], 'token': job['lease_token'],
                       'status': result['status'], 'delay_seconds': result.get('delay', 900),
                       'error': result.get('error'), 'state': result.get('state', {})}, method='POST')
        transient = transient_failure(job, result, bool(finished))
        summary['jobs'] += 1
        summary['warnings'] += int(transient)
        summary['errors'] += int(not transient and (bool(result.get('error')) or not finished))
        summary['cataloged'] += len(result.get('vod_ids', []))
        print(json.dumps({'job_id': job['id'], 'source': job['source'], 'kind': job['kind'],
                          'status': result['status'], 'error': result.get('error'),
                          'error_categories': result.get('error_categories', []), 'transient': transient,
                          'lease_finished': finished}), flush=True)
    if dispatch:
        summary['dispatched'] = dispatch_pending(3)
    # The Worker retains WebSub digest tombstones for each account's lifetime: deliveries have no signed timestamp.
    api('maintenance', body={}, method='POST')
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    add = commands.add_parser('enroll')
    add.add_argument('--source', required=True, choices=ingestion_sources())
    add.add_argument('--identity', required=True, help='YouTube UC ID/@handle/URL, or Bilibili uploader UID')
    add.add_argument('--profile-id', type=int)
    add.add_argument('--streamer-id', type=int)
    drain = commands.add_parser('run')
    drain.add_argument('--limit', type=int, default=30)
    drain.add_argument('--seconds', type=int, default=1200)
    mode = drain.add_mutually_exclusive_group()
    mode.add_argument('--no-discovery', action='store_true')
    mode.add_argument('--existing-work', action='store_true', help='Drain existing discovery/candidates without initializing discovery')
    drain.add_argument('--dispatch', action='store_true', help='Dispatch up to three due videos in the selected backend environment')
    args = parser.parse_args()
    verify_backend()
    if args.command == 'enroll':
        account = enroll(args.source, args.identity, args.profile_id, args.streamer_id)
        print(json.dumps({'account_id': account['id'], 'source': account['source'], 'source_id': account['source_id']}))
    else:
        if not 1 <= args.limit <= 100 or not 30 <= args.seconds <= 1200:
            parser.error('Use 1-100 jobs and a 30-1200 second budget')
        summary = run(args.limit, args.seconds, not args.no_discovery, args.dispatch, not args.existing_work)
        print(json.dumps(summary))
        if summary['warnings'] and os.getenv('GITHUB_ACTIONS') == 'true':
            # Visible on the run without failing it; the jobs retry with backoff. The
            # runner also parses stderr, and stdout is the run's JSONL artifact.
            print(f"::warning title=Transient provider failures::{summary['warnings']} job(s) hit a retryable "
                  'provider or network failure and will retry; see ingestion-result.jsonl', file=sys.stderr)
        if summary['errors']:
            raise SystemExit(1)


if __name__ == '__main__':
    main()
