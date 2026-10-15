"""Decode actual synthetic HLS media using only FFmpeg and the standard library."""

import io
import json
import logging
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_pipeline import make_processor
from video import read_jpegs, timestamped_frames


class FragmentedStream(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 1))


class FrameReaderTests(unittest.TestCase):
    def test_jpeg_markers_split_across_reads(self):
        frames = [b'\xff\xd8first\xff\xd9', b'\xff\xd8second\xff\xd9']
        self.assertEqual(list(read_jpegs(FragmentedStream(b''.join(frames)))), frames)

    def test_truncated_jpeg_fails(self):
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            list(read_jpegs(io.BytesIO(b'\xff\xd8partial')))

    def test_invalid_jpeg_prefix_fails(self):
        with self.assertRaisesRegex(ValueError, 'Invalid JPEG'):
            list(read_jpegs(io.BytesIO(b'invalid\xff\xd9')))

    def test_timestamp_pairing_handles_scientific_notation(self):
        frames = io.BytesIO(b'\xff\xd8a\xff\xd9\xff\xd8b\xff\xd9')
        pts = io.BytesIO(b'[showinfo] pts_time:0.0 duration:2\n'
                         b'[showinfo] pts_time:2e+0 duration:2\n')
        self.assertEqual([pts for _, pts in timestamped_frames(frames, pts, logging.getLogger())], [0, 2])

    def test_missing_pts_fails_instead_of_inventing_vod_timestamp(self):
        with self.assertRaisesRegex(RuntimeError, 'without its timestamp'):
            list(timestamped_frames(io.BytesIO(b'\xff\xd8a\xff\xd9'), io.BytesIO(), logging.getLogger()))


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/FFprobe required')
class VideoIntegrationTests(unittest.TestCase):
    def test_native_fps_dimensions_normalize_crop_and_seek_at_actual_vod_seconds(self):
        for rate, size, quality, old in [
            ('24', '160x90', '480p', False), ('48', '320x180', '720p', False),
            ('50', '256x144', '1080p', False), ('30000/1001', '180x120', '360p', False),
            ('60', '192x108', '480p', True),
        ]:
            with self.subTest(rate=rate, size=size, quality=quality, old=old), tempfile.TemporaryDirectory() as directory:
                self.check_hls_decode(Path(directory), rate, size, quality, old)

    def check_hls_decode(self, directory, rate, size, quality, old):
        # A color change at six seconds catches rounded segment seeking: the
        # requested samples at VOD seconds five and seven must straddle it.
        playlist = directory / 'video.m3u8'
        subprocess.run([
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', f'color=red:s={size}:r={rate}:d=6',
            '-f', 'lavfi', '-i', f'color=blue:s={size}:r={rate}:d=6',
            '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
            '-c:v', 'libx264', '-g', '40', '-sc_threshold', '0',
            '-hls_time', '4', '-hls_playlist_type', 'vod', str(playlist),
        ], capture_output=True, check=True, timeout=30)
        processor = make_processor()
        processor.test_mode = False
        processor.quality = quality
        processor.old_templates = old
        processor._resolve_stream = lambda: str(playlist)
        processor.end_time = 9
        width, height = {'360p': (640, 360), '480p': (854, 480),
                         '720p': (1280, 720), '1080p': (1920, 1080)}[quality]
        processor.profile['crop_region'] = [100 / width, 50 / height, 200 / width, 80 / height]
        try:
            # Exercise the actual production command builder, not a duplicate.
            processor.ffmpeg_worker()
            frames = []
            while not processor.frame_queue.empty():
                frames.append(processor.frame_queue.get_nowait())
            self.assertEqual([timestamp for _, timestamp in frames], [5, 7])
            colors = []
            for pixels, _ in frames:
                metadata = subprocess.run([
                    'ffprobe', '-v', 'error', '-show_entries', 'stream=width,height',
                    '-of', 'json', '-i', 'pipe:0',
                ], input=pixels, capture_output=True, check=True, timeout=10)
                stream = json.loads(metadata.stdout)['streams'][0]
                self.assertEqual((stream['width'], stream['height']), (200, 80))
                decoded = subprocess.run([
                    'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                    '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo',
                    '-pix_fmt', 'rgb24', 'pipe:1',
                ], input=pixels, capture_output=True, check=True, timeout=10).stdout
                self.assertEqual(len(decoded), 200 * 80 * 3)
                colors.append(tuple(sum(decoded[channel::3]) for channel in range(3)))
            self.assertGreater(colors[0][0], colors[0][2])  # Five seconds: red.
            self.assertGreater(colors[1][2], colors[1][0])  # Seven seconds: blue.
        finally:
            proc = processor.ffmpeg_proc
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                proc.stdout.close()
                proc.stderr.close()


if __name__ == '__main__':
    unittest.main()
