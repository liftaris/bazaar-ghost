"""Bounded public discovery feeds; extractor failures never mean an empty feed."""

import html
import json
import re
import subprocess
from typing import Any, Dict, List, Tuple
from urllib.parse import urlencode

from catalog_youtube import channel_page, channel_profile  # also adds sfde/src to the import path
from bilibili_source import public_api
from extraction_errors import ExtractionError, extraction_error, safe_error_category


from game_evidence import bazaar_title


def extract_page(url: str, start: int = 1, limit: int = 20) -> Dict[str, Any]:
    """Call the maintained extractor with a bounded playlist and no user config."""
    try:
        result = subprocess.run([
            'yt-dlp', '--ignore-config', '--flat-playlist', '--dump-single-json',
            '--playlist-start', str(start), '--playlist-end', str(start + limit - 1),
            '--socket-timeout', '20', '--retries', '1', url,
        ], capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
        raise ExtractionError(safe_error_category(error)) from None
    if result.returncode:
        raise extraction_error(result.stderr)
    try:
        page = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise ExtractionError('invalid_response') from None
    if not isinstance(page, dict):
        raise ExtractionError('invalid_response')
    return page


def bilibili_api(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Public identity and discovery endpoints through the paced anonymous client."""
    if path not in ('/x/web-interface/search/type', '/x/web-interface/card'):
        raise ValueError('Unsupported discovery endpoint')
    referer = 'https://search.bilibili.com/' if path.endswith('/search/type') else 'https://www.bilibili.com/'
    return public_api(path, params, referer)


def _search_minutes(value: Any) -> float:
    """Search durations are 'M:SS' or 'H:MM:SS' text; unknown formats sort as zero."""
    parts = str(value).split(':')
    if not 1 < len(parts) <= 3 or not all(part.isdecimal() for part in parts):
        return 0.0
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds / 60


def bilibili_candidates(state: Dict[str, Any], pages: int = 5, minimum_minutes: float = 10.0) -> Tuple[List[str], Dict[str, Any]]:
    """Newest-first 大巴扎 search back to the previous run's newest publication time.

    Returns candidate BV IDs and the next state. The high-water mark advances
    only from inspected results, after the caller persists the candidates.
    """
    since = state.get('since') if isinstance(state.get('since'), int) else 0
    newest, ids = since, []
    for page in range(1, pages + 1):
        data = bilibili_api('/x/web-interface/search/type', {
            'search_type': 'video', 'keyword': '大巴扎', 'order': 'pubdate', 'page': page,
        })
        results = [entry for entry in data.get('result') or [] if isinstance(entry, dict)]
        for entry in results:
            published = entry.get('pubdate') if isinstance(entry.get('pubdate'), int) else 0
            newest = max(newest, published)
            title = re.sub(r'<[^>]*>', '', html.unescape(str(entry.get('title') or '')))
            if (published > since and re.fullmatch(r'BV[A-Za-z0-9]{10}', entry.get('bvid') or '')
                    and _search_minutes(entry.get('duration')) >= minimum_minutes and bazaar_title(title)):
                ids.append(entry['bvid'])
        if not results or any((entry.get('pubdate') or 0) <= since for entry in results):
            break
    return list(dict.fromkeys(ids)), {'since': newest, 'candidates': len(ids)}


def discover(source: str) -> List[str]:
    """Return recent game candidates, never invent creator identity from a name."""
    if source == 'youtube':
        query = urlencode({'search_query': 'The Bazaar', 'sp': 'CAISAhAB'})
        entries = extract_page('https://www.youtube.com/results?' + query).get('entries', [])
        return list(dict.fromkeys(e['id'] for e in entries if e and
                                 re.fullmatch(r'[A-Za-z0-9_-]{11}', e.get('id', '')) and
                                 bazaar_title(e.get('title') or '')))
    return bilibili_candidates({})[0]


def account_page(source: str, identity: str, tab: str, start: int, limit: int = 20) -> Dict[str, Any]:
    """Poll creator catalogs. Bilibili WBI/anti-bot failures remain retryable errors."""
    profile = {}
    if source == 'youtube':
        page = channel_page(identity, start, limit, tab)
        profile = channel_profile(identity, page)
        pattern = r'[A-Za-z0-9_-]{11}'
    else:
        if not re.fullmatch(r'[1-9][0-9]*', identity):
            raise ValueError('Expected an immutable Bilibili uploader UID')
        # Newest-first published submissions; positional pages align with the
        # caller's 1-based cursor. The WBI space search rejects anonymous clients.
        if (start - 1) % limit:
            raise ValueError('Bilibili uploader pages must start on a page boundary')
        data = public_api('/x/series/recArchivesByKeywords',
                          {'mid': identity, 'keywords': '', 'ps': limit, 'pn': (start - 1) // limit + 1},
                          f'https://space.bilibili.com/{identity}/video')
        page = {'entries': [{'id': entry.get('bvid')} for entry in data.get('archives') or [] if isinstance(entry, dict)]}
        pattern = r'BV[A-Za-z0-9]{10}'
    entries = page.get('entries', [])
    return {'ids': [e['id'] for e in entries if e and re.fullmatch(pattern, e.get('id', ''))],
            'inspected': len(entries), **({'profile': profile} if profile else {})}
