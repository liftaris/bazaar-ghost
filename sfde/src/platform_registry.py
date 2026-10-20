"""Platform registry loader. Reads contracts/platforms.json, shared with the Worker."""

import json
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Optional
from urllib.parse import quote


def _registry_path() -> Path:
    override = os.getenv('PLATFORM_REGISTRY_PATH')
    if override:
        return Path(override)
    here = Path(__file__).resolve()
    # The image copies the registry to /app/contracts; a checkout keeps it at the repository root.
    for candidate in (here.parents[1] / 'contracts' / 'platforms.json', here.parents[2] / 'contracts' / 'platforms.json'):
        if candidate.is_file():
            return candidate
    raise FileNotFoundError('contracts/platforms.json not found')


def _load() -> List[Dict[str, Any]]:
    with open(_registry_path(), encoding='utf-8') as handle:
        return json.load(handle)['platforms']


_PLATFORMS = _load()
_EXTRA: List[Dict[str, Any]] = []


def register_for_test(entries: List[Dict[str, Any]]) -> None:
    _EXTRA[:] = entries


def list_platforms() -> List[Dict[str, Any]]:
    return [*_PLATFORMS, *_EXTRA]


def supported_sources() -> tuple:
    return tuple(entry['id'] for entry in list_platforms())


def ingestion_sources() -> tuple:
    return tuple(entry['id'] for entry in list_platforms() if entry['adapters'].get('ingestion'))


def platform(source: str) -> Dict[str, Any]:
    for entry in list_platforms():
        if entry['id'] == source:
            return entry
    raise ValueError('Unsupported platform')


def _pattern(value: str) -> 're.Pattern[str]':
    # The registry uses JavaScript named groups; Python spells them (?P<name>...).
    return re.compile(value.replace('(?<', '(?P<'))


def video_identity(source: str, value: Any) -> str:
    if not isinstance(value, str) or not _pattern(platform(source)['recording']['idPattern']).fullmatch(value):
        raise ValueError('Expected a supported platform and valid video identifier')
    return value


def account_identity(source: str, value: Any) -> str:
    if not isinstance(value, str) or not _pattern(platform(source)['channel']['idPattern']).fullmatch(value):
        raise ValueError('Invalid platform account identity')
    return value


def _fill(template: str, values: Dict[str, Any]) -> str:
    return re.sub(r'\{(\w+)\}', lambda match: quote(str(values.get(match[1], '')), safe=''), template)


def recording_url(source: str, kind: str, values: Dict[str, Any], at: Optional[int] = None) -> Optional[str]:
    """Build a registry URL. `kind` is watchUrl, embedUrl or resolveUrl; `values` holds id/videoId/partId/partIndex."""
    recording = platform(source)['recording']
    template = recording[kind + 'At'] if at is not None else recording[kind]
    return _fill(template, {**values, 't': at}) if template else None


def parse_url(url: str) -> Optional[Dict[str, Any]]:
    for entry in list_platforms():
        for kind, key in (('recording', 'recording'), ('channel', 'channel')):
            for pattern in entry[key]['urlPatterns']:
                match = _pattern(pattern).match(url)
                if match:
                    return {'platform': entry['id'], 'kind': kind, 'groups': {k: v for k, v in match.groupdict().items() if v is not None}}
    return None
