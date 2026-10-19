"""Public Bilibili submissions: stable content IDs and independent part timelines."""

import json
import math
import random
import re
import time
from typing import Any, Dict, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

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


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ExtractionError('invalid_response')


# Fixed public endpoints: minimum seconds between calls and whether the request
# carries the anonymous device cookie. Listings reject cookie-less clients
# intermittently; playback metadata is unchanged from the validated processor.
ENDPOINTS = {
    '/x/web-interface/view': (1.0, False),
    '/x/player/playurl': (1.0, False),
    '/x/web-interface/card': (2.0, True),
    '/x/web-interface/search/type': (3.0, True),
    # Hosted runners still saw HTTP 412 at 6 s; 15 s spacing never failed locally.
    '/x/series/recArchivesByKeywords': (12.0, True),
}
SPI_PATH = '/x/frontend/finger/spi'
# HTTP 412/429 and JSON risk-control/rate-limit codes are transient for an anonymous client.
RETRYABLE_HTTP = (412, 429)
RETRYABLE_CODES = (-352, -412, -509, -799)
DEVICE_ID = re.compile(r'[A-Za-z0-9+/=%_:.-]{1,200}')


class BilibiliClient:
    """Paced anonymous client: honest UA, anonymous device cookie, no login/WBI/proxy.

    One instance per process keeps the cookie and per-endpoint pacing across a
    runner's jobs. Retries are bounded; a final rejection raises a finite category.
    """

    def __init__(self, *, opener=None, clock=time.monotonic, sleep=time.sleep,
                 jitter=random.random, attempts: int = 3, backoff: float = 10.0):
        self._opener = opener or build_opener(_NoRedirect)
        self._clock, self._sleep, self._jitter = clock, sleep, jitter
        self._attempts, self._backoff = attempts, backoff
        self._last: Dict[str, float] = {}
        self._cookie: Optional[str] = None

    def _pace(self, path: str, gap: float) -> None:
        previous = self._last.get(path)
        if previous is not None:
            wait = previous + gap - self._clock()
            if wait > 0:
                self._sleep(wait)
        self._last[path] = self._clock()

    def _fetch(self, path: str, params: Dict[str, Any], referer: str, cookie: str) -> Dict[str, Any]:
        headers = {**HEADERS, 'Referer': referer, **({'Cookie': cookie} if cookie else {})}
        request = Request('https://api.bilibili.com' + path + ('?' + urlencode(params) if params else ''), headers=headers)
        with self._opener.open(request, timeout=30) as response:
            payload = response.read(2_000_001)
        if len(payload) > 2_000_000:
            raise ValueError('Bilibili metadata exceeded the response limit')
        try:
            result = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ExtractionError('invalid_response') from None
        if not isinstance(result, dict):
            raise ExtractionError('invalid_response')
        return result

    def device_cookie(self, refresh: bool = False) -> str:
        """Anonymous buvid3/buvid4 as issued to any logged-out browser."""
        if self._cookie and not refresh:
            return self._cookie
        self._pace(SPI_PATH, 2.0)
        try:
            result = self._fetch(SPI_PATH, {}, 'https://www.bilibili.com/', '')
        except (URLError, TimeoutError) as error:
            raise ExtractionError(safe_error_category(error)) from None
        data = result.get('data') if result.get('code') == 0 else None
        b3, b4 = (data or {}).get('b_3'), (data or {}).get('b_4')
        if not (isinstance(b3, str) and isinstance(b4, str) and DEVICE_ID.fullmatch(b3) and DEVICE_ID.fullmatch(b4)):
            raise ExtractionError('invalid_response')
        self._cookie = f'buvid3={b3}; buvid4={b4}; b_nut={int(time.time())}'
        return self._cookie

    def get(self, path: str, params: Dict[str, Any], referer: str = 'https://www.bilibili.com/') -> Dict[str, Any]:
        """Return the `data` object of a successful response from an allowlisted endpoint."""
        if path not in ENDPOINTS:
            raise ValueError('Unsupported Bilibili endpoint')
        gap, with_cookie = ENDPOINTS[path]
        refresh, failure = False, None
        for attempt in range(self._attempts):
            if attempt:
                self._sleep(self._backoff * 2 ** (attempt - 1) * (1 + self._jitter()))
            try:
                cookie = self.device_cookie(refresh) if with_cookie else ''
            except ExtractionError as error:
                # Report the endpoint's own rejection rather than the refresh's.
                failure, refresh = failure or error, True
                continue
            self._pace(path, gap)
            try:
                result = self._fetch(path, params, referer, cookie)
            except HTTPError as error:
                status = error.code
                error.close()
                failure = ExtractionError(f'http_{status}' if status in (403, 412, 429) else 'http_error')
                if status not in RETRYABLE_HTTP:
                    raise failure from None
            except (URLError, TimeoutError) as error:
                failure = ExtractionError(safe_error_category(error))
            else:
                code = result.get('code')
                if code == 0:
                    if not isinstance(result.get('data'), dict):
                        raise ExtractionError('invalid_response')
                    return result['data']
                failure = provider_api_error(code)
                if code not in RETRYABLE_CODES:
                    raise failure
            refresh = with_cookie
        raise failure


CLIENT = BilibiliClient()


def public_api(path: str, params: Dict[str, Any], referer: str = 'https://www.bilibili.com/') -> Dict[str, Any]:
    """Read a fixed public endpoint through the process-wide paced client."""
    return CLIENT.get(path, params, referer)


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
