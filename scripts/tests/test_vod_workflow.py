import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('workflow', Path(__file__).resolve().parents[1] / 'vod_workflow.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


class WorkflowTests(unittest.TestCase):
    def test_summary_handles_masked_unreadable_and_legacy_detections(self):
        data = {'chunk_id': 'chunk', 'frames_processed': 20, 'matchups_found': 3,
                'detections': [
                    {'timestamp': 150, 'username': None, 'name_state': 'masked',
                     'confidence': None, 'rank': 'silver', 'igd': 1},
                    {'timestamp': 160, 'username': None, 'name_state': 'unreadable',
                     'confidence': None, 'rank': 'gold', 'igd': None},
                    {'timestamp': 170, 'username': 'Exact.Case|Name',
                     'confidence': .98, 'rank': 'diamond', 'igd': 2},
                ]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'summary.md'
            with patch.dict(workflow.os.environ, {'CHUNK_ID': 'chunk', 'GITHUB_STEP_SUMMARY': str(output)}), \
                    patch.object(Path, 'exists', return_value=True), \
                    patch.object(Path, 'read_text', return_value=json.dumps(data)):
                workflow.summarize()
            text = output.read_text()
            self.assertIn('| 150 | Masked opponent |  | silver | 1 |', text)
            self.assertIn('| 160 | Unreadable opponent |  | gold |  |', text)
            self.assertIn('| 170 | Exact.Case\\|Name | 98% | diamond | 2 |', text)
            self.assertNotIn('None', text)

    def test_respects_requested_quality(self):
        self.assertEqual(workflow.select_quality({'480p': {}, '720p60': {}}, '720p', False), '720p60')

    def test_old_templates_can_normalize_other_sources_to_480p(self):
        self.assertEqual(workflow.select_quality({'720p': {}}, '720p', True), '720p')
        self.assertEqual(workflow.select_quality({'720p': {}, '480p60': {}}, '720p', True), '480p60')

    def test_unsupported_quality_is_rejected(self):
        with self.assertRaises(ValueError):
            workflow.select_quality({'best': {}}, 'best', False)

    def test_no_rendition_is_not_assumed_available(self):
        with self.assertRaises(ValueError):
            workflow.select_quality({}, '480p', False)

    def test_video_lookup_is_scoped_to_source_and_preserves_case(self):
        with patch.dict(workflow.os.environ, {'VOD_ID': '0C6bxQsDj-s', 'VIDEO_SOURCE': 'youtube'}, clear=True), \
                patch.object(workflow, 'api', return_value={'id': 1}) as api:
            self.assertEqual(workflow.get_vod(), {'id': 1})
            api.assert_called_once_with('vod', {'source': 'youtube', 'source_id': '0C6bxQsDj-s'})

    def test_old_external_archive_uses_profile_and_480p_without_publication_guessing(self):
        chunk = '2e032210-c665-4e6c-9f97-80b4c930c153'
        vod = {'id': 1, 'source': 'bilibili', 'processing_enabled': True,
               'ready_for_processing': True, 'availability': 'available', 'old_templates': True,
               'profile': {'id': 1, 'crop_region': [0, 0, 1, 1], 'opaque_edge': True}, 'published_at': '2026-09-07T00:00:00Z'}
        values = {'VOD_ID': 'BV1FfL5zPEbH:20', 'VIDEO_SOURCE': 'bilibili', 'LOCAL': 'true',
                  'REQUESTED_QUALITY': '720p', 'QUEUED_AT': '2026-09-07T12:00:00Z'}
        with patch.dict(workflow.os.environ, values, clear=True), patch.object(workflow, 'get_vod', return_value=vod), \
                patch.object(workflow, 'api', return_value=[{'id': chunk}]) as api, patch.object(workflow, 'output') as output:
            workflow.prepare()
            self.assertEqual(api.call_args.args[1]['queued_at'], values['QUEUED_AT'])
            outputs = dict(call.args for call in output.call_args_list)
            self.assertEqual(outputs['quality'], '480p')
            self.assertEqual(outputs['old_templates'], 'true')
            self.assertEqual(outputs['sfde_profile'], vod['profile'])

    def test_failure_cleanup_retains_dispatch_fencing(self):
        chunk = '2e032210-c665-4e6c-9f97-80b4c930c153'
        with patch.dict(workflow.os.environ, {'CHUNK_ID': chunk, 'QUEUED_AT': '2026-09-07T12:00:00Z'}, clear=True), \
                patch.object(workflow, 'api') as api:
            workflow.fail_chunk()
            self.assertEqual(api.call_args.kwargs['body']['queued_at'], '2026-09-07T12:00:00Z')
            self.assertEqual(api.call_args.kwargs['body']['ids'], [chunk])

    def test_differing_saved_profile_is_rejected_before_any_media_resolution(self):
        saved = {'id': 1, 'crop_region': [0, 0, 1, 1], 'igd_crop_region': None, 'custom_edge': None, 'opaque_edge': True}
        for source in ('youtube', 'twitch'):
            vod = {'id': 1, 'source': source, 'processing_enabled': True, 'ready_for_processing': True,
                   'availability': 'available', 'old_templates': False, 'profile': saved}
            changes = [{'crop_region': [0.1, 0, 0.9, 1]}, {'id': 2}, {'id': None}, {'custom_edge': 0.8},
                       {'igd_crop_region': [0, 0, 0.1, 0.1]}, {'opaque_edge': False}, {'crop_region': [False, 0, 1, 1]}]
            for override in [None, *({**saved, **change} for change in changes)]:
                with self.subTest(source=source, override=override), \
                        patch.dict(workflow.os.environ, {'SFDE_PROFILE': json.dumps(override)}, clear=True), \
                        patch.object(workflow, 'get_vod', return_value=vod), patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                        patch.object(workflow, 'output'), patch.object(workflow, 'resolve_media') as resolve, \
                        patch.object(workflow.subprocess, 'run') as streamlink:
                    with self.assertRaises(ValueError):
                        workflow.prepare()
                    resolve.assert_not_called()
                    streamlink.assert_not_called()

    def test_old_template_override_cannot_change_current_saved_era_before_media_access(self):
        saved = {'id': 1, 'crop_region': [0, 0, 1, 1], 'opaque_edge': True}
        vod = {'id': 1, 'source': 'youtube', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'old_templates': False, 'profile': saved}
        with patch.dict(workflow.os.environ, {'OLD_TEMPLATES': 'true'}, clear=True), \
                patch.object(workflow, 'get_vod', return_value=vod), patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                patch.object(workflow, 'output'), patch.object(workflow, 'resolve_media') as resolve:
            with self.assertRaisesRegex(ValueError, 'saved template era'):
                workflow.prepare()
            resolve.assert_not_called()

    def test_metadata_and_numeric_noops_preserve_saved_identity_and_default_old_era(self):
        saved = {'id': 1, 'profile_name': 'Saved', 'crop_region': [0, 0, 1, 1], 'custom_edge': 1, 'opaque_edge': True}
        override = {**saved, 'id': 1.0, 'profile_name': 'Renamed metadata', 'crop_region': [0.0, 0.0, 1.0, 1.0], 'custom_edge': 1.0}
        vod = {'id': 1, 'source': 'youtube', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'old_templates': True, 'profile': saved}
        for old_input in ('false', ''):
            with self.subTest(old_input=old_input), patch.dict(workflow.os.environ, {'OLD_TEMPLATES': old_input,
                    'SFDE_PROFILE': json.dumps(override), 'VOD_ID': 'abcdefghijk', 'REQUESTED_QUALITY': '720p'}, clear=True), \
                    patch.object(workflow, 'get_vod', return_value=vod), patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                    patch.object(workflow, 'output') as output, patch.object(workflow, 'resolve_media') as resolve:
                workflow.prepare()
                resolve.assert_called_once_with('youtube', 'abcdefghijk', '480p')
                outputs = dict(call.args for call in output.call_args_list)
                self.assertEqual(outputs['old_templates'], 'true')
                self.assertEqual(outputs['sfde_profile']['profile_name'], 'Renamed metadata')
                self.assertIs(type(outputs['sfde_profile']['id']), int)

class NativePreparationTests(unittest.TestCase):
    def test_native_label_and_template_geometry_cross_the_workflow_boundary(self):
        vod = {'id': 1, 'source': 'twitch', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'old_templates': True,
               'profile': {'id': 1, 'crop_region': [0, 0, 1, 1], 'opaque_edge': True}}
        from types import SimpleNamespace
        for native in ('720p48', '936p60', '720p29.97'):
            with self.subTest(native=native), patch.dict(workflow.os.environ, {'VOD_ID': '123'}, clear=True), \
                    patch.object(workflow, 'get_vod', return_value=vod), \
                    patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                    patch.object(workflow.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'streams': {native: {}}}))), \
                    patch.object(workflow, 'output') as output:
                workflow.prepare()
                values = dict(call.args for call in output.call_args_list)
                self.assertEqual(values['quality'], '480p')
                self.assertEqual(values['stream_quality'], native)


class NextPreparationTests(unittest.TestCase):
    def test_no_profile_and_malformed_or_changed_ambient_profiles_are_ignored(self):
        vod = {'id': 1, 'source': 'youtube', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'old_templates': False}
        for saved in ('absent', None, {'invalid': True}):
            details = dict(vod)
            if saved != 'absent':
                details['profile'] = saved
            for ambient in (None, 'not JSON', 'null', '[1]', '{"id":999,"crop_region":[1]}'):
                values = {'SFDE_NEXT_ENABLED': 'true', 'ENVIRONMENT': 'local',
                          'BAZAARGHOST_API_URL': 'http://127.0.0.1:8787', 'LOCAL': 'true',
                          'VOD_ID': 'abcdefghijk'}
                if ambient is not None:
                    values['SFDE_PROFILE'] = ambient
                with self.subTest(saved=saved, ambient=ambient), patch.dict(workflow.os.environ, values, clear=True), \
                        patch.object(workflow, 'get_vod', return_value=details), \
                        patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                        patch.object(workflow, 'prepared_profile', side_effect=AssertionError('NEXT must not validate profiles')), \
                        patch.object(workflow, 'output') as output, patch.object(workflow, 'resolve_media') as resolve:
                    workflow.prepare()
                    outputs = dict(call.args for call in output.call_args_list)
                    self.assertEqual(outputs['sfde_profile'], {})
                    self.assertEqual(outputs['old_templates'], 'false')
                    resolve.assert_not_called()

    def test_next_keeps_catalog_template_era_fence_without_profile(self):
        vod = {'id': 1, 'source': 'youtube', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'old_templates': False}
        with patch.dict(workflow.os.environ, {'SFDE_NEXT_ENABLED': 'true', 'ENVIRONMENT': 'validation',
                'BAZAARGHOST_API_URL': 'https://bazaarghost-validation.kaio-8df.workers.dev',
                'OLD_TEMPLATES': 'true', 'SFDE_PROFILE': 'not JSON'}, clear=True), \
                patch.object(workflow, 'get_vod', return_value=vod), \
                patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                patch.object(workflow, 'output'), patch.object(workflow, 'resolve_media') as resolve:
            with self.assertRaisesRegex(ValueError, 'saved template era'):
                workflow.prepare()
            resolve.assert_not_called()

    def test_next_rejects_nonvalidation_target_before_backend_or_media_access(self):
        for environment, url in [('production', 'http://localhost:8787'),
                                 ('dev', 'https://bazaarghost-validation.kaio-8df.workers.dev'),
                                 ('validation', 'https://production.example')]:
            with self.subTest(environment=environment, url=url), \
                    patch.dict(workflow.os.environ, {'SFDE_NEXT_ENABLED': 'true', 'ENVIRONMENT': environment,
                        'BAZAARGHOST_API_URL': url, 'SFDE_PROFILE': 'not JSON'}, clear=True), \
                    patch.object(workflow, 'get_vod') as get_vod:
                with self.assertRaisesRegex(ValueError, 'validation/local'):
                    workflow.prepare()
                get_vod.assert_not_called()

    def test_legacy_still_rejects_missing_or_malformed_profiles(self):
        vod = {'id': 1, 'source': 'youtube', 'processing_enabled': True, 'ready_for_processing': True,
               'availability': 'available', 'old_templates': False, 'profile': None}
        for ambient in ('', 'not JSON', 'null', '{}'):
            with self.subTest(ambient=ambient), patch.dict(workflow.os.environ, {'SFDE_PROFILE': ambient}, clear=True), \
                    patch.object(workflow, 'get_vod', return_value=vod), \
                    patch.object(workflow, 'api', return_value=[{'id': 'chunk'}]), \
                    patch.object(workflow, 'output'), patch.object(workflow, 'resolve_media') as resolve:
                with self.assertRaises(ValueError):
                    workflow.prepare()
                resolve.assert_not_called()


if __name__ == '__main__':
    unittest.main()
