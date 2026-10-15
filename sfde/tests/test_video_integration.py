"""Exercise the real FFmpeg demuxer, seeking, JPEG output, and PTS reader."""

import logging
from pathlib import Path
import shutil
import subprocess

import cv2
import numpy as np
import pytest

from video import timestamped_frames
from renditions import QUALITY_RESOLUTIONS


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='FFmpeg is required')
@pytest.mark.parametrize('rate,size', [('10', '160x90'), ('24', '180x120'),
                                      ('48', '180x120'), ('50', '180x120'),
                                      ('30000/1001', '180x120'), ('60', '180x120')])
def test_hls_seek_between_segment_boundaries(tmp_path, rate, size):
    # Red for six seconds, then blue for six seconds, segmented at four seconds.
    playlist = tmp_path / 'video.m3u8'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', f'color=red:s={size}:r={rate}:d=6',
        '-f', 'lavfi', '-i', f'color=blue:s={size}:r={rate}:d=6',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
        '-c:v', 'libx264', '-g', '40', '-sc_threshold', '0',
        '-hls_time', '4', '-hls_playlist_type', 'vod', str(playlist),
    ], check=True, timeout=30)
    width, height = QUALITY_RESOLUTIONS['480p']
    proc = subprocess.Popen([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'info',
        '-ss', '5', '-i', str(playlist), '-t', '4',
        '-vf', f'scale={width}:{height},fps=0.5,crop=200:80:100:50:exact=1,showinfo',
        '-fps_mode', 'passthrough',
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
    images = [cv2.imdecode(np.frombuffer(frame, np.uint8), cv2.IMREAD_COLOR) for frame, _ in frames]
    assert all(image.shape[:2] == (80, 200) for image in images)
    colors = [image.mean(axis=(0, 1)) for image in images]
    assert colors[0][2] > colors[0][0]  # VOD second 5: red.
    assert colors[1][0] > colors[1][2]  # VOD second 7: blue.
