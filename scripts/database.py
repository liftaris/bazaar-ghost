#!/usr/bin/env python3
"""Run cf D1 operations with explicit environment and isolated local persistence."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from deployment_check import ROOT, read_environments, validate


def command(action, environment, *, body=None, persist_to=None):
    settings = read_environments()[environment] if environment == 'local' else validate(environment, ref=os.getenv('GITHUB_REF'))
    args = [str(ROOT / 'node_modules/.bin/cf'), 'd1']
    if action == 'migrate':
        args += ['migrations', 'apply', settings['database']['id'], '--dir', str(ROOT / 'worker/migrations')]
    else:
        args += ['raw', settings['database']['id'], '--body', '@' + str(body)]
    args += ['--mode', environment]
    if environment == 'local':
        args += ['--local', '--persist-to', str(persist_to or ROOT / '.wrangler/state')]
    elif persist_to:
        raise ValueError('--persist-to applies only to the local environment')
    account = settings.get('accountId')
    if account and os.getenv('CLOUDFLARE_ACCOUNT_ID', account) != account:
        raise ValueError('CLOUDFLARE_ACCOUNT_ID does not match the selected environment')
    return args


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['migrate', 'execute'])
    parser.add_argument('--environment', required=True, choices=['local', 'validation', 'dev', 'production'])
    parser.add_argument('--file', type=Path)
    parser.add_argument('--persist-to', type=Path)
    args = parser.parse_args()
    if (args.action == 'execute') != (args.file is not None):
        parser.error('execute requires --file; migrate does not accept it')
    if args.file:
        with tempfile.TemporaryDirectory(prefix='bazaarghost-d1-') as directory:
            body = Path(directory) / 'query.json'
            body.write_text(json.dumps({'sql': args.file.read_text()}))
            body.chmod(0o600)
            subprocess.run(command(args.action, args.environment, body=body, persist_to=args.persist_to), check=True)
    else:
        subprocess.run(command(args.action, args.environment, persist_to=args.persist_to), check=True)


if __name__ == '__main__':
    main()
