#!/usr/bin/env python3
"""Backfill matchups.indexed_at (migration 0030) in ID batches small enough for D1. Safe to rerun."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from database import command

BATCH = 10000
UPDATE = """UPDATE matchups SET indexed_at=(SELECT max(d.created_at) FROM matchup_anchors a JOIN detections d ON d.id=a.current_detection_id
 WHERE a.matchup_id=matchups.id) WHERE id>{low} AND id<={high} AND indexed_at IS NULL"""


def run(environment: str, sql: str) -> list:
    with tempfile.TemporaryDirectory(prefix='bazaarghost-d1-') as directory:
        body = Path(directory) / 'query.json'
        body.write_text(json.dumps({'sql': sql}))
        body.chmod(0o600)
        output = subprocess.run(command('execute', environment, body=body),
                                check=True, capture_output=True, text=True).stdout
    return json.loads(output[output.index('['):])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', required=True, choices=['local', 'validation', 'dev', 'production'])
    args = parser.parse_args()
    top = run(args.environment, 'SELECT coalesce(max(id),0) FROM matchups')[0]['results']['rows'][0][0]
    for low in range(0, top, BATCH):
        result = run(args.environment, UPDATE.format(low=low, high=low + BATCH))[0]
        print(f'ids ({low},{low + BATCH}]: {result["meta"]["changes"]} updated')


if __name__ == '__main__':
    main()
