"""Exercise the real FFmpeg demuxer, seeking, JPEG output, and PTS reader."""

from pathlib import Path
import shutil
import subprocess

import cv2
import numpy as np
import pytest

from video import timestamped_frames
import sfde as runtime
from test_pipeline import processor


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='FFmpeg is required')
@pytest.mark.parametrize('rate,size', [('10', '160x90'), ('24', '180x120'),
                                      ('48', '180x120'), ('50', '180x120'),
                                      ('30000/1001', '180x120'), ('60', '180x120'),
                                      ('120', '320x180')])
def test_hls_seek_between_segment_boundaries(tmp_path, rate, size, processor):
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
    processor.test_mode = False
    processor.start_time, processor.end_time = 5, 9
    processor.quality = '480p'
    processor._combined_crop = [200, 80, 100, 50]
    processor._resolve_stream = lambda: str(playlist)
    try:
        # Exercise the actual SFDE worker's command, seek, and queue timestamps.
        processor.ffmpeg_worker()
        frames = [processor.frame_queue.get_nowait() for _ in range(processor.frame_queue.qsize())]
    finally:
        close_decoder(processor)
    assert len(frames) == 2
    assert [timestamp for _, timestamp in frames] == [5, 7]
    images = [cv2.imdecode(np.frombuffer(frame, np.uint8), cv2.IMREAD_COLOR) for frame, _ in frames]
    assert all(image.shape[:2] == (80, 200) for image in images)
    colors = [image.mean(axis=(0, 1)) for image in images]
    assert colors[0][2] > colors[0][0]  # VOD second 5: red.
    assert colors[1][0] > colors[1][2]  # VOD second 7: blue.


def close_decoder(processor):
    process = processor.ffmpeg_proc
    if process is not None:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='FFmpeg is required')
def test_120fps_sampling_before_scale_preserves_pixels_and_pts(tmp_path, processor, monkeypatch):
    media = tmp_path / 'moving.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=120:d=10',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '120', str(media),
    ], capture_output=True, check=True, timeout=30)
    processor.test_mode = False
    processor.start_time, processor.end_time = 5, 9
    processor.quality = '480p'
    processor._combined_crop = [200, 80, 100, 50]
    processor._resolve_stream = lambda: str(media)

    def decode(reference_order):
        actual_popen = subprocess.Popen
        observed = []

        def spawn(command, *args, **kwargs):
            filters = command[command.index('-vf') + 1].split(',')
            assert filters[:2] == ['fps=0.5', 'scale=854:480']
            assert filters[2].startswith('crop=')
            assert filters[3] == 'showinfo'
            assert '-skip_frame' not in command
            assert '-r' not in command
            if reference_order:
                command = list(command)
                command[command.index('-vf') + 1] = ','.join([filters[1], filters[0], *filters[2:]])
            return actual_popen(command, *args, **kwargs)

        def read(*args):
            for pixels, pts in timestamped_frames(*args):
                observed.append((pixels, pts))
                yield pixels, pts

        try:
            with monkeypatch.context() as context:
                context.setattr(runtime.subprocess, 'Popen', spawn)
                context.setattr(runtime, 'timestamped_frames', read)
                processor.ffmpeg_worker()
            queued = [processor.frame_queue.get_nowait() for _ in range(processor.frame_queue.qsize())]
            assert [timestamp for _, timestamp in queued] == [5, 7]
            return observed
        finally:
            close_decoder(processor)

    reference, candidate = decode(True), decode(False)
    assert candidate == reference
    assert [pts for _, pts in candidate] == [0.0, 2.0]
    assert candidate[0][0] != candidate[1][0]
