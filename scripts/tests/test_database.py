import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import database


class DatabaseCommandTests(unittest.TestCase):
    def test_local_commands_use_project_state_and_never_remote_defaults(self):
        for action in ['migrate', 'execute']:
            args = database.command(action, 'local', body=Path('/tmp/query.json'))
            self.assertIn('--local', args)
            self.assertEqual(args[args.index('--persist-to') + 1], str(ROOT / '.wrangler/state'))
            self.assertEqual(args[args.index('--mode') + 1], 'local')
            self.assertNotIn('4159adb1-b0af-4a3e-9a0c-755dfe5d822c', args)

    def test_validation_uses_exact_database_and_mode(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/migration/cloudflare'}, clear=True):
            args = database.command('migrate', 'validation')
        self.assertIn('4159adb1-b0af-4a3e-9a0c-755dfe5d822c', args)
        self.assertNotIn('--local', args)
        self.assertIn(str(ROOT / 'worker/migrations'), args)
        self.assertEqual(args[args.index('--mode') + 1], 'validation')

    def test_remote_operations_refuse_other_branches_and_accounts(self):
        for values in [{'GITHUB_REF': 'refs/heads/main'}, {'CLOUDFLARE_ACCOUNT_ID': 'wrong-account'}]:
            with self.subTest(values=values), patch.dict(os.environ, values, clear=True), self.assertRaises(ValueError):
                database.command('migrate', 'validation')

    def test_unprovisioned_environments_and_remote_persistence_fail_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            for environment in ['dev', 'production']:
                with self.subTest(environment=environment), self.assertRaises(ValueError):
                    database.command('migrate', environment)
            with self.assertRaisesRegex(ValueError, 'local environment'):
                database.command('migrate', 'validation', persist_to=Path('/tmp/state'))

    def test_sql_file_uses_body_file_instead_of_sql_in_argv(self):
        args = database.command('execute', 'local', body=Path('/tmp/query.json'))
        self.assertEqual(args[args.index('--body') + 1], '@/tmp/query.json')
        self.assertNotIn('--sql', args)
