#!/usr/bin/env python3
"""Select a Twitch rendition without changing source availability or database state."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Dict, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sfot' / 'src'))
from renditions import select_rendition


def prepare_rendition(environ: Mapping[str, str]) -> Dict[str, str]:
    """Discover a rendition, or select the requested rendition for a local run.

    Args:
        environ: Workflow configuration, including VOD_ID and REQUESTED_QUALITY.

    Returns:
        Workflow outputs, keeping source rendition and processing quality separate.
    """
    vod_id = environ.get('VOD_ID', '')
    if not re.fullmatch(r'[0-9]+', vod_id):
        raise ValueError('VOD_ID must contain only digits')
    preferred = environ.get('REQUESTED_QUALITY', '') or '480p'
    old_templates = environ.get('OLD_TEMPLATES', 'false').lower() == 'true'
    if environ.get('LOCAL', 'false').lower() == 'true':
        streams = {preferred: {}}
    else:
        try:
            response = subprocess.run(
                ['streamlink', '--no-config', '--json',
                 f'https://www.twitch.tv/videos/{vod_id}'],
                capture_output=True,
                text=True,
                check=True,
                timeout=90,
            )
        except (OSError, subprocess.SubprocessError):
            # Streamlink diagnostics can include signed media URLs. Keep them private.
            raise ValueError('Streamlink discovery failed; availability was not determined') from None
        try:
            payload = json.loads(response.stdout)
        except (json.JSONDecodeError, TypeError):
            raise ValueError('Streamlink returned invalid JSON') from None
        if not isinstance(payload, dict) or payload.get('error'):
            raise ValueError('Streamlink did not return a successful discovery result')
        streams = payload.get('streams')
        if not isinstance(streams, dict) or not streams:
            raise ValueError('Streamlink did not return any video renditions')

    selected = select_rendition(streams, preferred=preferred, old_templates=old_templates)
    fps = selected['video_fps']
    return {
        'stream_quality': selected['stream_quality'],
        'quality': selected['quality'],
        'video_fps': '' if fps is None else format(float(fps), 'g'),
        'available': 'true',
    }


def main() -> int:
    """Write GitHub outputs only after selection succeeds."""
    try:
        outputs = prepare_rendition(os.environ)
        output_path = os.environ.get('GITHUB_OUTPUT')
        if not output_path:
            raise ValueError('GITHUB_OUTPUT is required')
        with open(output_path, 'a', encoding='utf-8') as output:
            for key, value in outputs.items():
                if '\n' in value or '\r' in value:
                    raise ValueError('Invalid rendition output')
                output.write(f'{key}={value}\n')
        print(f"Selected rendition {outputs['stream_quality']}; templates {outputs['quality']}")
        return 0
    except (OSError, ValueError):
        # Do not expose arbitrary parser/Streamlink payloads in public Actions logs.
        print('Rendition selection failed; VOD availability remains unchanged.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
