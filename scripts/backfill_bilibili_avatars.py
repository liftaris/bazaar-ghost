#!/usr/bin/env python3
"""Refresh existing Bilibili account avatars, dry-run unless --apply is supplied.

Uses ENVIRONMENT, BAZAARGHOST_API_URL and BAZAARGHOST_CATALOG_KEY. Repeat --uid
for each existing account. Only avatar_url is patched; no jobs are enqueued.
"""

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

from backend_environment import verify_backend
from catalog_api import api
from catalog_bilibili import avatar_url
from platform_discovery import bilibili_api
from database import command


def existing_uids(environment: str):
    """Inventory all existing accounts from the selected D1, including non-public ones."""
    if environment != 'validation':
        raise ValueError('Bulk avatar backfill is validation-only')
    with tempfile.TemporaryDirectory() as directory:
        query = Path(directory) / 'query.json'
        query.write_text(json.dumps({'sql': "SELECT source_id FROM platform_accounts WHERE source='bilibili' ORDER BY source_id LIMIT 1001"}))
        result = json.loads(subprocess.check_output(command('execute', environment, body=query), text=True))
    values = result[0]['results']
    identities = [row[values['columns'].index('source_id')] for row in values['rows']]
    if len(identities) > 1000:
        raise ValueError('Bulk backfill exceeds 1000 accounts; split into explicit UID batches')
    return identities


def refresh(identity: str, apply: bool = False):
    if not re.fullmatch(r'[1-9][0-9]*', identity):
        raise ValueError('Expected Bilibili uploader UID')
    accounts = api('accounts', {'source': 'bilibili', 'source_id': identity})
    if not accounts:
        raise ValueError('Account must already exist')
    account = accounts[0]
    owner = bilibili_api('/x/web-interface/card', {'mid': identity})['card']
    if str(owner['mid']) != identity:
        raise ValueError('Uploader identity mismatch')
    face = avatar_url(owner.get('face'))
    status = 'missing' if face is None else 'unchanged' if face == account.get('avatar_url') else 'pending'
    if status == 'pending' and apply:
        saved = api('accounts/' + account['id'], body={'avatar_url': face}, method='PATCH')
        if saved.get('avatar_url') != face:
            raise RuntimeError('Backend did not persist avatar URL')
        status = 'updated'
    return {'uid': identity, 'account_id': account['id'], 'avatar_url': face, 'status': status}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--uid', action='append')
    selection.add_argument('--all-existing', action='store_true', help='Inventory up to 1000 validation D1 accounts via cf')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    environment = verify_backend()
    identities = existing_uids(environment) if args.all_existing else args.uid
    for identity in dict.fromkeys(identities):
        print(json.dumps(refresh(identity, args.apply)), flush=True)


if __name__ == '__main__':
    main()
