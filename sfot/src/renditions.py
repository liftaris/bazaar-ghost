"""Choose native video renditions independently of template geometry and sampling.

Rendition labels describe source height and, optionally, nominal FPS. Preserve
the selected label verbatim: an omitted FPS suffix is unknown, not evidence of
30 FPS. Processing geometry is one of the template resolutions; frame sampling
belongs to the decoder configuration and is deliberately absent from this API.
"""

import math
import re
from typing import Any, Dict, Optional, Tuple


QUALITY_RESOLUTIONS = {
    '360p': (640, 360),
    '480p': (854, 480),
    '720p': (1280, 720),
    '1080p': (1920, 1080),
}
SUPPORTED_HEIGHTS = tuple(height for _, height in QUALITY_RESOLUTIONS.values())
FALLBACK_HEIGHTS = (480, 720, 1080, 360)
RENDITION_PATTERN = re.compile(r'([1-9]\d*)p(?:(\d+(?:\.\d+)?))?')


def parse_rendition(name: str) -> Tuple[int, Optional[float]]:
    """Parse a native HEIGHTp[FPS] label, rejecting aliases and invalid values.

    Returns:
        Source height and positive finite nominal FPS, or None when omitted.

    Raises:
        ValueError: The label is not a positive-height video rendition.
    """
    match = RENDITION_PATTERN.fullmatch(name) if isinstance(name, str) else None
    if match is None:
        raise ValueError('Expected a video rendition label HEIGHTp[FPS]')
    height = int(match[1])
    fps = float(match[2]) if match[2] is not None else None
    if fps is not None and (not math.isfinite(fps) or fps <= 0):
        raise ValueError('Rendition FPS must be positive and finite')
    return height, fps


def processing_quality(preferred: str) -> str:
    """Validate a requested template height, allowing any valid native FPS suffix.

    Returns the canonical geometry label, for example 720p for 720p48.
    Noncanonical source heights are valid native renditions but cannot be
    requested as template geometry.
    """
    height, _ = parse_rendition(preferred)
    if height not in SUPPORTED_HEIGHTS:
        raise ValueError('Unsupported processing quality')
    return f'{height}p'


def select_rendition(streams: Dict[str, Any], preferred: str = '480p',
                     old_templates: bool = False) -> Dict[str, Any]:
    """Select a native label and return only public processing metadata.

    Args:
        streams: Streamlink-style mapping. Values are opaque and never returned.
        preferred: Supported template height with an optional nominal FPS suffix.
        old_templates: Always normalize decoded frames to historical 480p geometry.

    Returns:
        stream_quality: Exact selected native label, never reconstructed.
        quality: Canonical template geometry; old templates always use 480p.
        video_fps: Source label's nominal FPS, or None when no suffix is present.

    Requested native height wins, followed by the established fallback order
    480, 720, 1080, 360. If no supported native height exists, prefer the closest
    source at or above the requested height, otherwise the largest below it.
    Such sources normalize to the largest supported height not exceeding the
    selected source, with 360p as the minimum. Within one height, prefer the
    exact requested label, then the FPS closest to its suffix (30 if omitted),
    then lexical label order for deterministic ties. Unknown FPS uses 30 only
    for ranking and remains None in the result.
    """
    processing_quality(preferred)
    desired_height, desired_fps = parse_rendition(preferred)
    if old_templates:
        desired_height = 480
    candidates = []
    for name in streams:
        try:
            height, fps = parse_rendition(name)
        except ValueError:
            continue
        candidates.append((name, height, fps))
    if not candidates:
        raise ValueError('No supported video rendition is available')

    height_order = list(dict.fromkeys((desired_height, *FALLBACK_HEIGHTS)))
    native_heights = {height for _, height, _ in candidates}
    selected_height = next((height for height in height_order if height in native_heights), None)
    if selected_height is None:
        selected_height = min(native_heights, key=lambda height: (height < desired_height, abs(height - desired_height)))
    target_fps = desired_fps if desired_fps is not None else 30.0
    name, _, fps = min(
        (candidate for candidate in candidates if candidate[1] == selected_height),
        key=lambda candidate: (
            candidate[0] != preferred,
            abs((candidate[2] if candidate[2] is not None else 30.0) - target_fps),
            candidate[0],
        ),
    )
    height = max((height for height in SUPPORTED_HEIGHTS if height <= selected_height), default=360)
    return {
        'stream_quality': name,
        'quality': '480p' if old_templates else f'{height}p',
        'video_fps': fps,
    }
