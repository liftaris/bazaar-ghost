import copy
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

RUNNER = Path(__file__).resolve().parents[1] / 'validation_runner'
sys.path.insert(0, str(RUNNER))


def load(name):
    spec = importlib.util.spec_from_file_location('validation_' + name, RUNNER / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validation, launcher, start, guard = (load(name) for name in ('validate', 'launch', 'start', 'guard'))
VALUES = {'GITHUB_REPOSITORY': guard.REPOSITORY, 'GITHUB_REF': guard.REF, 'GITHUB_EVENT_NAME': 'workflow_dispatch',
          'GITHUB_WORKFLOW_REF': guard.WORKFLOW, 'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123',
          'GITHUB_ACTIONS': 'true', 'ENVIRONMENT': 'validation', 'VALIDATION_SOURCE': 'youtube',
          'VALIDATION_VIDEO_ID': '0C6bxQsDj-s', 'VALIDATION_RANGES': '[0,900]', 'VALIDATION_TEMPLATES': 'current',
          'VALIDATION_QUALITY': '480p', 'VALIDATION_PROFILE_ID': '1', 'VALIDATION_MINIMUM_DETECTIONS': '1',
          'VALIDATION_REQUIRE_IGD': 'true', 'BAZAARGHOST_API_URL': 'https://validation.example',
          'BAZAARGHOST_CATALOG_KEY': 'test-catalog', 'BAZAARGHOST_PROCESSOR_KEY': 'test-processor'}
CHUNK = {'id': '00000000-0000-4000-8000-000000000001', 'vod_pk': 1, 'source': 'youtube', 'vod_id': '0C6bxQsDj-s',
         'status': 'pending', 'start_seconds': 0, 'end_seconds': 900}


def source_coverage(start, end, video_end=None):
    """Consistent fixtures for measured source frames and, optionally, packet EOF."""
    effective_end = end if video_end is None else max(start, min(end, video_end))
    count = math.ceil((effective_end - start) / 2 - 1e-8)
    first = start if count else None
    last = effective_end - 1 / 30 if count else None
    result = {'sampled_frames': count, 'minimum_expected_frames': count, 'sample_interval_seconds': 2,
              'first_sample_seconds': start if count else None,
              'last_sample_seconds': start + 2 * (count - 1) if count else None,
              'requested_start_seconds': start, 'requested_end_seconds': end,
              'requested_expected_frames': math.ceil((end - start) / 2),
              'completion_reason': 'requested_range' if video_end is None else 'verified_video_eof',
              'effective_video_end_seconds': effective_end, 'unobserved_catalog_tail_seconds': end - effective_end,
              'source_frames': round((effective_end - start) * 30),
              'first_source_frame_seconds': first, 'last_source_frame_seconds': last,
              'max_source_gap_seconds': 1 / 30 if count else 0,
              'source_frame_interval_seconds': 1 / 30 if count else None,
              'source_timestamp_quantum_seconds': 1 / 90000 if count else None,
              'tail_unobserved_seconds': end - last if count else end - start, 'video_endpoint': None}
    if video_end is not None:
        container_end = end + 0.275
        result['video_endpoint'] = {
            'method': 'ffprobe-packets-v1', 'container': 'hls', 'closed': True,
            'video_end_seconds': video_end, 'last_video_frame_seconds': video_end - 1 / 30,
            'container_duration_seconds': container_end, 'source_origin_seconds': 62.033,
            'video_stream_index': 1, 'packet_count': 4000, 'video_packet_count': 1800, 'packet_limit': 10000,
            'probe_start_seconds': max(0, container_end - 60),
            'probe_start_timestamp_seconds': 62.033 + max(0, container_end - 60),
            'container_packet_end_seconds': container_end, 'container_tolerance_seconds': 1 / 30 + 1 / 90000 + 1e-6,
            'terminal_packet_duration_seconds': 1 / 30, 'terminal_packet_quantum_seconds': 1 / 90000,
            'selected_video_start_seconds': 62.033, 'container_origin_alignment_seconds': 0,
            'selected_video_packet_duration_seconds': 1 / 30, 'selected_video_timestamp_quantum_seconds': 1 / 90000,
            'frame_agreement_tolerance_seconds': 1 / 30 + 1 / 90000, 'audio_only': count == 0,
            'manifest_sha256': 'd' * 64, 'manifest_duration_seconds': container_end}
    return result


SUMMARY = {'vod_pk': 1, 'source': 'youtube', 'vod_id': CHUNK['vod_id'], 'chunk_id': CHUNK['id'], 'start_time': 0, 'end_time': 900, 'frames_processed': 450, 'matchups_found': 1,
           'detections': [{'timestamp': 12, 'username': 'Opponent', 'confidence': 0.95, 'rank': 'gold', 'igd': 12}],
           'decode_coverage': source_coverage(0, 900)}
STATE = {**CHUNK, 'status': 'completed', 'frames_processed': 450, 'detections_count': 1}


class ValidationRunnerTests(unittest.TestCase):
    def test_job_boundary_rejects_every_other_branch_repository_workflow_and_event(self):
        guard.validate_job(VALUES)
        for name, value in [('GITHUB_REF', 'refs/heads/dev'), ('GITHUB_REPOSITORY', 'other/repo'),
                            ('GITHUB_WORKFLOW_REF', guard.WORKFLOW.replace('validate-recording', 'process-vod')),
                            ('GITHUB_EVENT_NAME', 'pull_request')]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                guard.validate_job({**VALUES, name: value})

    def test_registration_secret_is_only_an_environment_input_and_runner_is_ephemeral(self):
        token = 'private-test-token'
        command, private = start.registration('bazaarghost-validation-' + 'a' * 32, token)
        self.assertNotIn(token, ' '.join(command))
        self.assertNotIn('--token', command)
        self.assertEqual(private, {'ACTIONS_RUNNER_INPUT_TOKEN': token})
        for flag in ('--ephemeral', '--disableupdate', '--no-default-labels'):
            self.assertIn(flag, command)
        self.assertNotIn('--replace', command)

    def test_container_has_no_host_mount_or_network_host_or_credential_argument(self):
        command = launcher.container_command('bazaarghost-validation-' + 'b' * 32, 'bazaarghost-validation-runner:2.338.0')
        for flag in ('-v', '--volume', '--mount', '--privileged', '--network=host', '--network', '--env-file'):
            self.assertNotIn(flag, command)
        self.assertIn('--cap-drop=ALL', command)
        self.assertIn('--security-opt=no-new-privileges', command)
        self.assertIn('--pull=never', command)
        with self.assertRaises(ValueError):
            launcher.container_command('self-hosted', 'image')
        with self.assertRaises(ValueError):
            launcher.container_command('bazaarghost-validation-' + 'b' * 32, '-v/home:/host')

    def test_bounded_reviewed_inputs_reject_boolean_ranges_overlap_and_template_mismatch(self):
        self.assertEqual(validation.options(VALUES)['ranges'], [0, 900])
        changes = [('ENVIRONMENT', 'dev'), ('VALIDATION_SOURCE', 'bilibili'), ('VALIDATION_VIDEO_ID', 'https://evil.invalid'),
                   ('VALIDATION_RANGES', '[false,900]'), ('VALIDATION_RANGES', '[0,900,800,1000]'),
                   ('VALIDATION_RANGES', '[0,1801]'), ('VALIDATION_RANGES', json.dumps([value for start in range(0, 23400, 1800) for value in (start, start + 1800)])),
                   ('VALIDATION_MINIMUM_DETECTIONS', '0'), ('VALIDATION_PROFILE_ID', '-1')]
        for name, value in changes:
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                validation.options({**VALUES, name: value})
        with self.assertRaises(ValueError):
            validation.options({**VALUES, 'VALIDATION_TEMPLATES': 'old', 'VALIDATION_QUALITY': '720p'})

    def test_twitch_id_and_recording_override_are_checked_before_any_catalog_access(self):
        values = {**VALUES, 'VALIDATION_SOURCE': 'twitch', 'VALIDATION_VIDEO_ID': '2863728070'}
        self.assertEqual(validation.options(values)['source'], 'twitch')
        for change in ({'VALIDATION_VIDEO_ID': '0C6bxQsDj-s'}, {'VALIDATION_VIDEO_ID': 'https://www.twitch.tv/videos/2863728070'},
                       {'VALIDATION_VIDEO_ID': '0'}, {'VALIDATION_VIDEO_ID': '02863728070'}, {'VALIDATION_VIDEO_ID': '1' * 26},
                       {'VALIDATION_RECORDED_AT': '2026-09-07T00:00:00Z'}, {'VALIDATION_RECORDED_AT': ' '}):
            with self.subTest(change=change), self.assertRaises(validation.ValidationFailure):
                validation.options({**values, **change})

    def test_six_hour_boundary_has_twelve_bounded_chunks_and_requires_complete_coverage(self):
        ranges = [value for start in range(0, 21600, 1800) for value in (start, start + 1800)]
        selected = validation.options({**VALUES, 'VALIDATION_RANGES': json.dumps(ranges)})
        chunks = [{**CHUNK, 'id': str(index), 'start_seconds': start, 'end_seconds': end}
                  for index, (start, end) in enumerate(zip(ranges[::2], ranges[1::2]))]
        validation.verify_plan(chunks, selected, 1)
        self.assertEqual(validation.reviewed_coverage(selected, 21600), [[0, 21600]])
        for plan in (chunks[:-1], chunks + [{**CHUNK, 'id': 'extra'}],
                     [{**CHUNK, 'end_seconds': 21600}]):
            with self.assertRaises(validation.ValidationFailure):
                validation.verify_plan(plan, selected, 1)
        with self.assertRaises(validation.ValidationFailure):
            validation.reviewed_coverage(selected, 21599)

    def test_existing_twitch_catalog_rejects_wrong_identity_metadata_and_ineligible_state(self):
        selected = validation.options({**VALUES, 'VALIDATION_SOURCE': 'twitch', 'VALIDATION_VIDEO_ID': '2863728070'})
        vod = {'id': 1, 'source': 'twitch', 'source_id': '2863728070', 'duration_seconds': 900,
               'bazaar_chapters': [0, 900], 'profile': {'id': 1}, 'old_templates': False,
               'processing_enabled': True, 'ready_for_processing': True, 'availability': 'available', 'status': 'pending'}
        validation.verify_twitch_catalog(vod, selected)
        for change in ({'source': 'youtube'}, {'source_id': '2863728071'}, {'duration_seconds': 899},
                       {'bazaar_chapters': [0, 800]}, {'bazaar_chapters': [0, 800, 700, 900]},
                       {'processing_enabled': False}, {'ready_for_processing': False}, {'availability': 'unavailable'},
                       {'status': 'completed'}, {'status': 'partial'}, {'status': 'failed'},
                       {'profile': {'id': 2}}, {'old_templates': True}):
            with self.subTest(change=change), self.assertRaises(validation.ValidationFailure):
                validation.verify_twitch_catalog({**vod, **change}, selected)

    def test_preparation_rejects_quality_fallback_and_same_id_changed_crop(self):
        selected = validation.options(VALUES)
        profile = {'id': 1, 'crop_region': [1, 2, 3, 4]}
        prepared = {'sfde_profile': json.dumps(profile), 'old_templates': 'false', 'quality': '480p', 'video_fps': '60'}
        self.assertEqual(validation.verify_prepared(prepared, selected, profile), profile)
        for change in ({'quality': '720p'}, {'stream_quality': 'audio_only'}, {'old_templates': 'true'},
                       {'sfde_profile': '{"id":1,"crop_region":[4,3,2,1]}'}, {'sfde_profile': '{"id":2}'}):
            with self.subTest(change=change), self.assertRaises(validation.ValidationFailure):
                validation.verify_prepared({**prepared, **change}, selected, profile)

    def test_actual_twitch_prepare_reads_existing_processor_plan_without_catalog_or_planning_calls(self):
        workflow = validation.vod_workflow
        vod = {'id': 1, 'source': 'twitch', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'profile': {'id': 1, 'crop_region': [0, 0, 1, 1], 'opaque_edge': True}, 'old_templates': False}
        values = {'VOD_ID': '2863728070', 'VIDEO_SOURCE': 'twitch', 'LOCAL': 'false', 'REQUESTED_QUALITY': '720p'}
        with patch.dict(os.environ, values, clear=True), patch.object(workflow, 'api', side_effect=[vod, [{'id': CHUNK['id']}]]) as api, \
             patch.object(workflow.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{"streams":{"720p60":{},"480p":{}}}')) as resolve, \
             patch.object(workflow, 'output') as output:
            workflow.prepare()
        self.assertEqual([call.args for call in api.call_args_list], [('vod', {'source': 'twitch', 'source_id': '2863728070'}), ('chunks', {'vod_id': '1'})])
        self.assertTrue(all(not call.kwargs for call in api.call_args_list))
        self.assertEqual(resolve.call_args.args[0], ['streamlink', '--no-config', '--json', 'https://www.twitch.tv/videos/2863728070'])
        prepared = dict(call.args for call in output.call_args_list)
        self.assertEqual(prepared['chunk_uuids'], [CHUNK['id']])
        self.assertEqual(prepared['quality'], '720p')
        self.assertEqual(prepared['stream_quality'], '720p60')
        self.assertEqual(prepared['sfde_profile'], vod['profile'])

    def test_public_proof_reads_past_first_page_and_exact_page_boundary_without_ignoring_extras(self):
        selected = validation.options(VALUES)
        for count in (500, 501, 1001):
            rows = [{'detection_id': index} for index in range(count)]
            def public(path, data):
                self.assertEqual(path, '/rest/v1/rpc/search_video_detections')
                self.assertEqual(data['source_filter'], 'youtube')
                self.assertEqual(data['video_filter'], 1)
                return rows[data['result_offset']:data['result_offset'] + data['result_limit']]
            with self.subTest(count=count), patch.object(validation, 'public_json', side_effect=public) as api:
                self.assertEqual(validation.public_detections(selected, 1, count), rows)
                self.assertEqual([call.args[1]['result_offset'] for call in api.call_args_list], list(range(0, count + 1, 500)))
            with patch.object(validation, 'public_json', side_effect=public), self.assertRaises(validation.ValidationFailure):
                validation.public_detections(selected, 1, count - 1)

    def test_plan_proof_requires_exact_ranges_source_and_fresh_unclaimed_chunks(self):
        selected = validation.options(VALUES)
        validation.verify_plan([CHUNK], selected, 1)
        for changes in ({'end_seconds': 899}, {'start_seconds': 1}, {'vod_pk': 2}, {'source': 'twitch'},
                        {'vod_id': 'another-source-id'}, {'status': 'completed'}, {'status': 'queued'}, {'status': 'failed'},
                        {'start_seconds': False}, {'end_seconds': 900.0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validation.verify_plan([{**CHUNK, **changes}], selected, 1)
        with self.assertRaises(ValueError):
            validation.verify_plan([CHUNK, CHUNK], selected, 1)

    def test_clean_early_eof_and_wrong_sample_timeline_cannot_pass_terminal_coverage(self):
        self.assertEqual(validation.verify_chunk(CHUNK, STATE, SUMMARY)['frames_processed'], 450)
        for field, value in [('sampled_frames', 449), ('last_sample_seconds', 896), ('first_sample_seconds', 2),
                             ('sample_interval_seconds', 3), ('requested_end_seconds', 899)]:
            summary = copy.deepcopy(SUMMARY)
            summary['decode_coverage'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validation.verify_chunk(CHUNK, STATE, summary)
        for state in ({**STATE, 'status': 'processing'}, {**STATE, 'frames_processed': 449}, {**STATE, 'detections_count': 0},
                      {**STATE, 'vod_pk': 2}, {**STATE, 'source': 'twitch'}, {**STATE, 'id': 'another-chunk'}):
            with self.assertRaises(ValueError):
                validation.verify_chunk(CHUNK, state, SUMMARY)
        validation.verify_chunk(CHUNK, {**STATE, 'quality': '480p60'}, {**SUMMARY, 'quality': '480p60'}, '480p60')
        for state_quality, summary_quality in [('480p', '480p60'), ('480p60', '720p60'), (None, None)]:
            with self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(CHUNK, {**STATE, 'quality': state_quality}, {**SUMMARY, 'quality': summary_quality}, '480p60')

    def _video_eof_case(self, start=16200, end=17085, video_end=17083.966333):
        coverage = source_coverage(start, end, video_end)
        count = coverage['sampled_frames']
        planned = {**CHUNK, 'source': 'twitch', 'vod_id': '2863728070', 'start_seconds': start, 'end_seconds': end}
        state = {**planned, 'status': 'completed', 'frames_processed': count, 'detections_count': int(count > 0)}
        summary = {**copy.deepcopy(SUMMARY), 'source': planned['source'], 'vod_id': planned['vod_id'],
                   'start_time': start, 'end_time': end, 'frames_processed': count,
                   'matchups_found': int(count > 0), 'decode_coverage': coverage}
        summary['detections'] = [{**SUMMARY['detections'][0], 'timestamp': start + 12}] if count else []
        return planned, state, summary

    def test_measured_video_eof_explicitly_replaces_only_the_terminal_required_grid(self):
        planned, state, summary = self._video_eof_case()
        self.assertEqual(validation.verify_chunk(planned, state, summary)['frames_processed'], 442)
        self.assertEqual(summary['decode_coverage']['requested_expected_frames'], 443)
        self.assertEqual(summary['end_time'], 17085)
        self.assertEqual(summary['decode_coverage']['last_sample_seconds'], 17082)
        # Reusing the old artifact's invented 17084 tick cannot pass the new proof.
        stale = copy.deepcopy(summary)
        stale['frames_processed'] = 443
        stale['decode_coverage'].update(sampled_frames=443, minimum_expected_frames=443, last_sample_seconds=17084)
        with self.assertRaises(validation.ValidationFailure):
            validation.verify_chunk(planned, {**state, 'frames_processed': 443}, stale)

    def test_eof_requires_complete_independent_packet_and_source_evidence(self):
        planned, state, original = self._video_eof_case()
        changes = [
            ('completion_reason', 'requested_range'), ('video_endpoint', None),
            ('source_frames', 0), ('first_source_frame_seconds', 16201),
            ('last_source_frame_seconds', 17080), ('max_source_gap_seconds', 2),
            ('source_frame_interval_seconds', None), ('source_timestamp_quantum_seconds', float('nan')),
            ('unobserved_catalog_tail_seconds', 0), ('requested_expected_frames', 442),
            ('effective_video_end_seconds', 17085), ('tail_unobserved_seconds', 0),
        ]
        for field, value in changes:
            altered = copy.deepcopy(original)
            altered['decode_coverage'][field] = value
            with self.subTest(field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(planned, state, altered)
        for field, value in [
            ('method', 'clean-exit'), ('closed', False), ('manifest_sha256', 'invalid'),
            ('manifest_duration_seconds', 17086), ('packet_count', 10000), ('video_packet_count', 0),
            ('packet_limit', 10001), ('video_stream_index', True), ('source_origin_seconds', float('inf')),
            ('probe_start_seconds', 0), ('probe_start_timestamp_seconds', 0), ('container_packet_end_seconds', 17080),
            ('last_video_frame_seconds', 17084.5), ('frame_agreement_tolerance_seconds', 1), ('audio_only', True),
            ('terminal_packet_duration_seconds', 2), ('terminal_packet_quantum_seconds', 0),
            ('container_origin_alignment_seconds', 1), ('selected_video_start_seconds', 63),
            ('selected_video_packet_duration_seconds', 2), ('selected_video_timestamp_quantum_seconds', 0),
            ('container_duration_seconds', 18000),  # A nonterminal chunk cannot borrow the source's eventual EOF.
            ('container_duration_seconds', 17000),  # A shorter replacement file cannot stand in for this catalog.
        ]:
            altered = copy.deepcopy(original)
            altered['decode_coverage']['video_endpoint'][field] = value
            with self.subTest(endpoint_field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(planned, state, altered)
        for field in original['decode_coverage']['video_endpoint']:
            altered = copy.deepcopy(original)
            del altered['decode_coverage']['video_endpoint'][field]
            with self.subTest(missing_endpoint_field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(planned, state, altered)

    def test_hls_origin_alignment_is_measured_and_never_rebases_the_sample_timeline(self):
        planned, state, summary = self._video_eof_case()
        endpoint = summary['decode_coverage']['video_endpoint']
        endpoint['source_origin_seconds'] = 62.016667
        endpoint['probe_start_timestamp_seconds'] = endpoint['source_origin_seconds'] + endpoint['probe_start_seconds']
        endpoint['container_origin_alignment_seconds'] = 62.033 - 62.016667
        endpoint['container_tolerance_seconds'] += endpoint['container_origin_alignment_seconds']
        endpoint['container_packet_end_seconds'] += 0.04
        self.assertEqual(validation.verify_chunk(planned, state, summary)['frames_processed'], 442)
        self.assertEqual(summary['decode_coverage']['last_sample_seconds'], 17082)
        for change in ({'container_origin_alignment_seconds': 0.025}, {'selected_video_start_seconds': 62.5},
                       {'container': 'mp4'}, {'container_tolerance_seconds': 1}):
            altered = copy.deepcopy(summary)
            altered['decode_coverage']['video_endpoint'].update(change)
            with self.subTest(change=change), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(planned, state, altered)
    def test_zero_frame_tail_requires_preceding_verified_video_end_and_empty_results(self):
        planned, state, summary = self._video_eof_case(start=17084)
        self.assertEqual(validation.verify_chunk(planned, state, summary)['frames_processed'], 0)
        self.assertIsNone(summary['decode_coverage']['first_source_frame_seconds'])
        for field, value in [('first_sample_seconds', 17084), ('source_frames', 1), ('first_source_frame_seconds', 17084),
                             ('last_source_frame_seconds', 17084), ('max_source_gap_seconds', 0.1)]:
            altered = copy.deepcopy(summary)
            altered['decode_coverage'][field] = value
            with self.subTest(field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(planned, state, altered)
        for field, value in [('video_end_seconds', 17084.1), ('audio_only', False), ('closed', False)]:
            altered = copy.deepcopy(summary)
            altered['decode_coverage']['video_endpoint'][field] = value
            with self.subTest(field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(planned, state, altered)
        with self.assertRaises(validation.ValidationFailure):
            validation.verify_chunk(planned, {**state, 'detections_count': 1},
                                    {**summary, 'matchups_found': 1, 'detections': SUMMARY['detections']})

    def test_requested_grid_also_requires_raw_source_proof_and_rejects_old_artifacts(self):
        for field in ('completion_reason', 'requested_expected_frames', 'source_frames', 'first_source_frame_seconds',
                      'last_source_frame_seconds', 'max_source_gap_seconds', 'source_frame_interval_seconds',
                      'source_timestamp_quantum_seconds', 'tail_unobserved_seconds', 'effective_video_end_seconds',
                      'unobserved_catalog_tail_seconds'):
            altered = copy.deepcopy(SUMMARY)
            del altered['decode_coverage'][field]
            with self.subTest(field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(CHUNK, STATE, altered)
        for field, value in [('first_source_frame_seconds', 1), ('last_source_frame_seconds', 897),
                             ('max_source_gap_seconds', 2), ('source_frames', True), ('source_frames', 450)]:
            altered = copy.deepcopy(SUMMARY)
            altered['decode_coverage'][field] = value
            with self.subTest(field=field), self.assertRaises(validation.ValidationFailure):
                validation.verify_chunk(CHUNK, STATE, altered)

    def test_ocr_subprocess_does_not_inherit_catalog_registration_or_ambient_credentials(self):
        prepared = {'quality': '480p', 'video_fps': '30', 'sfde_profile': '{}', 'old_templates': 'false'}
        with patch.dict(os.environ, {**VALUES, 'ACTIONS_RUNNER_INPUT_TOKEN': 'registration', 'AUTH_SECRET': 'auth',
                                    'HTTP_PROXY': 'private-proxy', 'TEST_MODE': 'true', 'GH_TOKEN': 'gh'}, clear=True):
            result = validation.processor_environment(prepared, CHUNK['id'])
        self.assertEqual(result['BAZAARGHOST_PROCESSOR_KEY'], 'test-processor')
        self.assertEqual(result['TEST_MODE'], 'false')
        for key in ('BAZAARGHOST_CATALOG_KEY', 'ACTIONS_RUNNER_INPUT_TOKEN', 'AUTH_SECRET', 'HTTP_PROXY', 'GH_TOKEN'):
            self.assertNotIn(key, result)

    def _orchestration(self, source='youtube', ranges=(0, 1800, 1800, 2718), duration=2718, prepare_change=None, final_change=None, interrupted=None, video_end=None):
        order, processed = [], []
        video_id = '2863728070' if source == 'twitch' else CHUNK['vod_id']
        quality, fps = ('480p60', '60') if source == 'twitch' else ('480p', '30')
        chunks = [{**CHUNK, 'id': f'00000000-0000-4000-8000-{index + 1:012d}', 'source': source, 'vod_id': video_id,
                   'start_seconds': start, 'end_seconds': end}
                  for index, (start, end) in enumerate(zip(ranges[::2], ranges[1::2]))]
        profile = {'id': 2, 'crop_region': [0, 0, 100, 100], 'igd_crop_region': [1, 2, 3, 4]}
        catalog = {'id': 1, 'source': source, 'source_id': video_id, 'streamer_id': 7, 'creator_name': 'nl_Kripp',
                   'title': 'Reviewed recording', 'published_at': '2026-09-07T00:00:00Z', 'recorded_at': None,
                   'duration_seconds': duration, 'bazaar_chapters': [value for interval in validation.merged(list(zip(ranges[::2], ranges[1::2]))) for value in interval],
                   'profile': profile, 'old_templates': False, 'template_version': 'auto', 'processing_enabled': True,
                   'ready_for_processing': True, 'availability': 'available', 'status': 'pending'}
        summaries = {}
        for chunk in chunks:
            coverage = source_coverage(chunk['start_seconds'], chunk['end_seconds'],
                                       video_end if video_end is not None and chunk['end_seconds'] > video_end else None)
            count = coverage['sampled_frames']
            summary = copy.deepcopy(SUMMARY)
            summary.update(source=source, vod_id=video_id, quality=quality, chunk_id=chunk['id'], start_time=chunk['start_seconds'], end_time=chunk['end_seconds'], frames_processed=count)
            summary['detections'][0]['timestamp'] = chunk['start_seconds'] + 12
            summary['decode_coverage'] = coverage
            summaries[chunk['id']] = summary
        states = [{**chunk, 'status': 'completed', 'quality': quality, 'frames_processed': summaries[chunk['id']]['frames_processed'], 'detections_count': 1}
                  for chunk in chunks]
        values = {**VALUES, 'VALIDATION_SOURCE': source, 'VALIDATION_VIDEO_ID': video_id,
                  'VALIDATION_RANGES': json.dumps(ranges), 'VALIDATION_PROFILE_ID': '2', 'SFDE_PROFILE': '{"id":999}'}
        class Image:
            status = 200
            class Headers:
                def get_content_type(self): return 'image/jpeg'
            headers = Headers()
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'\xff\xd8\xff'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'sfde').mkdir()
            (root / 'ocr').mkdir()
            def process(command, **kwargs):
                if command[-1] == 'prepare':
                    self.assertEqual(kwargs['env']['VIDEO_SOURCE'], source)
                    self.assertEqual(kwargs['env']['VOD_ID'], video_id)
                    self.assertEqual(kwargs['env']['SFDE_PROFILE'], '')
                    self.assertEqual(kwargs['env']['LOCAL'], 'false')
                    prepared = {'chunk_uuids': json.dumps([chunk['id'] for chunk in chunks]), 'quality': '480p', 'video_fps': fps,
                                'stream_quality': ('480p60' if fps == '60' else '480p') if source == 'twitch' else '',
                                'old_templates': 'false', 'sfde_profile': json.dumps(profile), **(prepare_change or {})}
                    Path(kwargs['env']['GITHUB_OUTPUT']).write_text(''.join(f'{key}={value}\n' for key, value in prepared.items()))
                else:
                    chunk_id = kwargs['env']['CHUNK_ID']
                    processed.append(chunk_id)
                    if interrupted and len(processed) == 2:
                        raise interrupted
                    (root / 'ocr' / f'detections_{chunk_id}.json').write_text(json.dumps(summaries[chunk_id]))
            def public(path, data=None):
                if path == '/health': return {'ok': True, 'environment': 'validation', 'build_commit': 'b' * 40}
                return [{'vod_id': 1, 'source': source, 'source_id': video_id, 'detection_id': 'public-' + chunk['id'],
                         'frame_time_seconds': chunk['start_seconds'] + 12, 'username': 'Opponent', 'rank': 'gold', 'igd': 12,
                         'storage_path': '/detections/example/current.jpg'} for chunk in chunks]
            with patch.dict(os.environ, values, clear=True), patch.object(validation, 'ROOT', root), patch.object(validation, 'OCR_OUTPUT', root / 'ocr'), \
                 patch.object(validation, 'verify_backend', side_effect=lambda: order.append('health')), \
                 patch.object(validation, 'youtube_metadata', side_effect=lambda value: order.append('metadata') or {'channel_id': 'UCtest'}) as metadata, \
                 patch.object(validation, 'normalize_video', return_value={'duration_seconds': duration}) as normalize, \
                 patch.object(validation, 'ensure_account', side_effect=lambda *args, **kwargs: order.append('credential') or {'id': 'account'}) as account, \
                 patch.object(validation, 'save_video', return_value={'id': 1}) as save, patch.object(validation, 'public_json', side_effect=public), \
                 patch.object(validation, 'verify_jpeg', return_value={'bytes': 1200, 'width': 854, 'height': 480}), \
                 patch.object(validation, 'open_backend', return_value=Image()), patch.object(validation.ChildSupervisor, 'run', side_effect=process), \
                 patch.object(validation.subprocess, 'check_output', return_value='a' * 40), \
                 patch.object(validation.vod_workflow, 'api', side_effect=([catalog] if source == 'twitch' else []) + [*chunks, *states]) as api, \
                 patch.object(validation.vod_workflow, 'get_vod', return_value={**catalog, 'status': 'completed', **(final_change or {})}):
                self.assertEqual(validation.main(), 1 if prepare_change or final_change or interrupted else 0)
                if source == 'twitch':
                    metadata.assert_not_called()
                    normalize.assert_not_called()
                    account.assert_not_called()
                    save.assert_not_called()
                    self.assertEqual(api.call_args_list[0].args, ('vod', {'source': 'twitch', 'source_id': video_id}))
                    self.assertTrue(all(not call.kwargs for call in api.call_args_list))
            report = json.loads((root / 'validation-output' / 'validation.json').read_text())
            if interrupted:
                self.assertEqual(report['phase'], 'ocr')
                self.assertEqual(report['status'], 'cancelled' if isinstance(interrupted, validation.ValidationCancelled) else 'failed')
                self.assertEqual(report['error_type'], type(interrupted).__name__)
                self.assertEqual(report['current_chunk'], chunks[1]['id'])
                self.assertEqual(len(report['chunks']), 1)
                self.assertEqual((root / 'validation-output' / 'validation.json').stat().st_mode & 0o777, 0o600)
                return report
            if prepare_change or final_change:
                self.assertEqual(report['phase'], 'prepare' if prepare_change else 'public_persistence')
                self.assertEqual(report['status'], 'failed')
                if prepare_change:
                    self.assertEqual(processed, [])
                return report
            self.assertEqual(report['status'], 'passed')
            self.assertEqual([chunk['frames_processed'] for chunk in report['chunks']], [item['frames_processed'] for item in states])
            self.assertEqual(report['frames_processed'], sum(item['frames_processed'] for item in states))
            self.assertEqual(report['profile']['id'], 2)
            self.assertEqual(report['cataloged_ranges'], validation.merged(list(zip(ranges[::2], ranges[1::2]))))
            self.assertEqual(report['full_source_video'], report['cataloged_ranges'] == [[0, duration]])
            self.assertEqual(report['quality'], quality)
            self.assertEqual(processed, [chunk['id'] for chunk in chunks])
            self.assertEqual(report['igd_detections'], len(chunks))
            self.assertEqual(order, ['health'] if source == 'twitch' else ['health', 'metadata', 'credential'])
            self.assertNotIn('test-processor', json.dumps(report))
            self.assertNotIn('test-catalog', json.dumps(report))
            self.assertEqual((root / 'validation-output' / 'validation.json').stat().st_mode & 0o777, 0o600)
            return report

    def test_full_youtube_orchestration_keeps_reviewed_catalog_and_complete_proof(self):
        report = self._orchestration()
        self.assertTrue(report['full_source_video'])
        self.assertEqual(report['frames_processed'], 1359)
        self.assertEqual(report['catalog_method'], 'reviewed_youtube_catalog')

    def test_cancelled_or_timed_out_ocr_saves_previous_chunks_and_current_phase(self):
        for interrupted in (validation.ValidationCancelled(), validation.subprocess.TimeoutExpired(['private-command'], 1)):
            with self.subTest(reason=type(interrupted).__name__):
                report = self._orchestration(interrupted=interrupted)
                self.assertNotIn('private-command', json.dumps(report))

    def test_twitch_with_video_support_at_last_catalog_tick_keeps_the_complete_requested_grid(self):
        ranges = tuple(value for start in range(0, 17085, 1800) for value in (start, min(start + 1800, 17085)))
        report = self._orchestration('twitch', ranges, 17085)
        self.assertTrue(report['full_source_video'])
        self.assertEqual(report['catalog_method'], 'existing_twitch_catalog')
        self.assertEqual(report['frames_processed'], 8543)
        self.assertEqual(len(report['chunks']), 10)
        self.assertEqual(report['chunks'][-1]['decode_coverage']['last_sample_seconds'], 17084)

    def test_full_twitch_with_verified_audio_tail_records_8542_actual_samples_and_unchanged_catalog(self):
        ranges = tuple(value for start in range(0, 17085, 1800) for value in (start, min(start + 1800, 17085)))
        report = self._orchestration('twitch', ranges, 17085, video_end=17083.966333)
        self.assertTrue(report['full_source_video'])
        self.assertEqual(report['frames_processed'], 8542)
        self.assertEqual(report['source_duration_seconds'], 17085)
        self.assertEqual(report['cataloged_ranges'], [[0, 17085]])
        tail = report['chunks'][-1]['decode_coverage']
        self.assertEqual(tail['completion_reason'], 'verified_video_eof')
        self.assertEqual(tail['sampled_frames'], 442)
        self.assertEqual(tail['requested_expected_frames'], 443)
        self.assertEqual(tail['last_sample_seconds'], 17082)
        self.assertAlmostEqual(tail['unobserved_catalog_tail_seconds'], 1.033667)

    def test_sparse_twitch_chapters_do_not_claim_entire_source_completion(self):
        report = self._orchestration('twitch', (1800, 3600, 5400, 6301), 17085)
        self.assertFalse(report['full_source_video'])
        self.assertEqual(report['cataloged_ranges'], [[1800, 3600], [5400, 6301]])

    def test_twitch_empty_or_oversized_plan_and_resolution_fallback_fail_before_ocr(self):
        for change in ({'chunk_uuids': '[]'}, {'chunk_uuids': json.dumps([CHUNK['id']] * 13)}, {'quality': '720p'}):
            with self.subTest(change=change):
                self._orchestration('twitch', prepare_change=change)

    def test_twitch_source_metadata_change_cannot_pass_as_the_original_reviewed_recording(self):
        self._orchestration('twitch', final_change={'published_at': '2025-01-01T00:00:00Z'})

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow runs in the OCR image; no host package installation')
    def test_jpeg_evidence_fully_decodes_and_rejects_truncation_wrong_format_and_oversize(self):
        from PIL import Image
        payload = io.BytesIO()
        Image.new('RGB', (32, 16), 'red').save(payload, format='JPEG')
        self.assertEqual(validation.verify_jpeg(payload.getvalue())['width'], 32)
        with self.assertRaises(validation.ValidationFailure):
            validation.verify_jpeg(payload.getvalue()[:-20])
        png = io.BytesIO()
        Image.new('RGB', (32, 16), 'red').save(png, format='PNG')
        with self.assertRaises(validation.ValidationFailure):
            validation.verify_jpeg(png.getvalue())
        with patch.object(validation, 'MAX_JPEG_PIXELS', 100), self.assertRaises(validation.ValidationFailure):
            validation.verify_jpeg(payload.getvalue())
        with patch.object(validation, 'MAX_JPEG_BYTES', 100), self.assertRaises(validation.ValidationFailure):
            validation.verify_jpeg(payload.getvalue())
