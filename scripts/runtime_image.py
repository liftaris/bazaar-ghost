"""Validate the tested runtime identity before pulling it or deploying its pointer."""
import json
import os
import re
import subprocess
import sys


def validate(image: str, revision: str) -> None:
    if not re.fullmatch(r'ghcr\.io/liftaris/bazaar-ghost/sfde-next@sha256:[0-9a-f]{64}', image):
        raise ValueError('Expected a digest-pinned BazaarGhost runtime image')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Expected the tested processor commit')


def verify(image: str, revision: str) -> None:
    validate(image, revision)
    metadata = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))
    labels = metadata[0]['Config'].get('Labels') or {}
    if labels.get('org.opencontainers.image.revision') != revision:
        raise ValueError('Runtime image does not match the tested processor commit')


if __name__ == '__main__':
    commands = {'validate': validate, 'verify': verify}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit('Usage: runtime_image.py validate|verify')
    commands[sys.argv[1]](os.environ['SFDE_RUNTIME_IMAGE'], os.environ['BUILD_COMMIT'])
