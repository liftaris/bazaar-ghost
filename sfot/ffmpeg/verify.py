"""Exercise the shipped decoder against localhost H.264 fMP4 HLS input seeking.

Uses only Python's standard library and the selected FFmpeg binary. No external
network, credentials, database, OCR dependencies, or retained media are needed.
"""

import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
from typing import Any, Dict, List


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass


def run(binary: str, arguments: List[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run([binary, '-nostdin', '-hide_banner', *arguments],
                          capture_output=True, check=True, timeout=timeout)


def jpeg_hashes(data: bytes) -> List[str]:
    frames = []
    while data:
        if not data.startswith(b'\xff\xd8'):
            raise AssertionError('Invalid JPEG image2pipe prefix')
        end = data.find(b'\xff\xd9')
        if end < 0:
            raise AssertionError('Truncated JPEG image2pipe output')
        frames.append(hashlib.sha256(data[:end + 2]).hexdigest())
        data = data[end + 2:]
    return frames


def verify(binary: str) -> Dict[str, Any]:
    version = subprocess.run([binary, '-version'], capture_output=True,
                             check=True, text=True, timeout=10).stdout.splitlines()[0]
    with tempfile.TemporaryDirectory(prefix='ffmpeg-hls-seek-') as temporary:
        directory = Path(temporary)
        # Encode once, then remux identical moving H.264 packets into each
        # transport. The requested 7.3-second input seek lies between keyframes.
        run(binary, ['-loglevel', 'error', '-f', 'lavfi', '-i',
                     'testsrc2=size=160x96:rate=30:duration=18',
                     '-an', '-c:v', 'libx264', '-preset', 'fast', '-threads', '2',
                     '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
                     '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                     str(directory / 'source.mp4')])
        for name, segment_type in [('fmp4', 'fmp4'), ('ts', 'mpegts')]:
            run(binary, ['-loglevel', 'error', '-i', str(directory / 'source.mp4'),
                         '-map', '0:v:0', '-c', 'copy', '-hls_time', '2',
                         '-hls_playlist_type', 'vod', '-hls_segment_type', segment_type,
                         '-hls_fmp4_init_filename', name + '-init.mp4',
                         str(directory / (name + '.m3u8'))])
        server = ThreadingHTTPServer(('127.0.0.1', 0),
                                     partial(QuietHandler, directory=str(directory)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            results, issues = {}, []
            for kind, filename in [('http_mp4', 'source.mp4'), ('mpegts_hls', 'ts.m3u8'),
                                   ('fmp4_hls', 'fmp4.m3u8')]:
                url = 'http://127.0.0.1:' + str(server.server_port) + '/' + filename
                # Match the worker: input-side seek, bounded duration, 0.5 FPS,
                # spatial filters, showinfo, passthrough JPEG image2pipe output.
                decoded = run(binary, ['-loglevel', 'info', '-threads', '2',
                    '-filter_threads', '1', '-rw_timeout', '5000000', '-ss', '7.3',
                    '-i', url, '-t', '6', '-an', '-vf',
                    'fps=0.5,scale=160:96,crop=120:72:20:12:exact=1,showinfo',
                    '-fps_mode', 'passthrough', '-f', 'image2pipe', '-vcodec',
                    'mjpeg', 'pipe:1'], timeout=20)
                hashes = jpeg_hashes(decoded.stdout)
                all_pts = [float(value) for value in
                           re.findall(rb'\bpts_time:([-+\d.eE]+)\s', decoded.stderr)]
                # Output -t may discard a boundary frame after showinfo. Pair
                # the encoded JPEGs with their first timestamps, as the worker
                # does; never invent missing timestamps.
                pts = all_pts[:len(hashes)]
                results[kind] = {'frames': len(hashes), 'pts': pts, 'jpeg_sha256': hashes}
                if len(hashes) != 3 or pts != [0.0, 2.0, 4.0]:
                    issues.append(kind + ': expected three JPEGs at PTS 0,2,4')
                if len(set(hashes)) != 3:
                    issues.append(kind + ': moving fixture frames must remain distinct')
            for kind in ('mpegts_hls', 'fmp4_hls'):
                if results[kind] != results['http_mp4']:
                    issues.append(kind + ': sampled frame pixels/order/PTS differ from HTTP MP4')
            return {'passed': not issues, 'issues': issues, 'version': version,
                    'input_seek_seconds': 7.3, 'decode_duration_seconds': 6,
                    'transports': results}
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default='/opt/ffmpeg/bin/ffmpeg')
    args = parser.parse_args()
    result = verify(args.ffmpeg)
    print(json.dumps(result, sort_keys=True))
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
