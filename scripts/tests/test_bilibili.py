"""Bilibili part identity, anonymous playback, and revision boundaries."""

import json
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog_bilibili import normalize_part
from bilibili_source import bilibili_input, find_part, split_identity, video_renditions
from media_source import ffmpeg_input_args, ffmpeg_transport_args, resolve_media, validate_source_id


class BilibiliTests(unittest.TestCase):
    def metadata(self):
        return {'bvid': 'BV1FfL5zPEbH', 'title': '【直播回放】大巴扎', 'pubdate': 1745530563,
                'pages': [{'cid': 10, 'page': 1, 'part': 'first', 'duration': 7216},
                          {'cid': 20, 'page': 2, 'part': 'second', 'duration': 7211}]}

    def test_part_identity_survives_reordering(self):
        metadata = self.metadata()
        first = normalize_part(metadata, '20')
        metadata['pages'][1]['page'] = 1
        second = normalize_part(metadata, '20')
        self.assertEqual(first['source_id'], second['source_id'])
        self.assertNotEqual(first['source_part_index'], second['source_part_index'])
        self.assertEqual(second['bazaar_chapters'], [0, 7211])
        self.assertIsNone(second['recorded_at'])
        self.assertFalse(second['notifications_enabled'])

    def test_source_ids_and_urls_are_strict(self):
        self.assertEqual(bilibili_input('https://www.bilibili.com/video/BV1FfL5zPEbH/?p=2'), ('BV1FfL5zPEbH', 2))
        self.assertEqual(split_identity('BV1FfL5zPEbH:20'), ('BV1FfL5zPEbH', '20'))
        self.assertEqual(validate_source_id('bilibili', 'BV1FfL5zPEbH:20'), 'BV1FfL5zPEbH:20')
        for value in ('https://live.bilibili.com/123', 'https://bilibili.com.evil/video/BV1FfL5zPEbH',
                      'https://www.bilibili.com/video/BV1FfL5zPEbH?p=0', 'https://user:pw@bilibili.com/video/BV1FfL5zPEbH'):
            with self.assertRaises(ValueError):
                bilibili_input(value)

    def test_ranges_use_part_duration_not_submission_duration(self):
        with self.assertRaises(ValueError):
            normalize_part(self.metadata(), '20', ranges=[7000, 8000])
        with self.assertRaises(ValueError):
            normalize_part(self.metadata(), '20', ranges=[True, 100])
        row = normalize_part(self.metadata(), '20', ranges=[600, 1500], templates='old')
        self.assertEqual(row['template_version'], 'old')
        self.assertEqual(row['duration_seconds'], 7211)

    def test_removed_cid_does_not_fall_back_to_another_part(self):
        with self.assertRaisesRegex(ValueError, 'removed or replaced'):
            find_part(self.metadata(), '30')

    def test_public_video_renditions_reject_previews_and_fragments(self):
        valid = {'timelength': 7211000, 'dash': {'video': [
            {'codecs': 'avc1', 'height': 480, 'baseUrl': 'https://cdn.example/video.m4s'},
            {'codecs': 'hev1', 'height': 1080, 'baseUrl': 'https://cdn.example/hdr.m4s'}]}}
        with patch('bilibili_source.video_metadata', return_value=self.metadata()):
            with patch('bilibili_source.public_api', return_value=valid):
                self.assertEqual(len(video_renditions('BV1FfL5zPEbH:20')['videos']), 1)
            for bad in ({**valid, 'is_preview': True}, {**valid, 'timelength': 60000}, {'timelength': 7211000, 'durl': []}):
                with patch('bilibili_source.public_api', return_value=bad):
                    with self.assertRaises((ValueError, RuntimeError)):
                        video_renditions('BV1FfL5zPEbH:20')

    def test_renditions_prefer_complete_mirrors_over_akamai(self):
        akamai = 'https://upos-hz-mirrorakam.akamaized.net/video.m4s'
        cos = 'https://upos-sz-mirrorcosov.bilivideo.com/video.m4s'
        for base, backups in ((akamai, [cos]), (cos, [akamai])):
            play = {'timelength': 7211000, 'dash': {'video': [
                {'codecs': 'avc1', 'height': 480, 'baseUrl': base, 'backupUrl': backups}]}}
            with patch('bilibili_source.video_metadata', return_value=self.metadata()):
                with patch('bilibili_source.public_api', return_value=play):
                    self.assertEqual(video_renditions('BV1FfL5zPEbH:20')['videos'][0]['url'], cos)
        only_akamai = {'timelength': 7211000, 'dash': {'video': [
            {'codecs': 'avc1', 'height': 480, 'baseUrl': akamai, 'backupUrl': ['ftp://bad.example/x']}]}}
        with patch('bilibili_source.video_metadata', return_value=self.metadata()):
            with patch('bilibili_source.public_api', return_value=only_akamai):
                self.assertEqual(video_renditions('BV1FfL5zPEbH:20')['videos'][0]['url'], akamai)

    def test_progressive_parts_resume_after_a_dropped_connection(self):
        streams = {'480p': {'type': 'http', 'url': 'https://cdn.example/part.m4s',
                            'headers': {'Referer': 'https://www.bilibili.com/'}}}
        with patch('media_source.subprocess.run', return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps({'streams': streams}))) as run:
            media = resolve_media('bilibili', 'BV1FfL5zPEbH:20', '480p')
        self.assertIn('--plugin-dirs', run.call_args.args[0])
        self.assertEqual((media['resolver'], media['height']), ('streamlink', 480))
        # Header options stay separate: the endpoint verifier accepts only headers.
        self.assertEqual(ffmpeg_input_args(media), ['-headers', 'Referer: https://www.bilibili.com/\r\n'])
        self.assertEqual(ffmpeg_transport_args(media)[:2], ['-reconnect', '1'])
        self.assertEqual(ffmpeg_transport_args({**media, 'resumable': False}), [])


if __name__ == '__main__':
    unittest.main()
