import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_image', Path(__file__).resolve().parents[1] / 'runtime_image.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeImageTests(unittest.TestCase):
    image = 'ghcr.io/liftaris/bazaar-ghost/sfde-next@sha256:' + 'a' * 64
    revision = 'b' * 40

    def test_pinned_image_must_belong_to_this_runtime(self):
        runtime.validate(self.image, self.revision)
        for image in ['sfde:dev', self.image.replace('@sha256:', ':'),
                      self.image.replace('ghcr.io', 'other.example'),
                      self.image.replace('sfde-next', 'another-package'), self.image + '\n']:
            with self.subTest(image=image), self.assertRaises(ValueError):
                runtime.validate(image, self.revision)
        with self.assertRaises(ValueError):
            runtime.validate(self.image, 'migration/cloudflare')

    def test_pulled_image_must_match_the_checked_out_processor(self):
        def metadata(revision):
            return json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': revision}}}])
        with patch.object(runtime.subprocess, 'check_output', return_value=metadata(self.revision)) as inspect:
            runtime.verify(self.image, self.revision)
            inspect.assert_called_once_with(['docker', 'image', 'inspect', self.image], text=True)
        with patch.object(runtime.subprocess, 'check_output', return_value=metadata('c' * 40)):
            with self.assertRaisesRegex(ValueError, 'does not match'):
                runtime.verify(self.image, self.revision)
