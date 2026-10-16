"""Execute the workflow's chunk-fetch shell with a fake HTTP client."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / '.github' / 'workflows' / 'process-vod.yml'
CHUNK_ID = '12345678-1234-1234-1234-123456789abc'


class WorkflowFetchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.output = self.directory / 'outputs'
        self.calls = self.directory / 'http-calls'
        curl = self.directory / 'curl'
        curl.write_text(f'#!{sys.executable}\n' + textwrap.dedent('''\
            import json
            import os
            import sys
            with open(os.environ['HTTP_CALLS'], 'a') as destination:
                destination.write(json.dumps(sys.argv[1:]) + '\\n')
            print(os.environ['HTTP_RESPONSE'])
            sys.exit(int(os.environ.get('HTTP_STATUS', '0')))
        '''))
        curl.chmod(0o755)
        self.env = dict(os.environ, VOD_ID='123456', INPUT_CHUNKS='',
                        SUPABASE_URL='https://example.invalid', SUPABASE_SECRET_KEY='test',
                        GITHUB_OUTPUT=str(self.output), HTTP_CALLS=str(self.calls),
                        HTTP_RESPONSE=json.dumps([{'chunk_id': CHUNK_ID}]),
                        HTTP_STATUS='0', PATH=f"{self.directory}{os.pathsep}{os.environ['PATH']}")

    def run_fetch(self):
        # Run the real shell stored in Actions, without adding a YAML dependency.
        step = re.search(r'^      - name: Determine chunk UUIDs\n(.*?)(?=^  # Process all chunks)',
                         WORKFLOW.read_text(), re.MULTILINE | re.DOTALL).group(1)
        shell = textwrap.dedent(step.split('        run: |\n', 1)[1])
        return subprocess.run(['bash', '-e', '-o', 'pipefail'], input=shell,
                              text=True, capture_output=True, env=self.env, timeout=5)

    def http_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_explicit_chunk_ids_do_not_call_database(self):
        self.env['INPUT_CHUNKS'] = json.dumps([CHUNK_ID], indent=2)
        result = self.run_fetch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.http_calls(), [])
        self.assertEqual(self.output.read_text(), f'chunk_uuids=["{CHUNK_ID}"]\n')

    def test_empty_selection_fetches_only_requested_vod_using_post(self):
        for selection in ('', '[]', ' [ ] '):
            with self.subTest(selection=selection):
                if self.calls.exists():
                    self.calls.unlink()
                self.env['INPUT_CHUNKS'] = selection
                result = self.run_fetch()
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = self.http_calls()
                self.assertEqual(len(calls), 1)
                self.assertIn('POST', calls[0])
                self.assertIn('https://example.invalid/rest/v1/rpc/get_pending_chunks_for_vod', calls[0])
                self.assertEqual(json.loads(calls[0][calls[0].index('--data') + 1]), {'p_source_id': '123456'})

    def test_input_cannot_execute_shell_or_inject_github_output(self):
        marker = self.directory / 'injected'
        for selection in [f"'; touch {marker}; #", json.dumps([f'$(touch {marker})']),
                          json.dumps([f'{CHUNK_ID}\navailable=false']), '{"chunk_id":"other"}']:
            with self.subTest(selection=selection):
                self.env['INPUT_CHUNKS'] = selection
                self.assertNotEqual(self.run_fetch().returncode, 0)
                self.assertFalse(marker.exists())
                self.assertFalse(self.output.exists())
                self.assertEqual(self.http_calls(), [])

    def test_vod_filter_injection_is_rejected_before_api_call(self):
        self.env['VOD_ID'] = '123&source_id=neq.other'
        self.assertNotEqual(self.run_fetch().returncode, 0)
        self.assertEqual(self.http_calls(), [])

    def test_rpc_failure_or_no_pending_chunks_cannot_rewrite_completed_siblings(self):
        for response, status in [('[]', '0'), ('{"error":"failed"}', '0'),
                                 ('[{"chunk_id":"invalid"}]', '0'), ('', '22')]:
            with self.subTest(response=response, status=status):
                if self.calls.exists():
                    self.calls.unlink()
                self.env.update(HTTP_RESPONSE=response, HTTP_STATUS=status)
                self.assertNotEqual(self.run_fetch().returncode, 0)
                calls = self.http_calls()
                self.assertEqual(len(calls), 1)
                self.assertIn('POST', calls[0])
                self.assertNotIn('PATCH', calls[0])
                self.assertFalse(self.output.exists())

    def test_workflow_has_no_vod_status_failure_writes(self):
        # A processing->failed VOD update fires a production trigger that
        # marks every sibling failed, including already completed chunks.
        self.assertNotIn('/rest/v1/vods?', WORKFLOW.read_text())

    def test_worker_deadline_fits_processing_step_and_job_setup_budget(self):
        workflow = WORKFLOW.read_text().split('  process-chunk:\n', 1)[1]
        job_minutes = int(re.search(r'^    timeout-minutes: (\d+)', workflow, re.MULTILINE)[1])
        worker = workflow.split('      - name: Process chunk with SFOT\n', 1)[1]
        step_minutes = int(re.search(r'^        timeout-minutes: (\d+)', worker, re.MULTILINE)[1])
        config = (WORKFLOW.parents[2] / 'sfot' / 'config.yaml').read_text()
        runtime_seconds = int(re.search(r'^  timeout: (\d+)', config, re.MULTILINE)[1])
        self.assertEqual(runtime_seconds, 1800)
        self.assertGreaterEqual(step_minutes * 60 - runtime_seconds, 300)
        # Leave 15 minutes outside the processing step for Buildx/build/setup.
        self.assertGreaterEqual(job_minutes - step_minutes, 15)


if __name__ == '__main__':
    unittest.main()
