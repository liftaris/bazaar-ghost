import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_youtube_pot import check, token_evidence


class YouTubePotTests(unittest.TestCase):
    def test_login_failure_is_distinct_from_token_failure_and_redacts_diagnostics(self):
        stderr = ('PO Token Providers: bgutil:http-2.0.2 (external)\n'
                  'mweb player response playability status: LOGIN_REQUIRED\n'
                  'Sign in to confirm you are not a bot https://example.com/?token=private')
        with patch('check_youtube_pot.subprocess.run', return_value=SimpleNamespace(returncode=1, stderr=stderr)):
            result = check('jwxFzTcvWLs', 'mweb', Path('.'))
        self.assertEqual(result['error'], 'auth_required')
        self.assertEqual(result['failure_stage'], 'extraction')
        self.assertTrue(result['provider_loaded'])
        self.assertFalse(result['token_requested'])
        self.assertEqual(result['player_statuses'], ['LOGIN_REQUIRED'])
        self.assertNotIn('private', json.dumps(result))

    def test_browser_provider_and_player_token_are_recognized(self):
        result = token_evidence('PO Token Providers: wpc-1.1.2 (external)\n'
                                'Generating a player PO Token\n'
                                'Retrieved a player PO Token for mweb client', 'wpc')
        self.assertTrue(result['provider_loaded'])
        self.assertTrue(result['token_requested'])
        self.assertTrue(result['token_retrieved'])

    def test_control_disables_plugins_and_force_requests_player_tokens(self):
        for policy in ('never', 'always'):
            with patch('check_youtube_pot.subprocess.run', return_value=SimpleNamespace(returncode=1, stderr='HTTP Error 403')) as run:
                check('jwxFzTcvWLs', 'mweb', Path('.'), 'bgutil', policy)
            command = run.call_args.args[0]
            self.assertIn(f'youtube:player_client=mweb;fetch_pot={policy}', command)
            self.assertEqual('--no-plugin-dirs' in command, policy == 'never')


if __name__ == '__main__':
    unittest.main()
