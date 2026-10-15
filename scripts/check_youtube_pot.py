#!/usr/bin/env python3
"""Read-only live check of yt-dlp's documented PO-token provider setup."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sfde/src'))
from extraction_errors import extraction_error, safe_error_category
from media_source import ffmpeg_input_args, validate_source_id


def check(identity, clients, output):
    report = {'clients': clients, 'resolved': False, 'playback': False, 'frames': []}
    stage = 'extraction'
    try:
        result = subprocess.run([
            'yt-dlp', '--ignore-config', '--no-playlist', '--skip-download',
            '--dump-single-json', '--verbose', '--socket-timeout', '30',
            '--extractor-args', 'youtube:player_client=' + clients,
            '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
            'https://www.youtube.com/watch?v=' + identity,
        ], capture_output=True, text=True, timeout=180)
        # Never print/store verbose output: it can include locators and tokens.
        report.update(
            provider_loaded='bgutil:http-2.0.2' in result.stderr,
            token_requested='PO Token for' in result.stderr and 'via bgutil HTTP server' in result.stderr,
            token_retrieved=bool(re.search(r'Retrieved a (?:gvs|player) PO Token for', result.stderr)),
        )
        if result.returncode:
            raise extraction_error(result.stderr)
        stage = 'metadata'
        metadata = json.loads(result.stdout)
        if metadata.get('id') != identity or metadata.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
            raise ValueError('Expected the requested finalized recording')
        stage = 'formats'
        report['available_heights'] = sorted({f['height'] for f in metadata.get('formats', [])
                                               if isinstance(f.get('height'), int)})
        candidates = [f for f in metadata.get('formats', []) if f.get('url')
                      and f.get('vcodec') not in (None, 'none') and (f.get('height') or 0) >= 480
                      and f.get('protocol') in ('http', 'https', 'm3u8', 'm3u8_native') and not f.get('has_drm')]
        if not candidates:
            raise ValueError('No supported video at the processing resolution')
        selected = min(candidates, key=lambda f: (abs(f['height'] - 480), (f.get('fps') or 30) > 30))
        headers = {key: value for key, value in (selected.get('http_headers') or {}).items()
                   if key.lower() in ('user-agent', 'referer', 'origin')}
        if any(not isinstance(v, str) or '\n' in v or '\r' in v for v in headers.values()):
            raise ValueError('Invalid playback headers')
        stage = 'duration'
        duration = metadata.get('duration')
        if not isinstance(duration, (int, float)) or duration < 10:
            raise ValueError('Expected a finalized recording duration')
        report.update(resolved=True, height=selected['height'], duration=duration,
                      protocol=selected['protocol'])
        for at in sorted({0, min(220, int(duration) - 5), min(1800, int(duration) - 5), int(duration) - 5}):
            frame = {'seconds': at, 'decoded': False}
            try:
                decoded = subprocess.run([
                    'ffmpeg', '-nostdin', '-nostats', '-v', 'error', '-rw_timeout', '30000000',
                    '-threads', '1', *ffmpeg_input_args({'headers': headers}), '-ss', str(at),
                    '-i', selected['url'], '-map', '0:v:0', '-frames:v', '1', '-an',
                    '-vf', 'scale=854:480', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
                ], capture_output=True, timeout=90)
                if decoded.returncode:
                    raise extraction_error(decoded.stderr.decode(errors='replace'))
                if not decoded.stdout.startswith(b'\xff\xd8') or not decoded.stdout.endswith(b'\xff\xd9'):
                    raise ValueError('No decoded JPEG')
                frame.update(decoded=True, sha256=hashlib.sha256(decoded.stdout).hexdigest())
                (output / f'{identity}-{clients.replace(",", "_")}-{at}.jpg').write_bytes(decoded.stdout)
            except Exception as error:
                frame['error'] = safe_error_category(error)
            report['frames'].append(frame)
        report['playback'] = bool(report['frames']) and all(f['decoded'] for f in report['frames'])
    except Exception as error:
        report['error'] = safe_error_category(error)
        report['failure_stage'] = stage
    return report


def main():
    identity = validate_source_id('youtube', os.environ['VIDEO_ID'])
    output = Path(os.environ.get('YOUTUBE_PROBE_OUTPUT', '.ignore/youtube-pot'))
    output.mkdir(parents=True, exist_ok=True)
    report = {'source_id': identity, 'attempts': [], 'passed': False}
    try:
        with urlopen('http://127.0.0.1:4416/ping', timeout=10) as response:
            version = json.loads(response.read(4096)).get('version')
        if version != '2.0.2':
            raise ValueError('Unexpected provider version')
        report['provider_version'] = version
        # CI runs the baseline before installing the plugin so its automatic
        # discovery cannot contaminate the control measurement.
        baseline = output / 'baseline.json'
        if baseline.exists():
            report['baseline'] = json.loads(baseline.read_text())
        for clients in ('mweb', 'mweb,tv,web_safari'):
            time.sleep(5)
            attempt = check(identity, clients, output)
            report['attempts'].append(attempt)
            print(json.dumps({'source_id': identity, **attempt}), flush=True)
            if attempt['playback'] and attempt.get('token_retrieved'):
                report['passed'] = True
                break
    except Exception as error:
        report['error'] = safe_error_category(error)
    (output / f'{identity}.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
