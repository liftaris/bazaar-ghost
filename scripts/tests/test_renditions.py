"""Standard-library regressions for source selection and template geometry."""

from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sfde' / 'src'))
from renditions import parse_rendition, processing_quality, select_rendition


class RenditionTests(unittest.TestCase):
    def streams(self, *names):
        return {name: {'url': 'https://example.invalid/private?signature=secret'} for name in names}

    def test_native_labels_preserve_unusual_and_fractional_fps(self):
        for name, height, fps in [('480p24', 480, 24), ('720p48', 720, 48),
                                  ('1080p50', 1080, 50), ('1080p120', 1080, 120),
                                  ('720p29.97', 720, 29.97), ('480p', 480, None)]:
            with self.subTest(name=name):
                self.assertEqual(parse_rendition(name), (height, fps))
                result = select_rendition(self.streams(name), f'{height}p')
                self.assertEqual(result, {'stream_quality': name, 'quality': f'{height}p', 'video_fps': fps})

    def test_exact_requested_label_wins_over_nominal_fps_ties(self):
        self.assertEqual(select_rendition(self.streams('480p30', '480p'), '480p')['stream_quality'], '480p')
        self.assertEqual(select_rendition(self.streams('720p29.97', '720p30'), '720p29.97')['stream_quality'], '720p29.97')

    def test_standard_requested_height_and_60fps_are_preserved(self):
        for preferred, expected in [('720p', '720p60'), ('480p', '480p'), ('480p60', '480p60')]:
            with self.subTest(preferred=preferred):
                self.assertEqual(select_rendition(self.streams('480p', '480p60', '720p60'), preferred)['stream_quality'], expected)

    def test_nominal_fps_is_closest_to_preference(self):
        names = self.streams('720p24', '720p48', '720p50', '720p120')
        self.assertEqual(select_rendition(names, '720p')['stream_quality'], '720p24')
        self.assertEqual(select_rendition(names, '720p60')['stream_quality'], '720p50')

    def test_unsuffixed_source_fps_remains_unknown(self):
        self.assertIsNone(select_rendition(self.streams('480p'), '480p60')['video_fps'])

    def test_established_supported_height_fallback_order(self):
        for names, expected in [(['480p24', '720p48', '1080p50', '360p'], '480p24'),
                                (['720p48', '1080p50', '360p'], '720p48'),
                                (['1080p50', '360p'], '1080p50'), (['360p'], '360p')]:
            with self.subTest(names=names):
                self.assertEqual(select_rendition(self.streams(*names), '480p')['stream_quality'], expected)
        self.assertEqual(select_rendition(self.streams('540p', '1080p50'), '720p')['stream_quality'], '1080p50')

    def test_noncanonical_native_heights_normalize_downward(self):
        for name, expected in [('540p24', '480p'), ('900p48', '720p'),
                               ('1440p50', '1080p'), ('240p', '360p')]:
            with self.subTest(name=name):
                result = select_rendition(self.streams(name))
                self.assertEqual(result['stream_quality'], name)
                self.assertEqual(result['quality'], expected)
        self.assertEqual(select_rendition(self.streams('540p', '900p'), '720p')['stream_quality'], '900p')
        self.assertEqual(select_rendition(self.streams('240p', '540p'), '1080p')['stream_quality'], '540p')

    def test_old_templates_prefer_native_480_and_always_process_at_480(self):
        for names, expected in [(['480p24', '720p60'], '480p24'),
                                (['720p48', '1080p50'], '720p48'),
                                (['540p24', '900p48'], '540p24'), (['360p'], '360p')]:
            with self.subTest(names=names):
                result = select_rendition(self.streams(*names), '720p60', old_templates=True)
                self.assertEqual(result['stream_quality'], expected)
                self.assertEqual(result['quality'], '480p')

    def test_aliases_audio_and_invalid_labels_are_ignored(self):
        invalid = ['best', 'worst', 'audio', 'audio_only', '720p0', '480p-24',
                   '0p30', '720pNaN', '720pinf', '720p29.97x', '720p60\n', None, 480]
        for name in invalid:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    parse_rendition(name)
        result = select_rendition(self.streams(*invalid, '480p24'))
        self.assertEqual(result['stream_quality'], '480p24')

    def test_empty_or_alias_only_input_and_invalid_requests_fail(self):
        for names in [[], ['best', 'audio_only']]:
            with self.subTest(names=names):
                with self.assertRaises(ValueError):
                    select_rendition(self.streams(*names))
        for preferred in ['best', '540p', '900p48', '480p0']:
            with self.subTest(preferred=preferred):
                with self.assertRaises(ValueError):
                    select_rendition(self.streams('480p'), preferred)

    def test_processing_geometry_accepts_native_fps_without_using_it(self):
        for name, expected in [('480p24', '480p'), ('720p48', '720p'),
                               ('1080p50', '1080p'), ('720p29.97', '720p')]:
            with self.subTest(name=name):
                self.assertEqual(processing_quality(name), expected)

    def test_selection_is_deterministic_and_returns_no_private_media_data(self):
        for names in [('720p20', '720p40'), ('720p40', '720p20')]:
            result = select_rendition(self.streams(*names), '720p')
            self.assertEqual(result, {'stream_quality': '720p20', 'quality': '720p', 'video_fps': 20})
            self.assertNotIn('secret', str(result))


if __name__ == '__main__':
    unittest.main()
