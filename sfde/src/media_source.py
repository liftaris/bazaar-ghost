"""Platform-scoped media resolution. Streamlink is the first resolver for all sources."""

import json
import logging
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from bilibili_source import split_identity
from extraction_errors import ExtractionError, extraction_error, safe_error_category
from renditions import parse_rendition, select_rendition


logger = logging.getLogger('sfde.media')
SUPPORTED_SOURCES = ('twitch', 'youtube', 'bilibili')
QUALITY_HEIGHTS = (360, 480, 720, 1080)


def validate_source_id(source: str, source_id: str) -> str:
    """Validate an external identifier without interpreting it as a shell argument."""
    patterns = {'twitch': r'[0-9]+', 'youtube': r'[A-Za-z0-9_-]{11}',
                'bilibili': r'BV[A-Za-z0-9]{10}:[1-9][0-9]*'}
    if source not in patterns or not isinstance(source_id, str) or not re.fullmatch(patterns[source], source_id):
        raise ValueError('Expected a supported platform and valid video identifier')
    return source_id


def youtube_id(value: str) -> str:
    """Accept a YouTube ID or a known public watch URL; reject arbitrary hosts."""
    if re.fullmatch(r'[A-Za-z0-9_-]{11}', value):
        return value
    parsed = urlparse(value)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port:
        raise ValueError('Expected a YouTube HTTPS URL or video ID')
    if parsed.hostname == 'youtu.be':
        candidate = parsed.path.strip('/')
    elif parsed.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com'):
        if parsed.path == '/watch':
            candidate = parse_qs(parsed.query).get('v', [''])[0]
        else:
            parts = parsed.path.strip('/').split('/')
            candidate = parts[1] if len(parts) == 2 and parts[0] in ('live', 'shorts', 'embed') else ''
    else:
        raise ValueError('Expected a YouTube URL')
    return validate_source_id('youtube', candidate)


def watch_url(source: str, source_id: str, timestamp: Optional[int] = None) -> str:
    """Build public links from validated source identities."""
    validate_source_id(source, source_id)
    if timestamp is not None and (type(timestamp) is not int or timestamp < 0):
        raise ValueError('Timestamp must be a nonnegative integer')
    if source == 'youtube':
        return f'https://www.youtube.com/watch?v={source_id}' + (f'&t={timestamp}s' if timestamp is not None else '')
    if source == 'bilibili':
        bvid, cid = split_identity(source_id)
        return f'https://www.bilibili.com/video/{bvid}/?cid={cid}' + (f'&t={timestamp}' if timestamp is not None else '')
    return f'https://www.twitch.tv/videos/{source_id}' + (f'?t={timestamp}s' if timestamp is not None else '')


def _height(quality: str) -> int:
    match = re.fullmatch(r'(360|480|720|1080)p(?:60)?', quality)
    if not match:
        raise ValueError('Unsupported processing quality')
    return int(match[1])


def _rendition_score(height: int, fps: float, target: int,
                     prefer_high_fps: bool = False) -> Tuple[bool, int, bool]:
    # Prefer the closest rendition at or above the processing resolution.
    # FFmpeg normalizes to the requested template geometry, including old 480p.
    return (height < target, abs(height - target), fps < 50 if prefer_high_fps else fps > 30)


def _http_media(url: str, headers: Dict[str, Any], resolver: str, height: int, fps: Optional[float]) -> Dict[str, Any]:
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or '\n' in url or '\r' in url:
        raise ValueError('Resolver did not return an HTTP media URL')
    # Forward only necessary playback headers. Never log signed URLs or headers.
    safe_headers = {}
    for key, value in headers.items():
        if key.lower() in ('user-agent', 'referer', 'origin'):
            if not isinstance(value, str) or '\r' in value or '\n' in value:
                raise ValueError('Invalid media header')
            safe_headers[key] = value
    return {'url': url, 'headers': safe_headers, 'resolver': resolver, 'height': height, 'fps': fps}


def resolve_media(source: str, source_id: str, quality: str = '480p', *, stream_quality: Optional[str] = None) -> Dict[str, Any]:
    """Resolve a fresh seekable locator. Fall back to yt-dlp only for YouTube.

    Resolution does not mark a video unavailable; transient extraction failures
    must remain distinct from platform visibility. FFmpeg owns the source seek.
    """
    url = watch_url(source, source_id)
    target = _height(quality)
    failure = 'no supported renditions'
    try:
        command = ['streamlink', '--no-config', '--json']
        if source == 'bilibili':
            command.extend(['--plugin-dirs', str(Path(__file__).resolve().parents[1] / 'streamlink_plugins')])
        response = subprocess.run([*command, url],
                                  capture_output=True, text=True, timeout=90, check=False)
        if response.returncode == 0:
            streams = json.loads(response.stdout).get('streams', {})
            if source == 'twitch':
                playable = {name: stream for name, stream in streams.items()
                            if stream.get('url') and stream.get('type') in ('http', 'hls')}
                if stream_quality:
                    parse_rendition(stream_quality)
                    if stream_quality not in playable:
                        raise ValueError('Selected Twitch rendition is no longer available')
                    name = stream_quality
                else:
                    name = select_rendition(playable, quality)['stream_quality']
                height, fps = parse_rendition(name)
                stream = playable[name]
                return {**_http_media(stream['url'], stream.get('headers') or {}, 'streamlink', height, fps),
                        'stream_quality': name}
            candidates = []
            for name, stream in streams.items():
                match = re.fullmatch(r'(\d+)p(\d+)?', name)
                if match and stream.get('url') and stream.get('type') in ('http', 'hls'):
                    height, fps = int(match[1]), float(match[2] or 30)
                    candidates.append((height, fps, stream))
            if candidates:
                height, fps, stream = min(candidates, key=lambda item: _rendition_score(item[0], item[1], target, quality.endswith('60')))
                logger.info('Resolved %s video via Streamlink at %sp', source, height)
                return _http_media(stream['url'], stream.get('headers') or {}, 'streamlink', height, fps)
        failure = f'Streamlink exit code {response.returncode}'
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        failure = type(error).__name__
    if source != 'youtube' or os.getenv('YOUTUBE_ALLOW_YTDLP', 'true').lower() != 'true':
        raise RuntimeError(f'Streamlink resolution failed ({failure})')
    logger.info('Streamlink could not resolve YouTube media (%s); trying yt-dlp', failure)
    metadata = youtube_metadata(source_id)
    if metadata.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
        raise ValueError('YouTube recording is not finalized')
    candidates = [f for f in metadata.get('formats', [])
                  if f.get('url') and f.get('vcodec') not in (None, 'none')
                  and f.get('height') and f.get('protocol') in ('https', 'http', 'm3u8_native', 'm3u8')
                  and not f.get('has_drm')]
    if not candidates:
        raise RuntimeError('No supported YouTube video rendition')
    selected = min(candidates, key=lambda f: _rendition_score(f['height'], f.get('fps') or 30, target, quality.endswith('60')))
    return _http_media(selected['url'], selected.get('http_headers') or {}, 'yt-dlp',
                       selected['height'], selected.get('fps') or 30)


def extraction_failure(stderr: str) -> str:
    """Classify actionable failures without emitting upstream URLs or credentials."""
    return str(extraction_error(stderr))


def youtube_metadata(source_id: str) -> Dict[str, Any]:
    """Fetch metadata without downloading media or using ambient user configuration."""
    url = watch_url('youtube', source_id)
    try:
        response = subprocess.run(['yt-dlp', '--ignore-config', '--no-playlist', '--skip-download',
                                   '--dump-single-json', '--socket-timeout', '30', url],
                                  capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
        raise ExtractionError(safe_error_category(error)) from None
    if response.returncode:
        raise extraction_error(response.stderr)
    try:
        data = json.loads(response.stdout)
    except json.JSONDecodeError:
        raise ExtractionError('invalid_response') from None
    if not isinstance(data, dict):
        raise ExtractionError('invalid_response')
    if data.get('id') != source_id:
        raise ValueError('YouTube metadata identity mismatch')
    return data


def ffmpeg_input_args(media: Dict[str, Any]) -> List[str]:
    """Build HTTP options that must precede FFmpeg's input argument."""
    headers = ''.join(f'{key}: {value}\r\n' for key, value in media['headers'].items())
    return ['-headers', headers] if headers else []
