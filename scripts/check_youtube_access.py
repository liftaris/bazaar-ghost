#!/usr/bin/env python3
"""Read-only runner preflight: official metadata and one decoded public video frame."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sfde/src'))
from extraction_errors import extraction_error, safe_error_category
from media_source import ffmpeg_input_args, resolve_media, validate_source_id


def main():
    identity = validate_source_id('youtube', os.environ['VIDEO_ID'])
    report = {'source_id': identity, 'metadata': False, 'playback': False}
    try:
        url = 'https://www.googleapis.com/youtube/v3/videos?' + urlencode({
            'part': 'snippet,contentDetails,status', 'id': identity,
            'key': os.environ['YOUTUBE_API_KEY'],
        })
        with urlopen(Request(url), timeout=30) as response:
            payload = response.read(2_000_001)
        if len(payload) > 2_000_000:
            raise ValueError('Metadata response too large')
        items = json.loads(payload).get('items', [])
        if len(items) != 1 or items[0].get('id') != identity:
            raise ValueError('Video metadata unavailable')
        report.update(metadata=True, api_duration=items[0]['contentDetails']['duration'])
    except Exception as error:
        report['metadata_error'] = safe_error_category(error)
    try:
        media = resolve_media('youtube', identity, '480p')
        result = subprocess.run([
            'ffmpeg', '-nostdin', '-nostats', '-v', 'error', '-rw_timeout', '30000000',
            *ffmpeg_input_args(media), '-i', media['url'], '-map', '0:v:0',
            '-frames:v', '1', '-an', '-vf', 'scale=854:480',
            '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ], capture_output=True, timeout=90)
        if result.returncode:
            raise extraction_error(result.stderr.decode('utf-8', errors='replace'))
        if not result.stdout.startswith(b'\xff\xd8') or not result.stdout.endswith(b'\xff\xd9'):
            raise ValueError('Decoder did not produce a frame')
        report.update(playback=True, resolver=media['resolver'])
    except Exception as error:
        report['playback_error'] = safe_error_category(error)
    # Never print extractor stderr, authenticated API URLs, or signed media URLs.
    print(json.dumps(report))
    return 0 if report['metadata'] and report['playback'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
