import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('deployment', ROOT / 'scripts/deployment_check.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.configs = {}
        for number, target in enumerate(deployment.BRANCHES, 1):
            config = deployment.read_environments()[target]
            config['database']['id'] = f'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa{number}'
            config['workersDev'] = True
            config['vars']['PUBLIC_URL'] = f'https://bazaarghost-{target}.example.workers.dev'
            self.configs[target] = config
        self.write_configs()

    def write_configs(self):
        (self.root / 'config').mkdir(exist_ok=True)
        (self.root / 'config/environments.json').write_text(json.dumps(self.configs))

    def validate(self, target='validation', ref=None):
        self.write_configs()
        return deployment.validate(target, self.root, ref=ref or deployment.BRANCHES[target])

    def test_all_environments_validate_when_concrete_and_isolated(self):
        for target in deployment.BRANCHES:
            with self.subTest(target=target):
                self.assertEqual(self.validate(target)['vars']['ENVIRONMENT'], target)

    def test_validation_twitch_schedules_preserve_other_environments(self):
        provider_schedules = ['*/3 * * * *', '0 * * * *', '0 0,12 * * *', '0 2 * * *', '0 3 * * *']
        for target in ['local', 'dev', 'production', 'validation']:
            config = deployment.read_environments()[target]
            with self.subTest(target=target):
                expected = ['* * * * *'] + (['*/3 * * * *', '0 * * * *', '0 2 * * *'] if target == 'validation' else provider_schedules)
                self.assertEqual(config['crons'], expected)
                self.assertEqual(config['vars']['ENVIRONMENT'], target)
                self.assertEqual(config['vars']['OUTBOUND_ENABLED'], 'true' if target == 'validation' else 'false')

    def test_rejects_cross_environment_branch_and_tags(self):
        for ref in ['refs/heads/dev', 'refs/heads/main', 'refs/tags/migration/cloudflare']:
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, 'requires branch'):
                self.validate(ref=ref)

    def test_rejects_production_database_even_when_uuid_case_differs(self):
        self.configs['validation']['database']['id'] = self.configs['production']['database']['id'].upper()
        with self.assertRaisesRegex(ValueError, 'must not share a database'):
            self.validate()

    def test_rejects_wrong_worker_database_and_bucket_names(self):
        original = copy.deepcopy(self.configs['validation'])
        for field in ['name', 'database', 'bucket']:
            self.configs['validation'] = copy.deepcopy(original)
            config = self.configs['validation']
            if field == 'name':
                config['name'] = 'bazaarghost-production'
            elif field == 'database':
                config['database']['name'] = 'bazaarghost-production'
            else:
                config['buckets']['DETECTIONS'] = 'bazaarghost-detections-production'
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate()

    def test_rejects_primary_and_dead_letter_queue_reuse(self):
        original = copy.deepcopy(self.configs['validation'])
        for key in ['name', 'deadLetterQueue']:
            self.configs['validation'] = copy.deepcopy(original)
            self.configs['validation']['queue'][key] = 'bazaarghost-production'
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'queues'):
                self.validate()

    def test_rejects_any_custom_domain_in_validation(self):
        for key in ['domains', 'routes']:
            self.configs['validation'][key] = ['bazaarghost.stream/*'] if key == 'routes' else 'bazaarghost.stream/*'
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'dedicated workers.dev'):
                self.validate()
            del self.configs['validation'][key]

    def test_rejects_placeholder_database_and_unsafe_urls(self):
        original = copy.deepcopy(self.configs['validation'])
        self.configs['validation']['database']['id'] = deployment.ZERO_UUID
        with self.assertRaisesRegex(ValueError, 'provisioned D1'):
            self.validate()
        for url in ['http://example.com', 'https://user:password@example.com', 'https://example.com/path',
                    'https://example.com?query=yes', 'https://bazaarghost-production.example.workers.dev',
                    'https://bazaarghost-validation.REPLACE_ME.workers.dev']:
            self.configs['validation'] = copy.deepcopy(original)
            self.configs['validation']['vars']['PUBLIC_URL'] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.validate()

    def test_detects_queue_collision_from_the_other_configuration(self):
        self.configs['production']['queue']['deadLetterQueue'] = 'bazaarghost-validation-dlq'
        with self.assertRaisesRegex(ValueError, 'must not share a queue'):
            self.validate()

    def test_missing_comparison_configuration_fails_closed(self):
        del self.configs['production']
        self.write_configs()
        with self.assertRaisesRegex(ValueError, 'Missing comparison'):
            deployment.validate('validation', self.root)



if __name__ == '__main__':
    unittest.main()
