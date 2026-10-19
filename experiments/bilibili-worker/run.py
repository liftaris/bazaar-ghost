#!/usr/bin/env python3
"""Call the probe repeatedly and summarize provider outcomes per endpoint.

Usage: run.py BASE_URL MINUTES INTERVAL_SECONDS OUTPUT.jsonl  (token in BILIBILI_PROBE_TOKEN for hosted)
"""
from collections import Counter, defaultdict
import json
import os
import sys
import time
from urllib.request import Request, urlopen


def main():
    base, minutes, interval, output = sys.argv[1].rstrip('/'), float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    token = os.getenv('BILIBILI_PROBE_TOKEN')
    # Cloudflare rejects urllib's default User-Agent on workers.dev.
    headers = {'User-Agent': 'BazaarGhost-probe/1.0', **({'Authorization': f'Bearer {token}'} if token else {})}
    deadline, round_ = time.time() + minutes * 60, 0
    with open(output, 'a') as out:
        while time.time() < deadline:
            fresh = '1' if round_ % 5 == 0 else '0'
            try:
                with urlopen(Request(f'{base}/probe?gap=2000&fresh={fresh}', headers=headers), timeout=120) as response:
                    report = json.load(response)
            except Exception as error:
                report = {'error': type(error).__name__}
            out.write(json.dumps(report) + '\n')
            out.flush()
            round_ += 1
            time.sleep(interval)
    summary = defaultdict(Counter)
    colos = Counter()
    for line in open(output):
        report = json.loads(line)
        colos[report.get('colo')] += 1
        for step in report.get('steps', []):
            kind = step['name'].split(':')[0]
            outcome = 'ok' if step['code'] == 0 and step['items'] else f"http={step['http']} code={step['code']}"
            summary[kind][outcome] += 1
    print(json.dumps({'colos': colos, 'endpoints': summary}, indent=1, default=dict))


if __name__ == '__main__':
    main()
