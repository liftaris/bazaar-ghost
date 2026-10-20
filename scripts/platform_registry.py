"""Registry access for scripts; the implementation is shared with SFDE (one loader, one JSON file)."""

import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[1] / 'sfde' / 'src' / 'platform_registry.py'
_spec = importlib.util.spec_from_file_location('_sfde_platform_registry', _path)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)

list_platforms = _module.list_platforms
supported_sources = _module.supported_sources
ingestion_sources = _module.ingestion_sources
platform = _module.platform
video_identity = _module.video_identity
account_identity = _module.account_identity
recording_url = _module.recording_url
parse_url = _module.parse_url
register_for_test = _module.register_for_test
