"""Claim-scoped HTTP client for the Cloudflare D1/R2 backend."""

import base64
import json
import logging
import os
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import NAMESPACE_URL, uuid5

from telemetry import create_span, record_counter, record_histogram

_MISSING_PROFILE = object()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Backend redirects are not permitted')


class BackendClient:
    def __init__(self, config, test_mode=False, quality='480p', streamer=None):
        settings = config['backend']
        self.url = (os.getenv('BAZAARGHOST_API_URL') or settings.get('url', '')).rstrip('/')
        self.key = os.getenv('BAZAARGHOST_PROCESSOR_KEY') or settings.get('secret_key')
        if not self.url or not self.key:
            raise ValueError('BAZAARGHOST_API_URL and BAZAARGHOST_PROCESSOR_KEY must be set')
        self.timeout = settings.get('connection_timeout', 30)
        self.retry_attempts = settings['retry_attempts']
        if not isinstance(self.retry_attempts, int) or not 1 <= self.retry_attempts <= 5:
            raise ValueError('retry_attempts must be between 1 and 5')
        self.claims = {}
        self.quality, self.streamer = quality, streamer
        self.logger = logging.getLogger('sfde.backend')
        self.inference_attempts = {}

    def set_streamer(self, streamer):
        self.streamer = streamer

    def _request(self, path, method='GET', data=None, chunk_id=None, raw=False):
        headers = {'Authorization': f'Bearer {self.key}',
                   'User-Agent': 'BazaarGhost/1.0 (+https://github.com/liftaris/bazaar-ghost)',
                   'Content-Type': 'image/jpeg' if raw else 'application/json'}
        if chunk_id in self.claims:
            headers['X-Claim-Token'] = self.claims[chunk_id]
        payload = data if raw else None if data is None else json.dumps(data).encode()
        request = Request(self.url + '/api/processor/' + path, method=method, headers=headers, data=payload)
        try:
            with build_opener(NoRedirect).open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            # Never include authorization headers or potentially sensitive response bodies.
            raise RuntimeError(f'Backend {method} {path.split("?")[0]} failed: HTTP {error.code}') from error

    def get_chunk_details(self, chunk_id):
        return self._request(f'chunks/{chunk_id}')

    def claim_chunk(self, chunk_id, *, expected_old_templates, expected_profile=_MISSING_PROFILE, processor_mode='legacy'):
        # Legacy binds prepared crops to the catalog; explicit NEXT binds only
        # the template era because it derives layout from full-frame pixels.
        # Neither mode may silently fall back to an unfenced HTTP claim.
        if processor_mode not in ('legacy', 'next'):
            raise ValueError('Unsupported processor mode')
        if processor_mode == 'legacy' and expected_profile is _MISSING_PROFILE:
            raise TypeError('Legacy claims require expected_profile')
        if processor_mode == 'legacy' and (not isinstance(expected_profile, dict)
                or type(expected_profile.get('id')) is not int or expected_profile['id'] <= 0):
            raise ValueError('The prepared SFDE_PROFILE must identify a saved catalog profile')
        if type(expected_old_templates) is not bool:
            raise ValueError('The prepared template selection must be boolean before claiming')
        payload = {
            'queued_at': os.getenv('QUEUED_AT') or None,
            'expected_old_templates': expected_old_templates,
        }
        if processor_mode == 'next':
            target = urlparse(self.url)
            local = target.hostname in ('localhost', '127.0.0.1', '::1', 'host.docker.internal')
            validation = target.hostname == 'bazaarghost-validation.kaio-8df.workers.dev' and target.scheme == 'https'
            if os.getenv('ENVIRONMENT') not in ('validation', 'local') or not (local or validation):
                raise ValueError('NEXT claims require an explicit validation/local target')
            payload['processor_mode'] = 'next'
        else:
            payload['expected_profile'] = expected_profile
        result = self._request(f'chunks/{chunk_id}/claim', 'POST', payload)
        if result['claimed']:
            self.claims[chunk_id] = result['claim_token']
        return result['claimed']

    def update_chunk(self, chunk_id, status, **kwargs):
        return self._request(f'chunks/{chunk_id}', 'PATCH', {'status': status, **kwargs}, chunk_id)

    def delete_chunk_detections(self, chunk_id):
        # Existing wire call now begins a replacement. It must retain published
        # rows/social anchors until successful completion; never assume deletion.
        return self._request(f'chunks/{chunk_id}/detections', 'DELETE', chunk_id=chunk_id)['deleted']

    def _upload_image(self, matchup, field, kind):
        query = urlencode({'timestamp': matchup['timestamp'], 'kind': kind})
        return self._request(f"chunks/{matchup['chunk_id']}/images?{query}", 'PUT',
                             base64.b64decode(matchup[field], validate=True), matchup['chunk_id'], raw=True)['storage_path']

    def infer(self, chunk_id, *, request_id, task, at_ms, image_base64):
        """Exactly ONE submission. Server reservations own ambiguous duplicates.

        This method deliberately does not use upload_batch's safe persistence retry.
        Failed requests still consume the independent client-side chunk allowance.
        """
        if task not in ('ghost_hero', 'streamer_hero', 'clock_day'):
            raise ValueError('Unsupported inference task')
        attempts = getattr(self, 'inference_attempts', {})
        self.inference_attempts = attempts
        if attempts.get(chunk_id, 0) >= 64:
            raise ValueError('Chunk inference attempt limit reached')
        attempts[chunk_id] = attempts.get(chunk_id, 0) + 1
        with create_span('sfde.inference', {'inference.task': task, 'inference.call_index': attempts[chunk_id]}) as span:
            response = self._request(f'chunks/{chunk_id}/inference', 'POST', {
                'request_id': request_id, 'task': task, 'at_ms': at_ms, 'image_base64': image_base64,
            }, chunk_id)
            if span:
                span.set_attribute('inference.status', response.get('status', 'unknown'))
            return response

    def _next_record(self, matchup):
        """Upload *all* source images before publishing schema 2, including unknowns."""
        from encounter_pipeline import detection_id
        chunk_id = matchup['chunk_id']
        images = matchup['_images']
        if not images or matchup['_intro_ms'] not in images:
            raise ValueError('A detection requires its full intro screenshot')
        for at_ms, source in sorted(images.items()):
            query = urlencode({'timestamp_ms': at_ms, 'kind': source['kind']})
            source['image_path'] = self._request(f'chunks/{chunk_id}/images?{query}', 'PUT',
                                                source['jpeg'], chunk_id, raw=True)['storage_path']
        evidence = matchup['field_evidence']
        for field in evidence.values():
            # Inherited fields refer to an actual earlier upload in the same chunk.
            if 'inherited_from' not in field:
                field['image_path'] = images[field['at_ms']]['image_path']
                for sample in field.get('samples', []):
                    sample['image_path'] = images[sample['at_ms']]['image_path']
            elif not field.get('image_path'):
                raise ValueError('Inherited evidence has no original image path')
        record = {key: matchup.get(key) for key in (
            'username', 'confidence', 'name_state', 'encounter_confidence', 'igd',
            'ghost_hero', 'streamer_hero', 'wins_remaining', 'lethal',
            'game_mode', 'tournament_wins', 'tournament_losses')}
        record.update(schema_version=2,
                      id=detection_id(matchup['recording_identity'], matchup['anchor_ms']),
                      timestamp=matchup['timestamp'], frame_time_seconds=matchup['timestamp'],
                      rank=matchup.get('detected_rank'),
                      storage_path=images[matchup['_intro_ms']]['image_path'], field_evidence=evidence)
        matchup['storage_path'] = record['storage_path']
        return record

    def upload_batch(self, matchups):
        started = time.monotonic()
        attrs = {'streamer': self.streamer or 'unknown', 'quality': self.quality}
        with create_span('backend_upload', attributes={'batch.size': len(matchups)}) as span:
            for attempt in range(self.retry_attempts):
                if span:
                    span.set_attribute('upload.attempts', attempt + 1)
                try:
                    grouped = {}
                    for matchup in matchups:
                        if matchup.get('schema_version') == 2:
                            record = self._next_record(matchup)
                            grouped.setdefault(matchup['chunk_id'], []).append(record)
                            continue
                        if not matchup.get('username'):
                            continue
                        if not matchup.get('frame_base64'):
                            raise ValueError('A detection requires its screenshot')
                        path = self._upload_image(matchup, 'frame_base64', 'detection')
                        for field, kind in [('ocr_debug_frame', 'ocr_debug'), ('emblem_boxes_frame', 'emblem_boxes')]:
                            if matchup.get(field):
                                try:
                                    self._upload_image(matchup, field, kind)
                                except Exception:
                                    self.logger.warning('Optional debug image upload failed', exc_info=True)
                        chunk_id, timestamp = matchup['chunk_id'], matchup['timestamp']
                        record = {
                            'id': str(uuid5(NAMESPACE_URL, f'bazaarghost:{chunk_id}:{timestamp}')),
                            'frame_time_seconds': timestamp, 'username': matchup['username'],
                            'confidence': matchup.get('confidence', 0), 'rank': matchup.get('detected_rank'),
                            'storage_path': path, 'no_right_edge': matchup.get('no_right_edge', False),
                            'truncated': matchup.get('truncated', False), 'igd': matchup.get('igd'),
                        }
                        grouped.setdefault(chunk_id, []).append(record)
                    for chunk_id, records in grouped.items():
                        for offset in range(0, len(records), 50):
                            self._request(f'chunks/{chunk_id}/detections', 'POST',
                                          {'detections': records[offset:offset + 50]}, chunk_id)
                    record_counter('detections_uploaded', sum(map(len, grouped.values())), attrs)
                    record_histogram('upload_duration', (time.monotonic() - started) * 1000, attrs)
                    return True
                except Exception as error:
                    self.logger.error('Batch upload attempt %s failed: %s', attempt + 1, error)
                    if attempt + 1 == self.retry_attempts:
                        record_counter('errors', 1, {**attrs, 'component': 'backend', 'error_type': type(error).__name__})
                        raise
                    time.sleep(2 ** attempt)
        return False
