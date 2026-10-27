#!/usr/bin/env python3
"""Read-only live check of yt-dlp's documented PO-token provider setup."""
import hashlib
from importlib.metadata import version as package_version
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


def token_evidence(stderr, provider):
    marker = 'bgutil:http-' if provider == 'bgutil' else 'wpc-'
    return {
        'provider_loaded': marker in stderr,
        'provider_unavailable': bool(re.search(re.escape(marker) + r'[^\n,]* \(external, unavailable\)', stderr)),
        'token_requested': bool(re.search(r'(?:Generating|Fetching|Minting|Launching youtube.com).*PO Token', stderr)),
        'token_retrieved': bool(re.search(r'Retrieved a (?:gvs|player) PO Token for', stderr)),
        'browser_launch_attempted': 'Launching youtube.com in browser' in stderr,
        'browser_missing': 'WPC PO Token Provider requires Chrome to be installed' in stderr,
        'provider_error_types': sorted(set(re.findall(
            r'\b(?:TimeoutError|ConnectionRefusedError|PermissionError|FileNotFoundError|TypeError|AttributeError|RuntimeError)\b', stderr))),
        'player_statuses': sorted(set(re.findall(r'playability status: ([A-Z_]+)', stderr))),
        'js_challenge_attempted': 'Solving JS challenges using deno' in stderr,
        'account_cookies_detected': 'Found YouTube account cookies' in stderr,
        'cookies_rejected': 'cookies are no longer valid' in stderr or 'cookies have been rotated' in stderr,
    }


def check(identity, clients, output, provider='bgutil', policy='auto', cookiefile=None):
    report = {'clients': clients, 'policy': policy, 'resolved': False, 'playback': False, 'frames': []}
    stage = 'extraction'
    try:
        options = ['--no-plugin-dirs'] if policy == 'never' else []
        if cookiefile:
            options += ['--cookies', str(cookiefile)]
        if provider == 'bgutil' and policy != 'never':
            options += ['--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416']
        result = subprocess.run([
            'yt-dlp', '--ignore-config', '--no-playlist', '--skip-download',
            '--dump-single-json', '--verbose', '--socket-timeout', '30',
            '--js-runtimes', 'deno',
            '--extractor-args', f'youtube:player_client={clients};fetch_pot={policy}',
            *options,
            'https://www.youtube.com/watch?v=' + identity,
        ], capture_output=True, text=True, timeout=180)
        # Never print/store verbose output: it can include locators and tokens.
        report.update(token_evidence(result.stderr, provider))
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
                      protocol=selected['protocol'], format_id=selected['format_id'])
        for at in sorted({0, min(220, int(duration) - 5), min(1800, int(duration) - 5), int(duration) - 5}):
            frame = {'seconds': at, 'decoded': False}
            try:
                decoded = subprocess.run([
                    'ffmpeg', '-nostdin', '-nostats', '-v', 'error', '-rw_timeout', '30000000',
                    '-threads', '1', *ffmpeg_input_args({'headers': headers}), '-ss', str(at),
                    '-i', selected['url'], '-map', '0:v:0', '-frames:v', '1', '-an',
                    '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
                ], capture_output=True, timeout=90)
                if decoded.returncode:
                    raise extraction_error(decoded.stderr.decode(errors='replace'))
                if not decoded.stdout.startswith(b'\xff\xd8') or not decoded.stdout.endswith(b'\xff\xd9'):
                    raise ValueError('No decoded JPEG')
                frame.update(decoded=True, sha256=hashlib.sha256(decoded.stdout).hexdigest())
                (output / f'{identity}-{clients.replace(",", "_")}-{policy}-{at}.jpg').write_bytes(decoded.stdout)
            except Exception as error:
                frame['error'] = safe_error_category(error)
                frame['exception_type'] = type(error).__name__
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
    provider = os.environ.get('YOUTUBE_POT_PROVIDER', 'bgutil')
    cookiefile = os.environ.get('YOUTUBE_COOKIE_FILE')
    if provider not in ('bgutil', 'wpc'):
        raise ValueError('Unknown PO token provider')
    report = {'source_id': identity, 'provider': provider, 'authenticated': bool(cookiefile),
              'attempts': [], 'passed': False,
              'yt_dlp_version': package_version('yt-dlp'),
              'ejs_version': package_version('yt-dlp-ejs'),
              'revision': os.environ.get('GITHUB_SHA'), 'run_id': os.environ.get('GITHUB_RUN_ID')}
    try:
        distribution = 'bgutil-ytdlp-pot-provider' if provider == 'bgutil' else 'yt-dlp-getpot-wpc'
        report['provider_version'] = package_version(distribution)
        if provider == 'bgutil':
            with urlopen('http://127.0.0.1:4416/ping', timeout=10) as response:
                version = json.loads(response.read(4096)).get('version')
            if version != report['provider_version']:
                raise ValueError('Provider plugin and server versions differ')
            report['server_version'] = version
        baseline = output / 'baseline.json'
        if baseline.exists():
            report['baseline'] = json.loads(baseline.read_text())
        cases = (('default', 'never'), ('mweb', 'auto'), ('mweb', 'always'),
                 ('mweb,tv,web_safari', 'auto'), ('web_safari', 'auto'))
        if cookiefile:
            cases = (('default', 'never'), ('default', 'auto'), ('web_creator', 'auto'),
                     ('web_creator', 'always'), ('tv_downgraded', 'auto'), ('web_safari', 'auto'))
        for clients, policy in cases:
            time.sleep(5)
            attempt = check(identity, clients, output, provider, policy, cookiefile)
            report['attempts'].append(attempt)
            print(json.dumps({'source_id': identity, **attempt}), flush=True)
            if attempt['playback'] and (cookiefile or (attempt.get('token_retrieved') and attempt.get('provider_loaded'))):
                report['passed'] = True
    except Exception as error:
        report['error'] = safe_error_category(error)
    (output / f'{identity}.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
