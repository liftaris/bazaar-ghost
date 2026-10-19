"""Independently verify a natural video endpoint inside a finite media container.

Packet timestamps come from the decoder's same locator and selected first video
stream. No endpoint is inferred from decoder EOF, catalog rounding, or silence.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import time
from fractions import Fraction
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_PROBE_BYTES = 8 * 1024 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_PACKETS = 10_000
TAIL_SECONDS = 60
# Bound for an MP4's composition delay and final-sample rounding, in video frames.
MP4_MAX_COMPOSITION_FRAMES = 4
MP4_MAX_DURATION_UNDERSTATEMENT_SECONDS = 1
PROBE_TIMEOUT_SECONDS = 45
METADATA_ENTRIES = 'format=format_name,start_time,duration:stream=index,codec_type,time_base,start_time:stream_disposition=attached_pic'
PACKET_ENTRIES = METADATA_ENTRIES + ':packet=stream_index,pts,duration'


class VideoEndpointError(RuntimeError):
    """Static diagnostics only: locators, headers and subprocess output stay private."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise VideoEndpointError('Video endpoint manifest redirected')


def _number(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise VideoEndpointError('Video endpoint numeric metadata is missing')
    try:
        result = Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        raise VideoEndpointError('Video endpoint numeric metadata is invalid') from None
    if abs(result) > 2 ** 53 or (positive and result <= 0):
        raise VideoEndpointError('Video endpoint numeric metadata is outside bounds')
    return result


def _integer(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not re.fullmatch(r'-?[0-9]{1,20}', str(value)):
        raise VideoEndpointError('Video endpoint packet timestamp is invalid')
    result = int(value)
    if not -(2 ** 63) <= result < 2 ** 63 or (positive and result <= 0):
        raise VideoEndpointError('Video endpoint packet timestamp is outside bounds')
    return result


def _headers(input_args):
    if input_args == [] or input_args == ():
        return {}
    if not isinstance(input_args, (list, tuple)) or len(input_args) != 2 or input_args[0] != '-headers' or not isinstance(input_args[1], str):
        raise VideoEndpointError('Unsupported video endpoint input options')
    result = {}
    for line in input_args[1].split('\r\n'):
        if not line:
            continue
        key, separator, value = line.partition(':')
        if not separator or key.lower() not in ('user-agent', 'referer', 'origin') or '\r' in value or '\n' in value or key.lower() in result:
            raise VideoEndpointError('Unsupported video endpoint playback header')
        result[key.lower()] = value.strip()
    return result


def _probe_json(command):
    """Bound stdout memory, discard stderr, and always settle this probe process."""
    child = None
    try:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        payload = bytearray()
        deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, 'json')
            selector.register(child.stderr, selectors.EVENT_READ, 'error')
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise VideoEndpointError('Video endpoint probe timed out')
                for key, _ in selector.select(min(remaining, 0.2)):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                    elif key.data == 'error':
                        raise VideoEndpointError('Video endpoint probe reported an error')
                    else:
                        if len(payload) + len(data) > MAX_PROBE_BYTES:
                            raise VideoEndpointError('Video endpoint probe output exceeded its bound')
                        payload.extend(data)
        if child.wait(timeout=1):
            raise VideoEndpointError('Video endpoint probe failed')
        result = json.loads(payload)
        if not isinstance(result, dict) or 'error' in result:
            raise VideoEndpointError('Video endpoint probe returned invalid metadata')
        return result
    except VideoEndpointError:
        raise
    except Exception:
        raise VideoEndpointError('Video endpoint probe could not be verified') from None
    finally:
        if child is not None:
            unsettled = False
            if child.poll() is None:
                child.kill()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    unsettled = True
            child.stdout.close()
            child.stderr.close()
            if unsettled:
                raise VideoEndpointError('Video endpoint probe could not be stopped')


def _manifest_bytes(locator, headers, local_file):
    try:
        if local_file:
            with open(locator, 'rb') as source:
                payload = source.read(MAX_MANIFEST_BYTES + 1)
        else:
            request = Request(locator, headers=headers)
            with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=20) as source:
                if source.status != 200:
                    raise VideoEndpointError('Video endpoint manifest is unavailable')
                payload = source.read(MAX_MANIFEST_BYTES + 1)
        if not payload or len(payload) > MAX_MANIFEST_BYTES:
            raise VideoEndpointError('Video endpoint manifest exceeded its bound')
        return payload
    except VideoEndpointError:
        raise
    except Exception:
        raise VideoEndpointError('Video endpoint manifest could not be verified') from None


def _closed_manifest(payload):
    try:
        lines = [line.strip() for line in payload.decode('utf-8-sig').splitlines() if line.strip()]
    except UnicodeError:
        raise VideoEndpointError('Video endpoint manifest encoding is invalid') from None
    if not lines or lines[0] != '#EXTM3U' or lines.count('#EXT-X-ENDLIST') != 1:
        raise VideoEndpointError('Video endpoint requires a closed HLS playlist')
    forbidden = ('#EXT-X-STREAM-INF', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-GAP')
    durations, pending, ended = [], False, False
    for line in lines[1:]:
        if line.startswith(forbidden) or line == '#EXT-X-DISCONTINUITY' or (line.startswith('#EXT-X-DISCONTINUITY-SEQUENCE:') and line != '#EXT-X-DISCONTINUITY-SEQUENCE:0'):
            raise VideoEndpointError('Video endpoint requires one continuous HLS media playlist')
        if line == '#EXT-X-ENDLIST':
            if pending:
                raise VideoEndpointError('Video endpoint HLS segment is incomplete')
            ended = True
        elif line.startswith('#EXTINF:'):
            if pending or ended:
                raise VideoEndpointError('Video endpoint HLS segment order is invalid')
            durations.append(_number(line.partition(':')[2].partition(',')[0], positive=True))
            pending = True
        elif not line.startswith('#'):
            if not pending or ended:
                raise VideoEndpointError('Video endpoint requires an HLS media playlist')
            pending = False
    if not durations or pending:
        raise VideoEndpointError('Video endpoint HLS timeline is missing')
    return sum(durations, Fraction(0))


def _metadata(value):
    format_info, streams = value.get('format'), value.get('streams')
    if not isinstance(format_info, dict) or not isinstance(streams, list) or not 1 <= len(streams) <= 128:
        raise VideoEndpointError('Video endpoint container metadata is missing')
    formats = set(str(format_info.get('format_name', '')).split(','))
    container = 'hls' if 'hls' in formats else 'mp4' if formats & {'mov', 'mp4'} else None
    if container is None:
        raise VideoEndpointError('Video endpoint requires finite MP4 or closed HLS media')
    origin = _number(format_info.get('start_time'))
    duration = _number(format_info.get('duration'), positive=True)
    by_index = {}
    for stream in streams:
        if not isinstance(stream, dict):
            raise VideoEndpointError('Video endpoint stream metadata is invalid')
        index = _integer(stream.get('index'))
        if index < 0 or index in by_index:
            raise VideoEndpointError('Video endpoint stream identity is invalid')
        kind = stream.get('codec_type')
        base = _number(stream.get('time_base'), positive=True) if kind in ('video', 'audio') else None
        by_index[index] = {'kind': kind, 'time_base': base,
                          'start_time': _number(stream['start_time']) if stream.get('start_time') is not None else None,
                          'attached_pic': (stream.get('disposition') or {}).get('attached_pic', 0)}
    video_indices = [index for index, stream in by_index.items() if stream['kind'] == 'video']
    if not video_indices:
        raise VideoEndpointError('Video endpoint has no video stream')
    video_index = min(video_indices)  # Matches the processor's explicit -map 0:v:0.
    if by_index[video_index]['attached_pic']:
        raise VideoEndpointError('Video endpoint selected an attached picture')
    return container, origin, duration, by_index, video_index


def verify_video_endpoint(input_url_or_path, input_args, *, requested_start, requested_end,
                          last_decoded_seconds, frame_interval_seconds, timestamp_quantum_seconds,
                          local_file=False):
    """Return independent packet/closure evidence, or fail without changing a timeline."""
    try:
        return _verify(input_url_or_path, input_args, requested_start=requested_start, requested_end=requested_end,
                       last_decoded_seconds=last_decoded_seconds, frame_interval_seconds=frame_interval_seconds,
                       timestamp_quantum_seconds=timestamp_quantum_seconds, local_file=local_file)
    except VideoEndpointError:
        raise
    except Exception:
        raise VideoEndpointError('Video endpoint evidence is invalid') from None


def _verify(locator, input_args, *, requested_start, requested_end, last_decoded_seconds,
            frame_interval_seconds, timestamp_quantum_seconds, local_file):
    locator = os.fspath(locator)
    if not isinstance(locator, str) or not locator or '\n' in locator or '\r' in locator:
        raise VideoEndpointError('Video endpoint media locator is invalid')
    headers = _headers(input_args)
    if local_file:
        stat = Path(locator).stat()
        original_file = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
    else:
        parsed = urlparse(locator)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise VideoEndpointError('Video endpoint requires the resolved HTTP media locator')
    start, end = _number(requested_start), _number(requested_end, positive=True)
    if not 0 <= start < end:
        raise VideoEndpointError('Video endpoint requested range is invalid')
    command = ['ffprobe', '-hide_banner', '-v', 'error', '-rw_timeout', '20000000', *input_args]
    metadata = _probe_json([*command, '-show_entries', METADATA_ENTRIES, '-of', 'json', '-i', locator])
    container, origin, duration, streams, video_index = _metadata(metadata)
    # Catalog durations are whole seconds rounded up; some providers (Bilibili)
    # round a length that includes an audio tail the video-only MP4 lacks.
    if not math.floor(duration) <= end <= math.ceil(duration) + (1 if container == 'mp4' else 0):
        raise VideoEndpointError('Video endpoint evidence is restricted to the final catalog range')
    manifest, manifest_duration = None, None
    if container == 'hls':
        manifest = _manifest_bytes(locator, headers, local_file)
        manifest_duration = _closed_manifest(manifest)
        if abs(manifest_duration - duration) > Fraction(1, 1000):
            raise VideoEndpointError('Video endpoint manifest and container durations differ')
    relative_seek = max(Fraction(0), duration - TAIL_SECONDS)
    absolute_seek = origin + relative_seek
    result = _probe_json([*command, '-read_intervals', f'{float(absolute_seek):.9f}%+#{MAX_PACKETS}',
                          '-show_entries', PACKET_ENTRIES, '-of', 'json', '-i', locator])
    if _metadata(result) != (container, origin, duration, streams, video_index):
        raise VideoEndpointError('Video endpoint stream metadata changed during verification')
    packets = result.get('packets')
    if not isinstance(packets, list) or not packets or len(packets) >= MAX_PACKETS:
        raise VideoEndpointError('Video endpoint packet probe did not establish natural EOF')
    video_frames = []
    container_end, container_step, container_quantum = None, None, None
    for packet in packets:
        if not isinstance(packet, dict):
            raise VideoEndpointError('Video endpoint packet metadata is malformed')
        index = _integer(packet.get('stream_index'))
        if index not in streams:
            raise VideoEndpointError('Video endpoint packet refers to an unknown stream')
        if streams[index]['kind'] not in ('video', 'audio'):
            continue
        base = streams[index]['time_base']
        pts = _integer(packet.get('pts')) * base - origin
        step = _integer(packet.get('duration'), positive=True) * base
        if step > 1:
            raise VideoEndpointError('Video endpoint packet duration exceeds the game-media bound')
        packet_end = pts + step
        if container_end is None or packet_end > container_end:
            container_end, container_step, container_quantum = packet_end, step, base
        if index == video_index:
            video_frames.append((pts, step))
    if not video_frames or container_end is None:
        raise VideoEndpointError('Video endpoint probe did not observe terminal video packets')
    last_frame, last_step = max(video_frames)
    video_quantum = streams[video_index]['time_base']
    video_start = streams[video_index]['start_time']
    if video_start is None:
        raise VideoEndpointError('Video endpoint selected video origin is missing')
    alignment = Fraction(0)
    if container == 'hls':
        # HLS segment durations can use the video origin while format.start_time
        # is the slightly earlier audio origin. Account for that measured offset
        # only; packet/frame coordinates themselves remain relative to format.
        alignment = video_start - origin
        if not 0 <= alignment <= last_step + video_quantum:
            raise VideoEndpointError('Video endpoint HLS origin alignment is outside one video frame')
    elif container == 'mp4' and origin <= MP4_MAX_COMPOSITION_FRAMES * last_step:
        # Packagers differ in whether an unedited MP4's duration counts the
        # composition delay that start_time reports, and in how they round the
        # final sample (Bilibili's Bento4/XCoder: by up to a few frames). Accept
        # a declared end past the observed packets only by that delay plus a
        # few frames; a truncated read falls far outside this bound.
        shortfall = duration - container_end
        if 0 < shortfall <= origin + MP4_MAX_COMPOSITION_FRAMES * last_step:
            alignment = shortfall
        # The declared duration can also understate the media (Bilibili: 0.58 s).
        # Packets observed past the declared end cannot be a truncated read; bound
        # how far the metadata may be wrong.
        elif 0 < -shortfall <= MP4_MAX_DURATION_UNDERSTATEMENT_SECONDS:
            alignment = -shortfall
    container_tolerance = alignment + container_step + container_quantum + Fraction(1, 1_000_000)
    if abs(container_end - duration) > container_tolerance:
        raise VideoEndpointError('Video endpoint packet probe did not reach the container end')
    video_end = max(pts + step for pts, step in video_frames)
    if last_frame < 0 or not last_frame < video_end <= duration + container_tolerance:
        raise VideoEndpointError('Video endpoint packet timeline is inconsistent')
    audio_only = last_decoded_seconds is None
    if audio_only:
        if video_end > start:
            raise VideoEndpointError('Video endpoint does not prove an audio-only requested range')
        agreement = last_step + streams[video_index]['time_base']
    else:
        decoded = _number(last_decoded_seconds)
        frame_interval = _number(frame_interval_seconds, positive=True)
        quantum = _number(timestamp_quantum_seconds, positive=True)
        agreement = frame_interval + quantum
        if not start - agreement <= decoded < end + agreement or abs(decoded - last_frame) > agreement:
            raise VideoEndpointError('Decoded video did not reach the independently verified endpoint')
    if manifest is not None and _manifest_bytes(locator, headers, local_file) != manifest:
        raise VideoEndpointError('Video endpoint HLS manifest changed during verification')
    if local_file:
        stat = Path(locator).stat()
        if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns) != original_file:
            raise VideoEndpointError('Video endpoint local media changed during verification')
    evidence = {
        'method': 'ffprobe-packets-v1', 'container': container, 'closed': True, 'audio_only': audio_only,
        'video_end_seconds': float(video_end), 'last_video_frame_seconds': float(last_frame),
        'container_duration_seconds': float(duration), 'source_origin_seconds': float(origin),
        'selected_video_start_seconds': float(video_start), 'container_origin_alignment_seconds': float(alignment),
        'selected_video_packet_duration_seconds': float(last_step), 'selected_video_timestamp_quantum_seconds': float(video_quantum),
        'video_stream_index': video_index, 'packet_count': len(packets), 'video_packet_count': len(video_frames),
        'packet_limit': MAX_PACKETS, 'probe_start_seconds': float(relative_seek),
        'probe_start_timestamp_seconds': float(absolute_seek), 'container_packet_end_seconds': float(container_end),
        'container_tolerance_seconds': float(container_tolerance), 'frame_agreement_tolerance_seconds': float(agreement),
        'terminal_packet_duration_seconds': float(container_step), 'terminal_packet_quantum_seconds': float(container_quantum),
    }
    if manifest is not None:
        evidence.update(manifest_sha256=hashlib.sha256(manifest).hexdigest(), manifest_duration_seconds=float(manifest_duration))
    return evidence
