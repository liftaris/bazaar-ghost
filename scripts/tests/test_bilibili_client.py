"""Paced anonymous Bilibili client, uploader listing and discovery filters."""

import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'sfde' / 'src'))
from bilibili_source import BilibiliClient
from extraction_errors import ExtractionError
import platform_discovery


class FakeOpener:
    """Scripted responses keyed by endpoint path; records each request."""

    def __init__(self, script):
        self.script = {path: list(responses) for path, responses in script.items()}
        self.requests = []

    def open(self, request, timeout):
        path = request.full_url.split('api.bilibili.com', 1)[1].split('?', 1)[0]
        self.requests.append((path, dict(request.header_items())))
        response = self.script[path].pop(0)
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(json.dumps(response).encode() if not isinstance(response, bytes) else response)


class Clock:
    def __init__(self):
        self.now, self.sleeps = 100.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(round(seconds, 3))
        self.now += seconds


SPI = '/x/frontend/finger/spi'
LIST = '/x/series/recArchivesByKeywords'
VIEW = '/x/web-interface/view'
spi = lambda n=1: {'code': 0, 'data': {'b_3': f'B3-{n}', 'b_4': f'B4-{n}=='}}
ok = lambda **data: {'code': 0, 'data': data}


def client(script, **kwargs):
    opener, clock = FakeOpener(script), Clock()
    return BilibiliClient(opener=opener, clock=clock, sleep=clock.sleep, jitter=lambda: 0.0, **kwargs), opener, clock


class BilibiliClientTests(unittest.TestCase):
    def test_listing_carries_one_anonymous_cookie_and_playback_metadata_does_not(self):
        api, opener, _ = client({SPI: [spi()], LIST: [ok(archives=[]), ok(archives=[])], VIEW: [ok(pages=[])]})
        api.get(LIST, {'mid': 1})
        api.get(LIST, {'mid': 2})
        api.get(VIEW, {'bvid': 'BV1FfL5zPEbH'})
        paths = [path for path, _ in opener.requests]
        self.assertEqual(paths, [SPI, LIST, LIST, VIEW])
        headers = dict(opener.requests[1][1])
        self.assertEqual(headers['User-agent'], 'BazaarGhost/1.0')
        self.assertTrue(headers['Cookie'].startswith('buvid3=B3-1; buvid4=B4-1==; b_nut='))
        self.assertNotIn('Cookie', dict(opener.requests[3][1]))

    def test_each_endpoint_is_paced_independently(self):
        api, _, clock = client({SPI: [spi()], LIST: [ok(archives=[])] * 2, VIEW: [ok(pages=[])] * 2})
        api.get(LIST, {'mid': 1})
        api.get(VIEW, {'bvid': 'BV1FfL5zPEbH'})
        api.get(VIEW, {'bvid': 'BV1FfL5zPEbH'})
        api.get(LIST, {'mid': 1})
        self.assertEqual(clock.sleeps, [1.0, 5.0])

    def test_412_refreshes_the_cookie_and_retries_with_backoff(self):
        rejected = HTTPError('https://api.bilibili.com' + LIST, 412, 'blocked', {}, None)
        api, opener, clock = client({SPI: [spi(1), spi(2)], LIST: [rejected, ok(archives=[{'bvid': 'BV1FfL5zPEbH'}])]})
        self.assertEqual(api.get(LIST, {'mid': 1})['archives'][0]['bvid'], 'BV1FfL5zPEbH')
        self.assertIn('buvid3=B3-2', dict(opener.requests[-1][1])['Cookie'])
        self.assertIn(5.0, clock.sleeps)

    def test_persistent_rejection_raises_the_endpoint_category_after_bounded_attempts(self):
        rejected = lambda: HTTPError('https://api.bilibili.com' + LIST, 412, 'blocked', {}, None)
        api, opener, _ = client({SPI: [spi(n) for n in range(3)], LIST: [rejected() for _ in range(3)]})
        with self.assertRaises(ExtractionError) as caught:
            api.get(LIST, {'mid': 1})
        self.assertEqual(caught.exception.category, 'http_412')
        self.assertEqual(sum(path == LIST for path, _ in opener.requests), 3)

    def test_risk_control_code_retries_but_other_codes_fail_immediately(self):
        api, opener, _ = client({SPI: [spi(1), spi(2)], LIST: [{'code': -352}, ok(archives=[])]})
        api.get(LIST, {'mid': 1})
        api, opener, _ = client({SPI: [spi()], LIST: [{'code': -404, 'message': 'secret'}]})
        with self.assertRaises(ExtractionError) as caught:
            api.get(LIST, {'mid': 1})
        self.assertEqual(caught.exception.category, 'provider_api_rejected')
        self.assertEqual(len(opener.requests), 2)

    def test_failed_cookie_refresh_reports_the_original_rejection(self):
        api, _, _ = client({SPI: [spi(), HTTPError('u', 412, 'b', {}, None), HTTPError('u', 412, 'b', {}, None)],
                            LIST: [{'code': -352}]})
        with self.assertRaises(ExtractionError) as caught:
            api.get(LIST, {'mid': 1})
        self.assertEqual(caught.exception.category, 'provider_feed_rejected')

    def test_rejects_unlisted_paths_oversized_bodies_and_malformed_device_ids(self):
        api, _, _ = client({VIEW: [b'x' * 2_000_001]})
        with self.assertRaises(ValueError):
            api.get('/x/space/wbi/arc/search', {})
        with self.assertRaises(ValueError):
            api.get(VIEW, {'bvid': 'BV1FfL5zPEbH'})
        api, _, _ = client({SPI: [{'code': 0, 'data': {'b_3': 'x\r\nSet-Cookie: y', 'b_4': 'z'}}] * 3, LIST: []})
        with self.assertRaises(ExtractionError) as caught:
            api.get(LIST, {'mid': 1})
        self.assertEqual(caught.exception.category, 'invalid_response')


class UploaderListingTests(unittest.TestCase):
    def test_positional_cursor_maps_to_newest_first_pages(self):
        archives = [{'bvid': 'BV1d2ng6VEaM'}, {'bvid': 'not-a-bvid'}, 'junk', {'bvid': 'BV1LcnM6TEdX'}]
        with patch('platform_discovery.public_api', return_value={'archives': archives}) as call:
            page = platform_discovery.account_page('bilibili', '2561817', 'videos', 21)
        self.assertEqual(page, {'ids': ['BV1d2ng6VEaM', 'BV1LcnM6TEdX'], 'inspected': 3})
        self.assertEqual(call.call_args.args[1], {'mid': '2561817', 'keywords': '', 'ps': 20, 'pn': 2})
        self.assertEqual(call.call_args.args[2], 'https://space.bilibili.com/2561817/video')
        for start in (2, 0):
            with self.assertRaises(ValueError):
                platform_discovery.account_page('bilibili', '2561817', 'videos', start)
        with self.assertRaises(ValueError):
            platform_discovery.account_page('bilibili', '../1', 'videos', 1)


class DiscoveryTests(unittest.TestCase):
    def entry(self, bvid, pubdate, title='【<em class="keyword">大巴扎</em>】海盗', duration='45:10'):
        return {'bvid': bvid, 'pubdate': pubdate, 'title': title, 'duration': duration}

    def test_pages_back_to_the_previous_high_water_mark_and_filters_clips(self):
        pages = [{'result': [self.entry('BV1aaaaaaaaa', 300), self.entry('BV1bbbbbbbbb', 290, duration='2:48'),
                             self.entry('BV1ccccccccc', 280, title='炉石传说')]},
                 {'result': [self.entry('BV1ddddddddd', 270, duration='1:02:05'), self.entry('BV1eeeeeeeee', 200)]}]
        with patch('platform_discovery.bilibili_api', side_effect=pages) as search:
            ids, state = platform_discovery.bilibili_candidates({'since': 250})
        self.assertEqual(ids, ['BV1aaaaaaaaa', 'BV1ddddddddd'])
        self.assertEqual(state, {'since': 300, 'candidates': 2})
        self.assertEqual(search.call_count, 2)

    def test_first_run_is_bounded_and_empty_results_keep_the_mark(self):
        page = {'result': [self.entry('BV1aaaaaaaaa', 300)]}
        with patch('platform_discovery.bilibili_api', return_value=page) as search:
            platform_discovery.bilibili_candidates({}, pages=3)
        self.assertEqual(search.call_count, 3)
        with patch('platform_discovery.bilibili_api', return_value={'result': []}):
            self.assertEqual(platform_discovery.bilibili_candidates({'since': 300}), ([], {'since': 300, 'candidates': 0}))


if __name__ == '__main__':
    unittest.main()
