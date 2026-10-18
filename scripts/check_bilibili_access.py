#!/usr/bin/env python3
"""Read-only Bilibili access check from the current runner network.

Discovery: anonymous device cookie, search, uploader listings, view and card,
paced and repeated; reports only status/code/item counts. Playback: resolve one
part through the bundled Streamlink plugin and decode frames with FFmpeg.
No backend, credentials, catalog writes or OCR.
"""
from collections import Counter, defaultdict
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sfde/src'))
from media_source import ffmpeg_input_args, ffmpeg_progressive_args, resolve_media

UA = 'BazaarGhost/1.0'
UIDS = ('1838389', '2561817', '19203673')
PART = 'BV1K114BiE7t:33726794861'
CHUNK_SECONDS = int(os.getenv('CHUNK_SECONDS', '1800'))


def call(path, params, referer, cookie=''):
    request = Request(f'https://api.bilibili.com{path}?{urlencode(params)}',
                      headers={'User-Agent': UA, 'Referer': referer, **({'Cookie': cookie} if cookie else {})})
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read(2_000_001)
        status = response.status
    except HTTPError as error:
        return {'http': error.code, 'code': None}
    except (URLError, TimeoutError) as error:
        return {'http': None, 'code': None, 'error': type(error).__name__}
    try:
        payload = json.loads(body)
    except ValueError:
        return {'http': status, 'code': None}
    return {'http': status, 'code': payload.get('code'), 'data': payload.get('data')}


def device_cookie():
    result = call('/x/frontend/finger/spi', {}, 'https://www.bilibili.com/')
    data = result.get('data') or {}
    if result.get('code') != 0 or not data.get('b_3'):
        return '', result
    return f"buvid3={data['b_3']}; buvid4={data['b_4']}; b_nut={int(time.time())}", result


def discovery(rounds, gap):
    outcomes = defaultdict(Counter)
    cookie = ''
    for round_ in range(rounds):
        if round_ % 3 == 0 or not cookie:
            cookie, spi = device_cookie()
            outcomes['spi'][f"http={spi['http']} code={spi['code']}"] += 1
            time.sleep(gap)
        steps = [('search', '/x/web-interface/search/type', {'search_type': 'video', 'keyword': '大巴扎', 'order': 'pubdate', 'page': 1},
                  'https://search.bilibili.com/', lambda d: len(d.get('result') or []))]
        steps += [('uploader', '/x/series/recArchivesByKeywords', {'mid': mid, 'keywords': '', 'ps': 50, 'pn': 1},
                   f'https://space.bilibili.com/{mid}/video', lambda d: len(d.get('archives') or [])) for mid in UIDS]
        steps += [('view', '/x/web-interface/view', {'bvid': PART.split(':')[0]}, 'https://www.bilibili.com/', lambda d: len(d.get('pages') or [])),
                  ('card', '/x/web-interface/card', {'mid': UIDS[0]}, 'https://www.bilibili.com/', lambda d: 1 if d.get('card') else 0)]
        for name, path, params, referer, count in steps:
            result = call(path, params, referer, cookie)
            ok = result.get('code') == 0 and isinstance(result.get('data'), dict) and count(result['data']) > 0
            outcomes[name]['ok' if ok else f"http={result['http']} code={result['code']}"] += 1
            time.sleep(gap)
    return {name: dict(counter) for name, counter in outcomes.items()}


def playback():
    report = {'source_id': PART}
    try:
        media = resolve_media('bilibili', PART, '480p')
        report.update(resolver=media['resolver'], height=media['height'], host=media['url'].split('/')[2])
        decoded = []
        for at in (0, 1200, 2400):
            result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', *ffmpeg_input_args(media), *ffmpeg_progressive_args(media),
                                     '-ss', str(at), '-i', media['url'], '-map', '0:v:0', '-frames:v', '1', '-f', 'image2pipe',
                                     '-vcodec', 'mjpeg', 'pipe:1'], capture_output=True, timeout=120)
            decoded.append({'at': at, 'ok': result.returncode == 0 and result.stdout[:2] == b'\xff\xd8'})
        report['frames'] = decoded
        started = time.time()
        result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'info', *ffmpeg_input_args(media), *ffmpeg_progressive_args(media),
                                 '-t', str(CHUNK_SECONDS), '-i', media['url'], '-map', '0:v:0', '-vf', 'fps=0.5,showinfo=checksum=0',
                                 '-f', 'null', '-'], capture_output=True, text=True, timeout=1800)
        report['chunk_decode'] = {'exit': result.returncode, 'samples': result.stderr.count('pts_time'),
                                  'expected': CHUNK_SECONDS // 2, 'seconds': round(time.time() - started)}
    except Exception as error:
        report['error'] = type(error).__name__
    return report


def main():
    rounds, gap = int(sys.argv[1]), float(sys.argv[2])
    report = {'discovery': discovery(rounds, gap), 'playback': playback()}
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
