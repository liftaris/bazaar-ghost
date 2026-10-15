#!/usr/bin/env python3
"""Start an isolated container. The parent/operator supplies a registration token on stdin."""
import argparse
import re
import subprocess
import sys


def container_command(label, image):
    if not re.fullmatch(r'bazaarghost-validation-[a-f0-9]{32}', label):
        raise ValueError('Expected a unique validation runner label')
    if not re.fullmatch(r'[a-zA-Z0-9._:/@-]+', image) or image.startswith('-'):
        raise ValueError('Invalid image reference')
    return ['docker', 'run', '--rm', '--pull=never', '--init', '-i', '--name', label,
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=512',
            '--cpus=4', '--memory=12g', '--shm-size=2g', '--env', f'RUNNER_LABEL={label}', image]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label', required=True)
    parser.add_argument('--image', default='bazaarghost-validation-runner:2.338.0')
    args = parser.parse_args()
    command = container_command(args.label, args.image)
    token = sys.stdin.readline(2050).strip()
    if not token or len(token) > 2048 or any(character.isspace() for character in token):
        raise SystemExit('Provide one registration token on stdin')
    raise SystemExit(subprocess.run(command, input=token + '\n', text=True).returncode)


if __name__ == '__main__':
    main()
