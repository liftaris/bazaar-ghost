import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/generate_frontend_api.py'


def run(output, *extra):
    return subprocess.run([sys.executable, str(SCRIPT), '--output', str(output), *extra], capture_output=True, text=True)


class FrontendApiGeneratorTests(unittest.TestCase):
    def test_emits_one_contract_and_client_that_pass_their_own_check(self):
        with tempfile.TemporaryDirectory() as output:
            self.assertEqual(run(output).returncode, 0)
            self.assertEqual(sorted(path.name for path in (Path(output) / 'lib').iterdir()), ['api-client.ts', 'api-contract.ts'])
            self.assertEqual(run(output, '--check').returncode, 0)
            contract = (Path(output) / 'lib/api-contract.ts').read_text()
            self.assertIn('export type PlatformId = string;', contract)
            self.assertNotIn('"twitch" | "youtube"', contract)
            self.assertIn('fetch(`/api/v1${path}', (Path(output) / 'lib/api-client.ts').read_text())

    def test_check_fails_on_a_stale_or_missing_file(self):
        with tempfile.TemporaryDirectory() as output:
            self.assertNotEqual(run(output, '--check').returncode, 0)
            run(output)
            target = Path(output) / 'lib/api-contract.ts'
            target.write_text(target.read_text() + '\n// drift\n')
            self.assertNotEqual(run(output, '--check').returncode, 0)


if __name__ == '__main__':
    unittest.main()
