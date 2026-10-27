"""GitHub lifecycle/argument contracts without provider calls or credentials."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import catalog_api
import platform_ingestion
from backend_environment import BRANCHES

TICKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
CONTEXT = {'ticket_id': TICKET, 'run_id': '12345', 'run_attempt': '1', 'expected_environment': 'validation'}


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / 'output'
        self.summary = Path(self.directory.name) / 'summary'
        self.environment = {'INGEST_DISPATCH_TICKET': TICKET, 'GITHUB_RUN_ID': '12345', 'GITHUB_RUN_ATTEMPT': '1',
                            'SOURCE': 'none', 'IDENTITY': '', 'DISCOVERY': 'false',
                            'GITHUB_OUTPUT': str(self.output), 'GITHUB_STEP_SUMMARY': str(self.summary)}
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, self.environment, clear=True).start()
        patch.object(catalog_api, 'verify_backend', return_value='validation').start()
        patch.object(catalog_api.time, 'sleep').start()

    def test_lost_start_response_retries_same_identity_before_outputs(self):
        with patch.object(catalog_api, 'api', side_effect=[OSError('private diagnostics'), {'started': True}]) as api:
            catalog_api.workflow_start()
        self.assertEqual(api.call_count, 2)
        self.assertEqual(api.call_args_list[0], api.call_args_list[1])
        self.assertEqual(api.call_args.kwargs['body'], CONTEXT)
        self.assertEqual(self.output.read_text(), 'proceed=true\nautomatic=true\n')

    def test_superseded_start_reports_no_provider_work(self):
        with patch.object(catalog_api, 'api', return_value={'started': False}) as api:
            catalog_api.workflow_start()
        self.assertEqual(api.call_count, 1)
        self.assertEqual(self.output.read_text(), 'proceed=false\nautomatic=true\n')
        self.assertIn('no provider work', self.summary.read_text())

    def test_lost_finish_response_retries_same_owner_and_outcome(self):
        os.environ['INGEST_OUTCOME'] = 'success'
        with patch.object(catalog_api, 'api', side_effect=[OSError('private diagnostics'), {'finished': True}]) as api:
            catalog_api.workflow_finish()
        self.assertEqual(api.call_count, 2)
        self.assertEqual(api.call_args_list[0], api.call_args_list[1])
        self.assertEqual(api.call_args.kwargs['body'], {**CONTEXT, 'outcome': 'success'})

    def test_rejected_finish_is_visible_and_never_invents_ownership(self):
        os.environ['INGEST_OUTCOME'] = 'failure'
        with patch.object(catalog_api, 'api', return_value={'finished': False}) as api:
            with self.assertRaisesRegex(RuntimeError, 'ownership'):
                catalog_api.workflow_finish()
        self.assertEqual(api.call_count, 1)

    def test_unavailable_lifecycle_is_bounded_and_does_not_reflect_error_text(self):
        with patch.object(catalog_api, 'api', side_effect=RuntimeError('PRIVATE_TOKEN https://private.invalid')) as api:
            with self.assertRaisesRegex(RuntimeError, '^Ingestion runner lifecycle response unavailable$'):
                catalog_api.workflow_start()
        self.assertEqual(api.call_count, 3)
        self.assertFalse(self.output.exists())

    def test_automatic_context_rejects_enrollment_discovery_and_invalid_run_identity(self):
        for key, value in [('SOURCE', 'youtube'), ('IDENTITY', '@caller'), ('DISCOVERY', 'true'),
                           ('GITHUB_RUN_ID', '0'), ('GITHUB_RUN_ATTEMPT', '1;echo unsafe'), ('INGEST_DISPATCH_TICKET', 'invalid')]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}), patch.object(catalog_api, 'api') as api:
                with self.assertRaises(ValueError):
                    catalog_api.workflow_start()
                api.assert_not_called()

    def test_manual_workflow_preserves_explicit_enrollment_and_needs_no_runner_ticket(self):
        with patch.dict(os.environ, {'INGEST_DISPATCH_TICKET': '', 'SOURCE': 'youtube', 'IDENTITY': '@caller', 'DISCOVERY': 'true'}), \
                patch.object(catalog_api, 'api') as api:
            catalog_api.workflow_start()
        api.assert_not_called()
        self.assertEqual(self.output.read_text(), 'proceed=true\nautomatic=false\n')

    def test_existing_work_mode_claims_existing_discovery_without_initializing_it(self):
        job = {'id': 'job', 'lease_token': 'lease', 'source': 'youtube', 'kind': 'discovery', 'state': {}}
        def response(path, **kwargs):
            if path == 'jobs/claim':
                return [job]
            return True
        with patch.object(platform_ingestion, 'runner_context', return_value=CONTEXT), \
                patch.object(platform_ingestion, 'api', side_effect=response) as api, \
                patch.object(platform_ingestion, 'handle_job', return_value={'status': 'waiting', 'state': {}}) as handle:
            result = platform_ingestion.run(1, 30, initialize_discovery=False)
        self.assertEqual(result['jobs'], 1)
        handle.assert_called_once_with(job)
        self.assertEqual(api.call_args_list[0].kwargs['body'], {'include_discovery': True, **CONTEXT})
        self.assertFalse(any(call.args[0] == 'jobs/enqueue' for call in api.call_args_list))

    def test_automatic_empty_install_stays_empty_and_default_discovery_mode_is_rejected(self):
        with patch.object(platform_ingestion, 'runner_context', return_value=CONTEXT), \
                patch.object(platform_ingestion, 'api', return_value=[]) as api:
            result = platform_ingestion.run(1, 30, initialize_discovery=False)
            self.assertEqual(result['jobs'], 0)
            self.assertFalse(any(call.args[0] == 'jobs/enqueue' for call in api.call_args_list))
            api.reset_mock()
            with self.assertRaisesRegex(ValueError, 'existing-work'):
                platform_ingestion.run(1, 30)
            api.assert_not_called()

    def test_one_provider_failure_retains_its_state_and_allows_other_requested_work(self):
        jobs = [{'id': f'job-{n}', 'lease_token': 'lease', 'source': 'youtube', 'kind': 'video', 'attempts': 1,
                 'state': {'cursor': n}} for n in [1, 2]]
        def response(path, **kwargs):
            return [jobs.pop(0)] if path == 'jobs/claim' else True
        with patch.object(platform_ingestion, 'runner_context', return_value=CONTEXT), \
                patch.object(platform_ingestion, 'api', side_effect=response) as api, \
                patch.object(platform_ingestion, 'handle_job', side_effect=[TimeoutError('PRIVATE'), {'status': 'completed', 'vod_ids': [1]}]):
            result = platform_ingestion.run(2, 30, initialize_discovery=False)
        self.assertEqual(result['jobs'], 2)
        # A first transport timeout is a warning: the job keeps its state and retries.
        self.assertEqual((result['errors'], result['warnings']), (0, 1))
        self.assertEqual(result['cataloged'], 1)
        finishes = [call.kwargs['body'] for call in api.call_args_list if call.args[0] == 'jobs/finish']
        self.assertEqual(finishes[0]['state'], {'cursor': 1})
        self.assertEqual(finishes[0]['status'], 'waiting')
        self.assertNotIn('PRIVATE', finishes[0]['error'])
        self.assertEqual(finishes[1]['status'], 'completed')


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / '.github/workflows/ingest-platforms.yml').read_text()

    def test_dispatch_inputs_exist_in_both_triggers_and_environment_guards_match(self):
        call, dispatch = self.workflow.split('  workflow_call:\n', 1)[1].split('  workflow_dispatch:\n', 1)
        dispatch = dispatch.split('\npermissions:', 1)[0]
        expected = {'environment', 'dispatch_ticket', 'source', 'identity', 'discovery', 'dispatch', 'limit', 'seconds',
                    'avatar_backfill', 'apply_avatars'}
        for section in [call, dispatch]:
            self.assertEqual(set(re.findall(r'^      (\w+):$', section, re.M)), expected)
        for environment, branch in BRANCHES.items():
            self.assertIn(f"inputs.environment == '{environment}' && github.ref == 'refs/heads/{branch}'", self.workflow)
        self.assertIn('environment: ${{ inputs.environment }}', self.workflow)
        self.assertIn("group: platform-ingestion-${{ inputs.avatar_backfill && 'avatars-validation' || inputs.environment }}", self.workflow)
        self.assertIn('cancel-in-progress: false', self.workflow)
        ingest = self.workflow.split('\n  ingest:\n', 1)[1]
        timeout = int(re.search(r'timeout-minutes: (\d+)', ingest).group(1))
        worker = (ROOT / 'worker/platform-ingestion-dispatch.ts').read_text()
        lease = int(re.search(r'INGESTION_RUNNING_MINUTES = (\d+)', worker).group(1))
        self.assertEqual(timeout, 35)
        self.assertGreater(lease, timeout)

    def test_actual_shell_builds_distinct_automatic_and_manual_argument_arrays(self):
        section = self.workflow.split('      - name: Run bounded platform ingestion\n', 1)[1]
        script = textwrap.dedent(re.search(r'        run: \|\n((?:          .*\n|\n)+)', section).group(1))
        with tempfile.TemporaryDirectory() as directory:
            command = Path(directory) / 'python'
            command.write_text('#!' + sys.executable + '\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            command.chmod(0o700)
            for ticket, discovery, expected in [('ticket', 'false', '--existing-work'), ('', 'false', '--no-discovery'), ('', 'true', None)]:
                with self.subTest(ticket=ticket, discovery=discovery):
                    result = subprocess.run(['bash', '-e', '-c', script], cwd=directory, capture_output=True, text=True, check=True,
                        env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'INGEST_DISPATCH_TICKET': ticket,
                             'DISCOVERY': discovery, 'INGEST_DISPATCH': 'true', 'INGEST_LIMIT': '30', 'INGEST_SECONDS': '1200'})
                    args = json.loads(result.stdout)
                    self.assertEqual(args[:6], ['scripts/platform_ingestion.py', 'run', '--limit', '30', '--seconds', '1200'])
                    self.assertIn('--dispatch', args)
                    self.assertEqual([arg for arg in args if arg in ('--existing-work', '--no-discovery')], [expected] if expected else [])

    def test_superseded_runner_cannot_reach_provider_steps_and_accepted_runner_always_finishes(self):
        self.assertLess(self.workflow.index('id: runner'), self.workflow.index('denoland/setup-deno'))
        self.assertIn("steps.runner.outputs.automatic == 'false' && inputs.identity", self.workflow)
        self.assertIn("if: always() && steps.runner.outputs.proceed == 'true' && steps.runner.outputs.automatic == 'true'", self.workflow)
        for name in ['denoland/setup-deno@v2', "pip install 'yt-dlp", 'name: Run bounded platform ingestion']:
            block = self.workflow.split('      - ', 1)[1]
            selected = next(step for step in block.split('      - ') if name in step)
            self.assertIn("if: steps.runner.outputs.proceed == 'true'", selected)


class TransientFailureTests(unittest.TestCase):
    job = {'attempts': 1}
    result = {'error': 'videos: http_412; public catalog unavailable', 'error_categories': ['http_412']}

    def test_only_retryable_provider_blips_on_a_finished_lease_are_warnings(self):
        self.assertTrue(platform_ingestion.transient_failure(self.job, self.result, True))
        for job, result, finished in (
                (self.job, self.result, False),                                       # Lease not finished.
                ({'attempts': 3}, self.result, True),                                  # Persistent outage.
                (self.job, {**self.result, 'error_categories': ['http_412', 'invalid_data']}, True),
                (self.job, {**self.result, 'error_categories': []}, True),
                (self.job, {**self.result, 'error_categories': ['runtime_failure']}, True),
                (self.job, {'error': None, 'error_categories': []}, True)):
            self.assertFalse(platform_ingestion.transient_failure(job, result, finished))

    def test_warnings_annotate_the_run_but_only_errors_fail_it(self):
        for summary, code in (({'jobs': 3, 'errors': 0, 'warnings': 2, 'cataloged': 0, 'dispatched': 0}, None),
                              ({'jobs': 3, 'errors': 1, 'warnings': 2, 'cataloged': 0, 'dispatched': 0}, 1)):
            with self.subTest(errors=summary['errors']), \
                    patch.object(sys, 'argv', ['platform_ingestion.py', 'run', '--existing-work']), \
                    patch.object(platform_ingestion, 'verify_backend'), \
                    patch.object(platform_ingestion, 'run', return_value=summary), \
                    patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
                    patch('builtins.print') as output:
                if code is None:
                    platform_ingestion.main()
                else:
                    with self.assertRaises(SystemExit) as caught:
                        platform_ingestion.main()
                    self.assertEqual(caught.exception.code, code)
                annotations = [str(call.args[0]) for call in output.call_args_list if call.kwargs.get('file') is sys.stderr]
                self.assertTrue(any(line.startswith('::warning title=Transient provider failures::2 job(s)') for line in annotations))
                # stdout is tee'd into ingestion-result.jsonl and must stay JSON lines.
                for call in output.call_args_list:
                    if call.kwargs.get('file') is not sys.stderr:
                        json.loads(str(call.args[0]))


if __name__ == '__main__':
    unittest.main()
