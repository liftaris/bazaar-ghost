"""Exercise the real FFmpeg demuxer, seeking, JPEG output, and PTS reader."""

import logging
from pathlib import Path
import shutil
import subprocess

import cv2
import numpy as np
import pytest

from video import timestamped_frames


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='FFmpeg is required')
@pytest.mark.parametrize('segment_type', ['mpegts', 'fmp4'])
def test_hls_seek_between_segment_boundaries(tmp_path, segment_type):
    # Red for six seconds, then blue for six seconds, segmented at four seconds.
    playlist = tmp_path / 'video.m3u8'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=6',
        '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=10:d=6',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
        '-c:v', 'libx264', '-g', '40', '-sc_threshold', '0',
        '-hls_time', '4', '-hls_playlist_type', 'vod',
        '-hls_segment_type', segment_type, str(playlist),
    ], check=True, timeout=30)
    proc = subprocess.Popen([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'info',
        '-t', '4', '-ss', '5', '-i', str(playlist),
        '-vf', 'fps=0.5:eof_action=pass,showinfo', '-fps_mode', 'passthrough',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        frames = list(timestamped_frames(proc.stdout, proc.stderr, logging.getLogger('test')))
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert len(frames) == 2
    assert [5 + int(pts) for _, pts in frames] == [5, 7]
    colors = [cv2.imdecode(np.frombuffer(frame, np.uint8), cv2.IMREAD_COLOR).mean(axis=(0, 1)) for frame, _ in frames]
    assert colors[0][2] > colors[0][0]  # VOD second 5: red.
    assert colors[1][0] > colors[1][2]  # VOD second 7: blue.
