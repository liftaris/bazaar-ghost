"""Public Bilibili submissions: stable content IDs and independent part timelines."""

import json
import math
import re
from typing import Any, Dict, Optional, Tuple
from urllib.error import URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from extraction_errors import ExtractionError, provider_api_error, safe_error_category


BVID_PATTERN = r'BV[A-Za-z0-9]{10}'
HEADERS = {'Referer': 'https://www.bilibili.com/', 'User-Agent': 'BazaarGhost/1.0'}


def bilibili_input(value: str) -> Tuple[str, Optional[int]]:
    """Parse a BV ID or public video URL; a URL's p selects exactly one part."""
    if re.fullmatch(BVID_PATTERN, value):
        return value, None
    parsed = urlparse(value)
    if (parsed.scheme != 'https' or parsed.hostname not in ('www.bilibili.com', 'bilibili.com')
            or parsed.username or parsed.password or parsed.port):
        raise ValueError('Expected a Bilibili HTTPS video URL or BV ID')
    match = re.fullmatch(r'/video/(' + BVID_PATTERN + r')/?', parsed.path)
    if not match:
        raise ValueError('Only published Bilibili video submissions are supported')
    position = parse_qs(parsed.query).get('p', [None])[0]
    if position is not None and not re.fullmatch(r'[1-9][0-9]*', position):
        raise ValueError('Bilibili part position must be a positive integer')
    return match[1], int(position) if position else None


def split_identity(source_id: str) -> Tuple[str, str]:
    """Stable database identity is BV:cid, never BV plus mutable part position."""
    match = re.fullmatch(r'(' + BVID_PATTERN + r'):([1-9][0-9]*)', source_id)
    if not match:
        raise ValueError('Expected Bilibili identity BV:cid')
    return match[1], match[2]


def public_api(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Read a fixed public endpoint with bounded time and response size, without credentials."""
    if path not in ('/x/web-interface/view', '/x/player/playurl'):
        raise ValueError('Unsupported Bilibili metadata endpoint')
    request = Request('https://api.bilibili.com' + path + '?' + urlencode(params), headers=HEADERS)
    try:
        with urlopen(request, timeout=30) as response:
            payload = response.read(2_000_001)
    except (URLError, TimeoutError) as error:
        raise ExtractionError(safe_error_category(error)) from None
    if len(payload) > 2_000_000:
        raise ValueError('Bilibili metadata exceeded the response limit')
    try:
        result = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ExtractionError('invalid_response') from None
    if not isinstance(result, dict):
        raise ExtractionError('invalid_response')
    if result.get('code') != 0:
        raise provider_api_error(result.get('code'))
    if not isinstance(result.get('data'), dict):
        raise ExtractionError('invalid_response')
    return result['data']


def video_metadata(bvid: str) -> Dict[str, Any]:
    """Get public submission metadata; private, paid, and interactive content is excluded."""
    if not re.fullmatch(BVID_PATTERN, bvid):
        raise ValueError('Invalid BV ID')
    data = public_api('/x/web-interface/view', {'bvid': bvid})
    if data.get('bvid') != bvid or data.get('state', 0) != 0:
        raise ValueError('Bilibili video identity or publication state is invalid')
    rights = data.get('rights') or {}
    if data.get('is_upower_exclusive') or rights.get('is_stein_gate') or rights.get('pay'):
        raise ValueError('Paid or interactive Bilibili submissions are not supported')
    if not data.get('pages') or len(data['pages']) > 1000:
        raise ValueError('Bilibili video has no bounded playable part list')
    return data


def find_part(metadata: Dict[str, Any], cid: str) -> Dict[str, Any]:
    """Resolve current display position by immutable content ID."""
    parts = [part for part in metadata['pages'] if str(part.get('cid')) == cid]
    if len(parts) != 1:
        raise ValueError('Bilibili part was removed or replaced; recatalog this submission')
    part = parts[0]
    duration = part.get('duration')
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Bilibili part requires a finite positive duration')
    return part


def _http_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in ('http', 'https') and bool(parsed.hostname)


def _mirror_rank(url: str) -> bool:
    """Akamai mirrors truncate long anonymous reads after ~1.6 MB; use them only as a last resort.

    The play API returns them as either the base or a backup URL, at random.
    """
    return (urlparse(url).hostname or '').endswith('.akamaized.net')


def video_renditions(source_id: str) -> Dict[str, Any]:
    """Return anonymous video-only DASH files, rejecting previews and partial fragments."""
    bvid, cid = split_identity(source_id)
    metadata = video_metadata(bvid)
    part = find_part(metadata, cid)
    play = public_api('/x/player/playurl', {
        'bvid': bvid, 'cid': cid, 'qn': 32, 'fnval': 4048, 'fourk': 0,
    })
    duration = play.get('timelength', 0) / 1000
    if play.get('is_preview') or abs(duration - part['duration']) > 2:
        raise ValueError('Bilibili playback is a preview or has a changed duration')
    candidates = []
    for video in (play.get('dash') or {}).get('video', []):
        # H.264 SDR is sufficient for SFDE and avoids decoder/color-space surprises.
        if not str(video.get('codecs', '')).startswith('avc') or not video.get('height'):
            continue
        urls = [video.get('baseUrl') or video.get('base_url'),
                *(video.get('backupUrl') or video.get('backup_url') or [])]
        mirrors = [url for url in urls if isinstance(url, str) and _http_url(url)]
        if not mirrors:
            continue
        candidates.append({**video, 'url': min(mirrors, key=_mirror_rank)})
    if not candidates:
        raise RuntimeError('No supported public Bilibili video rendition; legacy fragments are excluded')
    return {'videos': candidates, 'headers': HEADERS, 'part': part}
