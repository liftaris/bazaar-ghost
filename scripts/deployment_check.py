#!/usr/bin/env python3
"""Validate cf resource isolation and the invoking branch before remote operations."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
BRANCHES = {'dev': 'refs/heads/dev', 'production': 'refs/heads/main',
            'validation': 'refs/heads/migration/cloudflare'}
ZERO_UUID = '00000000-0000-0000-0000-000000000000'


def read_environments(root=ROOT):
    return json.loads((Path(root) / 'config/environments.json').read_text())


def resource_names(config):
    database = config['database']
    return {
        'Worker name': {config['name']},
        'database': {str(UUID(database['id']))} - {ZERO_UUID},
        'database name': {database['name']},
        'storage bucket': set(config['buckets'].values()),
        'queue': set(config['queue'].values()),
    }


def validate(target, root=ROOT, ref=None):
    if target not in BRANCHES:
        raise ValueError('Target must be dev, production or validation')
    if ref is not None and ref != BRANCHES[target]:
        raise ValueError(f'{target} deployment requires branch {BRANCHES[target]}')
    environments = read_environments(root)
    config = environments[target]
    if config['vars']['ENVIRONMENT'] != target:
        raise ValueError('Environment mismatch')
    if config['name'] != f'bazaarghost-{target}':
        raise ValueError('Worker name must match the target environment')
    public_url = config['vars']['PUBLIC_URL']
    url = urlsplit(public_url)
    if ('REPLACE_ME' in public_url or url.scheme != 'https' or not url.hostname
            or url.username or url.password or url.query or url.fragment or url.path not in ('', '/')):
        raise ValueError('Set the public HTTPS Worker origin without credentials, path or query')
    site_url = urlsplit(config['vars']['PUBLIC_SITE_URL'])
    if 'REPLACE_ME' in site_url.geturl() or site_url.scheme != 'https' or not site_url.hostname or site_url.path not in ('', '/'):
        raise ValueError('Set the frontend HTTPS origin used in notification links')
    database = config['database']
    if database['name'] != f'bazaarghost-{target}':
        raise ValueError('Database name must match the target environment')
    try:
        database_id = str(UUID(database['id']))
    except ValueError as error:
        raise ValueError('Set the provisioned D1 database UUID') from error
    if database_id == ZERO_UUID:
        raise ValueError('Set the provisioned D1 database ID')
    buckets = config['buckets']
    if set(buckets) != {'DETECTIONS', 'LOGS'} or len(set(buckets.values())) != 2 or any('local' in name for name in buckets.values()):
        raise ValueError('Deployment buckets must be distinct and cannot be local')
    if not config['workersDev']:
        raise ValueError('Configure the public workers.dev origin before deployment')
    if target == 'validation':
        if config.get('routes') or config.get('domains') or not config['workersDev']:
            raise ValueError('Validation uses only its dedicated workers.dev hostname')
        if not url.hostname.startswith('bazaarghost-validation.') or not url.hostname.endswith('.workers.dev'):
            raise ValueError('Validation URL must be its dedicated workers.dev hostname')
        expected = {'DETECTIONS': 'bazaarghost-validation-detections', 'LOGS': 'bazaarghost-validation-logs'}
        if buckets != expected:
            raise ValueError('Validation bucket names must use its isolated namespace')
        if config['queue'] != {'name': 'bazaarghost-validation-jobs', 'deadLetterQueue': 'bazaarghost-validation-dlq'}:
            raise ValueError('Validation queues must use its isolated namespace')
    resources = resource_names(config)
    for other in BRANCHES:
        if other == target:
            continue
        if other not in environments:
            raise ValueError(f'Missing comparison configuration: {other}')
        for kind, names in resource_names(environments[other]).items():
            if resources[kind] & names:
                raise ValueError(f'{target} and {other} must not share a {kind}')
    return config


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', choices=BRANCHES)
    parser.add_argument('--ref', default=os.environ.get('GITHUB_REF'))
    args = parser.parse_args()
    validate(args.target, ref=args.ref)
    print(f'Deployment configuration validated: {args.target}')
