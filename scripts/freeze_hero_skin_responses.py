"""Freeze selected existing Clef outputs without network access or image copies."""
import argparse
import base64
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def freeze(root):
    prompt_file = root / 'optimizer/candidate-v7.json'
    prompt = json.loads(prompt_file.read_text())
    assert digest(prompt_file.read_bytes()) == 'fb6f8dd45c3a0eaaa2eee6a358b66c7c6a72bd1f1a6a08bb4a51355961026970'
    results_file = root / 'optimizer/runs/v7-all-738-resume/results.json'
    baseline_file = root / 'eval/runs/gameplay-baseline/results.json'
    results = json.loads(results_file.read_text())
    baseline = {row['id']: row for row in json.loads(baseline_file.read_text())}
    selected = {row['id'] for row in results if row['domain'] == 'historical_gameplay'}
    rejected = [row for row in baseline.values() if row['top_probability'] < .60 or row['margin'] < .30]
    for hero in {row['expected'] for row in rejected}:
        selected.add(min((row for row in rejected if row['expected'] == hero), key=lambda row: row['top_probability'])['id'])
    skins = [row for row in results if row['domain'] == 'skin_reference']
    for key in ('top_probability', 'margin'):
        selected.update(row['id'] for row in sorted(skins, key=lambda row: row[key])[:2])
    frozen = []
    for row in results:
        if row['id'] not in selected:
            continue
        cache_file = root / 'eval/cache' / (row['cache_key'] + '.json')
        cache = json.loads(cache_file.read_text())
        image = Path(row['path']).read_bytes()
        assert image.startswith(b'\x89PNG\r\n\x1a\n')
        dimensions = [int.from_bytes(image[16:20], 'big'), int.from_bytes(image[20:24], 'big')]
        body = encoded({**prompt, 'images': [{'content_type': 'image/png', 'base64': base64.b64encode(image).decode()}]})
        assert digest(image) == cache['image_sha256'] == row['sha256']
        assert digest(cache['model'].encode() + b'\0' + body) == cache['key'] == row['cache_key']
        assert cache['prompt_sha256'] == digest(encoded(prompt))
        response = cache['response']
        answer = response['result']['answers']['hero']
        assert response['success'] is True and answer['probabilities'] == row['probabilities']
        assert answer['choice'] == row['expected'] and row['correct'] is True
        source = {}
        if row['domain'] == 'skin_reference':
            source = {key: value for key, value in row['provenance'].items() if key not in ('bundle', 'manifest', 'original_path')}
            source.update(skin=row['skin'], skin_name=row['skin_name'], view=row['view'], preprocessing=row['preprocessing'],
                          manifest_dimensions=row['dimensions'])
        else:
            source = {key: row['source'][key] for key in ('platform', 'recording_id', 'timestamp_seconds')}
            source.update(source_sha256=row['source_sha256'], region_xywh=row['region_xywh'],
                          label_status=row['label_status'], independent_human=False)
        item = dict(id=row['id'], domain=row['domain'], expected=row['expected'].lower().replace(' ', '_'),
                    role=row.get('role', 'reference'), image_sha256=row['sha256'], dimensions=dimensions,
                    cache_key=cache['key'], original_cache_sha256=digest(cache_file.read_bytes()),
                    response_sha256=digest(encoded(response)), response=response, source=source)
        if row['id'] in baseline:
            item['baseline'] = {key: baseline[row['id']][key] for key in ('top_probability', 'margin', 'choice', 'cache_key')}
        frozen.append(item)
    assert len(selected) == len(frozen) == 18
    return dict(prompt_file_sha256=digest(prompt_file.read_bytes()), prompt_canonical_sha256=digest(encoded(prompt)),
                model='@cf/cloudflare/clef-flash', source_results_sha256=digest(results_file.read_bytes()),
                baseline_results_sha256=digest(baseline_file.read_bytes()),
                scope='Selected previously seen development responses, not independent heldout accuracy. No images copied. '
                      'Historical inputs were reprocessed with OpenCV, not the older PIL fixture crops. '
                      'Labels are asset-path or AI visual matches, not independent human adjudication. '
                      'Canonical cache hashes use recursively sorted JSON keys.', rows=frozen)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence_root', type=Path)
    args = parser.parse_args()
    print(json.dumps(freeze(args.evidence_root), indent=2))
