#!/usr/bin/env python3
"""Replay saved clock evidence; optionally apply corrections from reviewed image fixtures."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sfde/src'))
sys.path.insert(0, str(ROOT / 'scripts'))
from backend_environment import open_backend


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--expected-build', required=True)
    parser.add_argument('--fixtures', type=Path, default=ROOT / 'sfde/tests/fixtures/clock_modes')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--admin-secrets', type=Path)
    args = parser.parse_args()
    base = args.api_url.rstrip('/')
    if base != 'https://bazaarghost-validation.kaio-8df.workers.dev':
        parser.error('This replay targets the validation backend only')
    if args.apply and not args.admin_secrets:
        parser.error('--apply requires --admin-secrets')

    def request(path, payload=None, key=None):
        headers = {'Content-Type': 'application/json'}
        if key:
            headers['Authorization'] = 'Bearer ' + key
        req = urllib.request.Request(base + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     method='PUT' if payload is not None else 'GET')
        with open_backend(req, timeout=60) as response:
            return json.load(response)

    health = request('/health')
    if health.get('environment') != 'validation' or health.get('build_commit') != args.expected_build:
        raise ValueError('Validation build does not match the reviewed runtime')
    key = json.loads(args.admin_secrets.read_text())['ADMIN_KEY'] if args.apply else None
    import cv2
    import numpy as np
    from clock_reader import ClockReader
    from ocr_runtime import create_clock_text_reader, create_ocr_reader
    clock = ClockReader(create_ocr_reader(), text_reader=create_clock_text_reader())
    report = {'backend': health, 'applied': args.apply, 'cases': []}
    for label in json.loads((args.fixtures / 'labels.json').read_text())['cases']:
        detail = request(f"/api/v1/matchups/{label['id']}")
        evidence = detail['fieldEvidence']['igd']
        with open_backend(urllib.request.Request(base + evidence['screenshotUrl']), timeout=60) as response:
            data = response.read(5 * 1024 * 1024 + 1)
        expected = (args.fixtures / f"igd-full-{label['id']}.jpg").read_bytes()
        if hashlib.sha256(data).digest() != hashlib.sha256(expected).digest():
            raise ValueError(f"Matchup {label['id']} evidence changed since image review")
        observed = clock.observe(cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR))
        record = {'matchupId': label['id'], 'detectionId': evidence['detectionId'],
                  'recordingId': evidence['recordingId'], 'screenshotUrl': evidence['screenshotUrl'],
                  'before': detail['encounter']['igd'], 'reviewedDay': label['day'],
                  'observed': observed, 'changed': False}
        if args.apply and detail['encounter']['igd'] != label['day']:
            path = f"/api/admin/detections/{evidence['detectionId']}/igd-correction"
            before = request(path, key=key)
            request(path, {'inputDigest': before['inputDigest'], 'igd': label['day'],
                          'method': 'reviewed_day_medallion_v2', 'actor': 'igd-reviewed-fixture-replay',
                          'reason': 'Manually reviewed day medallion; exact source JPEG matches versioned fixture',
                          'sourceRefs': [{'detectionId': evidence['detectionId'], 'field': 'igd'}]}, key)
            after = request(path, key=key)
            if before['rawIgd'] != after['rawIgd'] or before['rawFieldEvidence'] != after['rawFieldEvidence']:
                raise AssertionError('Correction changed the raw observation')
            public = request(f"/api/v1/matchups/{label['id']}")
            if public['encounter']['igd'] != label['day'] or public['opponent']['igd'] != label['day']:
                raise AssertionError('Public effective day does not match correction')
            if public['encounter']['rawIgd'] != before['rawIgd'] or not public['encounter']['igdCorrection']:
                raise AssertionError('Public raw day or correction provenance missing')
            record.update(changed=True, after=public['encounter'])
        report['cases'].append(record)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2))
    report['summary'] = {
        'total': len(report['cases']),
        'localCorrect': sum(r['observed']['igd'] == r['reviewedDay'] for r in report['cases']),
        'localMissing': sum(r['observed']['igd'] is None for r in report['cases']),
        'localIncorrect': sum(r['observed']['igd'] not in (None, r['reviewedDay']) for r in report['cases']),
        'correctionsApplied': sum(r['changed'] for r in report['cases']),
    }
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report['summary']))


if __name__ == '__main__':
    main()
