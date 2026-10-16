#!/usr/bin/env python3
"""One reviewed validation recording: real catalog, Actions OCR, persisted coverage evidence."""
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from urllib.request import Request

ROOT = Path(__file__).resolve().parents[2]
OCR_OUTPUT = Path('/app/output')
MAX_JPEG_BYTES = 5_000_000
MAX_JPEG_PIXELS = 16_000_000
MAX_CHUNKS = 12
MAX_CHUNK_SECONDS = 1800
CHUNK_TIMEOUT_SECONDS = 2000
CHILD_GRACE_SECONDS = 4
CHILD_REAP_SECONDS = 1
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'sfde' / 'src'))
from backend_environment import open_backend, verify_backend
from catalog_youtube import ensure_account, normalize_video
from media_source import youtube_metadata
from renditions import parse_rendition
from video_catalog import save_video
import vod_workflow
from guard import validate_job


class ValidationFailure(ValueError):
    """Static operator-facing explanations; never raw upstream responses or credentials."""


class ValidationCancelled(Exception):
    """The Actions runner requested cancellation; this is never success."""


def persist_report(destination, report):
    """Publish complete private snapshots, including while cancellation is pending."""
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=destination,
                                         prefix='.validation-', suffix='.json', delete=False) as output:
            temporary = Path(output.name)
            json.dump(report, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination / 'validation.json')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


class ChildSupervisor:
    """Own one isolated process group; leave lease recovery to the backend."""

    def __init__(self, report, checkpoint):
        self.report, self.checkpoint = report, checkpoint
        self.cancelled = False
        self.timed_out = False
        self.previous_handlers = {}

    def install(self):
        for number in (signal.SIGINT, signal.SIGTERM):
            self.previous_handlers[number] = signal.getsignal(number)
            signal.signal(number, self._signal)

    def restore(self):
        for number, handler in self.previous_handlers.items():
            signal.signal(number, handler)

    def _checkpoint_during_cleanup(self):
        try:
            self.checkpoint()
        except Exception:
            # A full disk must not interrupt Popen assignment or child cleanup.
            # Final persistence retries normally; no raw filesystem error leaks.
            self.report['artifact_write_failed'] = True

    def _signal(self, number, _frame):
        self.cancelled = True
        if not self.timed_out:
            self.report['status'] = 'cancelled'
        self.report['cancellation_signal'] = signal.Signals(number).name
        # The handler records rather than raises, so a signal during Popen
        # cannot orphan a just-created child before its PID is assigned.
        self._checkpoint_during_cleanup()

    def check(self):
        if self.cancelled:
            raise ValidationCancelled()

    def phase(self, value):
        self.check()
        self.report['phase'] = value
        self.checkpoint()

    @staticmethod
    def _exited(child):
        # Keep the group leader unreaped until descendant cleanup is complete.
        # Its reserved PID prevents accidentally signalling a reused group ID.
        return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None

    @staticmethod
    def _signal_group(child, number):
        try:
            os.killpg(child.pid, number)
            return True
        except ProcessLookupError:
            return False

    def _stop(self, child, reason):
        outcome = {'reason': reason, 'child_reaped': False, 'lease_release': 'unconfirmed'}
        self.report['child_cleanup'] = outcome
        self._checkpoint_during_cleanup()
        outcome['term_sent'] = self._signal_group(child, signal.SIGTERM)
        deadline = time.monotonic() + CHILD_GRACE_SECONDS
        while not self._exited(child) and time.monotonic() < deadline:
            time.sleep(0.05)
        outcome['grace_exhausted'] = not self._exited(child)
        # Even an exited leader may have a surviving FFmpeg child. Kill its
        # still-owned group before reaping the leader and releasing the PID.
        outcome['group_kill_sent'] = self._signal_group(child, signal.SIGKILL)
        try:
            outcome['exit_code'] = child.wait(timeout=CHILD_REAP_SECONDS)
            outcome['child_reaped'] = True
        except subprocess.TimeoutExpired:
            # A stuck OS process must not turn cancellation into an unbounded
            # wait. The disposable container and chunk lease remain fallbacks.
            pass
        self._checkpoint_during_cleanup()

    def run(self, command, *, cwd, env, timeout):
        self.check()
        child = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
        deadline = time.monotonic() + timeout
        try:
            while True:
                self.check()
                if self._exited(child):
                    # An ordinary or failed exit can also leave descendants.
                    # Keep the leader's PID reserved until its group is settled,
                    # including if cancellation arrives after the exit check.
                    outcome = {'reason': 'exited', 'child_reaped': False, 'lease_release': 'unconfirmed'}
                    self.report['child_cleanup'] = outcome
                    outcome['group_kill_sent'] = self._signal_group(child, signal.SIGKILL)
                    code = child.wait(timeout=CHILD_REAP_SECONDS)
                    outcome.update(child_reaped=True, exit_code=code)
                    self._checkpoint_during_cleanup()
                    self.check()
                    if code:
                        raise subprocess.CalledProcessError(code, command)
                    return
                if time.monotonic() >= deadline:
                    self.timed_out = True
                    self.report.update(status='failed', error_type='TimeoutExpired')
                    raise subprocess.TimeoutExpired(command, timeout)
                time.sleep(0.05)
        except BaseException as error:
            if child.returncode is None:
                reason = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else 'cancelled' if isinstance(error, ValidationCancelled) else 'failed'
                self._stop(child, reason)
            raise


def options(values):
    def number(name, low, high):
        value = values.get(name, '')
        if not re.fullmatch(r'[0-9]+', value) or not low <= int(value) <= high:
            raise ValidationFailure(f'Invalid {name}')
        return int(value)
    source = values.get('VALIDATION_SOURCE')
    if values.get('ENVIRONMENT') != 'validation' or source not in ('youtube', 'twitch'):
        raise ValidationFailure('This temporary workflow accepts only validation YouTube or Twitch recordings')
    video = values.get('VALIDATION_VIDEO_ID', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}' if source == 'youtube' else r'[1-9][0-9]{0,24}', video):
        raise ValidationFailure('Provide one exact video ID for the reviewed source')
    recorded_at = values.get('VALIDATION_RECORDED_AT') or None
    if source == 'twitch' and recorded_at is not None:
        raise ValidationFailure('Twitch recorded_at overrides are unsupported; review the existing catalog metadata')
    ranges = json.loads(values.get('VALIDATION_RANGES', 'null'))
    if not isinstance(ranges, list) or not 2 <= len(ranges) <= MAX_CHUNKS * 2 or len(ranges) % 2:
        raise ValidationFailure('Provide 1–12 reviewed ranges')
    previous, total = 0, 0
    for start, end in zip(ranges[::2], ranges[1::2]):
        if type(start) is not int or type(end) is not int or not previous <= start < end <= 86400 or end - start > MAX_CHUNK_SECONDS:
            raise ValidationFailure('Ranges must be ordered, nonoverlapping, and at most 1800 seconds each')
        previous, total = end, total + end - start
    if total > MAX_CHUNKS * MAX_CHUNK_SECONDS:
        raise ValidationFailure('At most six hours of reviewed gameplay per validation job')
    templates, quality = values.get('VALIDATION_TEMPLATES'), values.get('VALIDATION_QUALITY')
    if templates not in ('old', 'current') or quality not in ('360p', '480p', '720p', '1080p'):
        raise ValidationFailure('Explicit supported templates and quality are required')
    if templates == 'old' and quality != '480p':
        raise ValidationFailure('Old templates require 480p')
    if values.get('VALIDATION_REQUIRE_IGD') not in ('true', 'false'):
        raise ValidationFailure('Explicit IGD expectation is required')
    return {'source': source, 'video_id': video, 'ranges': ranges, 'templates': templates, 'quality': quality,
            'profile_id': number('VALIDATION_PROFILE_ID', 1, 1_000_000),
            'minimum_detections': number('VALIDATION_MINIMUM_DETECTIONS', 1, 100),
            'require_igd': values['VALIDATION_REQUIRE_IGD'] == 'true',
            'recorded_at': recorded_at}


def merged(intervals):
    result = []
    for start, end in sorted(intervals):
        if result and start < result[-1][1]:
            raise ValidationFailure('Overlapping chunks cannot prove coverage')
        if result and start == result[-1][1]:
            result[-1][1] = end
        else:
            result.append([start, end])
    return result


def verify_plan(chunks, selected, vod_id):
    if not 1 <= len(chunks) <= MAX_CHUNKS or len({chunk['id'] for chunk in chunks}) != len(chunks):
        raise ValidationFailure('Expected 1–12 distinct unclaimed chunks; reset reviewed failed work explicitly before retrying')
    for chunk in chunks:
        if (chunk['vod_pk'] != vod_id or chunk['source'] != selected['source'] or chunk['vod_id'] != selected['video_id']
                or chunk['status'] != 'pending'):
            raise ValidationFailure('Chunk identity or processing state changed')
        start, end = chunk['start_seconds'], chunk['end_seconds']
        if type(start) is not int or type(end) is not int or not 0 <= start < end or end - start > MAX_CHUNK_SECONDS:
            raise ValidationFailure('Each planned chunk must cover at most 1800 whole seconds')
    expected = merged(list(zip(selected['ranges'][::2], selected['ranges'][1::2])))
    actual = merged([[chunk['start_seconds'], chunk['end_seconds']] for chunk in chunks])
    if actual != expected:
        raise ValidationFailure('Planned chunks must cover exactly the reviewed ranges')


def reviewed_coverage(selected, duration):
    if type(duration) is not int or duration <= 0 or selected['ranges'][-1] > duration:
        raise ValidationFailure('Reviewed ranges exceed the cataloged source duration')
    return merged(list(zip(selected['ranges'][::2], selected['ranges'][1::2])))


def verify_twitch_catalog(vod, selected, *, completed=False):
    """Read-only acceptance of an existing Twitch catalog entry, never a substitute for discovery."""
    if (type(vod.get('id')) is not int or vod['id'] <= 0 or vod.get('source') != 'twitch'
            or vod.get('source_id') != selected['video_id']):
        raise ValidationFailure('Existing Twitch catalog identity differs from the reviewed recording')
    if (vod.get('processing_enabled') is not True or vod.get('ready_for_processing') is not True
            or vod.get('availability') != 'available' or vod.get('status') != ('completed' if completed else 'pending')):
        raise ValidationFailure('Twitch requires an eligible existing catalog entry and a fresh pending plan')
    expected = reviewed_coverage(selected, vod.get('duration_seconds'))
    chapters = vod.get('bazaar_chapters')
    if (not isinstance(chapters, list) or not chapters or len(chapters) % 2
            or any(type(value) is not int for value in chapters)
            or any(not 0 <= start < end <= vod['duration_seconds'] for start, end in zip(chapters[::2], chapters[1::2]))
            or merged(list(zip(chapters[::2], chapters[1::2]))) != expected):
        raise ValidationFailure('Existing Twitch chapters must cover exactly the reviewed ranges')
    if ((vod.get('profile') or {}).get('id') != selected['profile_id']
            or vod.get('old_templates') is not (selected['templates'] == 'old')):
        raise ValidationFailure('Existing Twitch profile or template era differs from the reviewed inputs')
    return {key: vod.get(key) for key in ('id', 'source', 'source_id', 'streamer_id', 'creator_name', 'title',
            'duration_seconds', 'published_at', 'recorded_at', 'template_version', 'bazaar_chapters', 'profile', 'old_templates')}


def verify_prepared(prepared, selected, catalog_profile=None):
    profile = json.loads(prepared['sfde_profile'])
    if prepared.get('stream_quality'):
        try:
            parse_rendition(prepared['stream_quality'])
        except ValueError:
            raise ValidationFailure('Invalid prepared native rendition') from None
    if (profile.get('id') != selected['profile_id']
            or prepared.get('old_templates') != str(selected['templates'] == 'old').lower()
            or prepared.get('quality') != selected['quality']
            or (catalog_profile is not None and profile != catalog_profile)):
        raise ValidationFailure('Prepared profile, template era or rendition differs from the reviewed inputs')
    return profile


def verified_sample_count(start, end, coverage):
    """Check recorded source timing independently of the terminal status/count.

    Catalog ranges stay fixed. A shorter video interval needs the same source's
    finite packet endpoint; a clean decoder exit alone is never that proof.
    """
    def require(condition):
        if not condition:
            raise ValidationFailure('Recorded source timing or video EOF proof is inconsistent')

    def finite(value):
        return type(value) in (int, float) and math.isfinite(value)

    def close(left, right):
        return finite(left) and finite(right) and abs(left - right) <= 1e-6

    require(isinstance(coverage, dict))
    requested = math.ceil((end - start) / 2)
    require(type(coverage.get('requested_expected_frames')) is int
            and coverage['requested_expected_frames'] == requested)
    reason, endpoint = coverage.get('completion_reason'), coverage.get('video_endpoint')
    effective_end = coverage.get('effective_video_end_seconds')
    require(finite(effective_end) and start <= effective_end <= end)
    require(close(coverage.get('unobserved_catalog_tail_seconds'), end - effective_end))
    if reason == 'requested_range':
        require(endpoint is None and effective_end == end)
    else:
        require(reason == 'verified_video_eof' and isinstance(endpoint, dict))
        require(endpoint.get('method') == 'ffprobe-packets-v1' and endpoint.get('closed') is True
                and endpoint.get('container') in ('hls', 'mp4'))
        fields = ('video_end_seconds', 'last_video_frame_seconds', 'container_duration_seconds',
                  'source_origin_seconds', 'probe_start_seconds', 'probe_start_timestamp_seconds',
                  'container_packet_end_seconds', 'container_tolerance_seconds', 'frame_agreement_tolerance_seconds',
                  'terminal_packet_duration_seconds', 'terminal_packet_quantum_seconds',
                  'selected_video_start_seconds', 'selected_video_packet_duration_seconds',
                  'selected_video_timestamp_quantum_seconds', 'container_origin_alignment_seconds')
        require(all(finite(endpoint.get(field)) for field in fields))
        video_end, container_end = endpoint['video_end_seconds'], endpoint['container_duration_seconds']
        require(0 <= endpoint['last_video_frame_seconds'] < video_end < end and container_end > 0
                and math.floor(container_end) <= end <= math.ceil(container_end)
                and close(effective_end, max(start, min(end, video_end))))
        require(type(endpoint.get('video_stream_index')) is int and endpoint['video_stream_index'] >= 0
                and type(endpoint.get('packet_count')) is int and 0 < endpoint['packet_count'] < 10000
                and type(endpoint.get('video_packet_count')) is int
                and 0 < endpoint['video_packet_count'] <= endpoint['packet_count']
                and type(endpoint.get('packet_limit')) is int and endpoint['packet_limit'] == 10000
                and type(endpoint.get('audio_only')) is bool)
        require(close(endpoint['probe_start_seconds'], max(0, container_end - 60))
                and close(endpoint['probe_start_timestamp_seconds'], endpoint['source_origin_seconds'] + endpoint['probe_start_seconds']))
        require(0 < endpoint['selected_video_timestamp_quantum_seconds'] <= endpoint['selected_video_packet_duration_seconds'] <= 1)
        alignment = endpoint['container_origin_alignment_seconds']
        require(0 <= alignment <= endpoint['selected_video_packet_duration_seconds'] + endpoint['selected_video_timestamp_quantum_seconds'])
        require(close(alignment, endpoint['selected_video_start_seconds'] - endpoint['source_origin_seconds'])
                if endpoint['container'] == 'hls' else alignment == 0)
        require(0 < endpoint['terminal_packet_quantum_seconds'] <= endpoint['terminal_packet_duration_seconds'] <= 1
                and close(endpoint['container_tolerance_seconds'],
                          alignment + endpoint['terminal_packet_duration_seconds'] + endpoint['terminal_packet_quantum_seconds'] + 1e-6)
                and endpoint['frame_agreement_tolerance_seconds'] > 0
                and abs(endpoint['container_packet_end_seconds'] - container_end) <= endpoint['container_tolerance_seconds'] + 1e-6
                and video_end <= container_end + endpoint['container_tolerance_seconds'])
        if endpoint['container'] == 'hls':
            require(isinstance(endpoint.get('manifest_sha256'), str)
                    and re.fullmatch(r'[0-9a-f]{64}', endpoint['manifest_sha256']) is not None
                    and finite(endpoint.get('manifest_duration_seconds'))
                    and abs(endpoint['manifest_duration_seconds'] - container_end) <= 0.001)

    expected = math.ceil((effective_end - start) / 2 - 1e-8)
    require(type(coverage.get('source_frames')) is int and coverage['source_frames'] >= expected
            and finite(coverage.get('max_source_gap_seconds')) and 0 <= coverage['max_source_gap_seconds'] < 2)
    source_count = coverage['source_frames']
    first, last = coverage.get('first_source_frame_seconds'), coverage.get('last_source_frame_seconds')
    cadence, quantum = coverage.get('source_frame_interval_seconds'), coverage.get('source_timestamp_quantum_seconds')
    if expected == 0:
        require(reason == 'verified_video_eof' and endpoint['audio_only'] is True
                and endpoint['video_end_seconds'] <= start and effective_end == start
                and source_count == 0 and first is None and last is None
                and coverage.get('first_sample_seconds') is None and coverage.get('last_sample_seconds') is None
                and coverage['max_source_gap_seconds'] == 0
                and close(coverage.get('tail_unobserved_seconds'), end - start))
        # FFmpeg may announce valid source timing even when seeking beyond video EOF.
        require((cadence is None and quantum is None)
                or (finite(cadence) and finite(quantum) and cadence > 0 and quantum > 0))
    else:
        require(source_count > 0 and finite(first) and finite(last)
                and finite(cadence) and cadence > 0 and finite(quantum) and quantum > 0)
        require(finite(cadence / quantum))
        tolerance = math.ceil(cadence / quantum) * quantum
        require(start - quantum <= first <= start + tolerance and first <= last <= end + tolerance
                and last + tolerance >= start + 2 * (expected - 1)
                and effective_end - last < 2
                and close(coverage.get('tail_unobserved_seconds'), max(0, end - last)))
        require((source_count == 1 and first == last and coverage['max_source_gap_seconds'] == 0)
                or (source_count > 1 and last > first and 0 < coverage['max_source_gap_seconds'] <= last - first + 1e-6
                    and last - first <= (source_count - 1) * coverage['max_source_gap_seconds'] + 1e-6))
        if reason == 'verified_video_eof':
            require(endpoint['audio_only'] is False
                    and endpoint['frame_agreement_tolerance_seconds'] <= cadence + quantum + 1e-6
                    and abs(last - endpoint['last_video_frame_seconds']) <= endpoint['frame_agreement_tolerance_seconds'] + 1e-6)
    return expected


def verify_chunk(planned, state, summary, quality=None):
    start, end = planned['start_seconds'], planned['end_seconds']
    coverage = summary.get('decode_coverage') or {}
    expected = verified_sample_count(start, end, coverage)
    if (any(state.get(field) != planned[field] for field in ('id', 'vod_pk', 'source', 'vod_id', 'start_seconds', 'end_seconds'))
            or any(summary.get(field) != planned[field] for field in ('vod_pk', 'source', 'vod_id'))
            or state['status'] != 'completed' or type(state.get('frames_processed')) is not int or state['frames_processed'] != expected
            or type(summary.get('frames_processed')) is not int or summary['frames_processed'] != expected
            or summary.get('chunk_id') != planned['id'] or summary.get('start_time') != start or summary.get('end_time') != end
            or type(coverage.get('sampled_frames')) is not int or coverage['sampled_frames'] != expected
            or type(coverage.get('minimum_expected_frames')) is not int or coverage['minimum_expected_frames'] != expected
            or coverage.get('sample_interval_seconds') != 2 or coverage.get('first_sample_seconds') != (start if expected else None)
            or coverage.get('last_sample_seconds') != (start + 2 * (expected - 1) if expected else None)
            or coverage.get('requested_start_seconds') != start or coverage.get('requested_end_seconds') != end):
        raise ValidationFailure('Terminal state and complete sampled timeline were not both confirmed')
    if (type(state.get('detections_count')) is not int or not 0 <= state['detections_count'] <= expected
            or type(summary.get('matchups_found')) is not int or state['detections_count'] != summary['matchups_found']
            or not isinstance(summary.get('detections'), list) or len(summary['detections']) != state['detections_count']):
        raise ValidationFailure('Persisted chunk detection total differs from the OCR report')
    if quality is not None and (state.get('quality') != quality or summary.get('quality') != quality):
        raise ValidationFailure('Persisted chunk and OCR rendition differ from the reviewed preparation')
    return {'id': planned['id'], 'start_seconds': start, 'end_seconds': end, 'status': state['status'],
            'frames_processed': expected, 'detections_count': state['detections_count'], 'decode_coverage': coverage}


def public_json(path, data=None):
    base = os.environ['BAZAARGHOST_API_URL'].rstrip('/')
    request = Request(base + path, headers={'Content-Type': 'application/json'},
                      data=None if data is None else json.dumps(data).encode())
    with open_backend(request, timeout=30) as response:
        payload = response.read(2_000_001)
    if len(payload) > 2_000_000:
        raise ValidationFailure('Public evidence response too large')
    return json.loads(payload)


def public_detections(selected, vod_id, expected_count):
    # One detection per sampled frame is the outer bound. Request the page past
    # an exact multiple of 500 too, so extra persisted rows cannot be overlooked.
    if not 0 <= expected_count <= MAX_CHUNKS * math.ceil(MAX_CHUNK_SECONDS / 2):
        raise ValidationFailure('OCR detection total exceeds the bounded sampled timeline')
    result = []
    for offset in range(0, expected_count + 1, 500):
        page = public_json('/rest/v1/rpc/search_video_detections',
                           {'source_filter': selected['source'], 'video_filter': vod_id,
                            'result_limit': 500, 'result_offset': offset})
        if not isinstance(page, list) or len(page) > 500:
            raise ValidationFailure('Unexpected public detection page')
        result.extend(page)
        if len(result) > expected_count:
            raise ValidationFailure('Public detection set exceeds the fresh OCR result set')
        if len(page) < 500:
            break
    return result


def verify_jpeg(payload):
    """Bound bytes and decoded pixels, then decode the complete JPEG, including its tail."""
    if not payload or len(payload) > MAX_JPEG_BYTES:
        raise ValidationFailure('Required JPEG exceeds the validation byte limit or is empty')
    from PIL import Image
    try:
        with Image.open(io.BytesIO(payload)) as image:
            width, height = image.size
            if image.format != 'JPEG' or not 0 < width * height <= MAX_JPEG_PIXELS:
                raise ValidationFailure('Required screenshot is not a bounded JPEG image')
            image.verify()
        # JPEG verify() alone does not decode the pixel stream; load() catches truncation.
        with Image.open(io.BytesIO(payload)) as image:
            image.load()
        return {'bytes': len(payload), 'width': width, 'height': height}
    except ValidationFailure:
        raise
    except Exception:
        raise ValidationFailure('Required JPEG could not be fully decoded') from None


def processor_environment(prepared, chunk_id):
    # OCR receives the processor capability only. Preserve the container's existing
    # model-cache home; no host home, GitHub registration token, catalog key or telemetry secret.
    allowed = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK',
               'BAZAARGHOST_API_URL', 'BAZAARGHOST_PROCESSOR_KEY', 'ENVIRONMENT', 'GITHUB_ACTIONS', 'GITHUB_REF')
    result = {key: os.environ[key] for key in allowed if key in os.environ}
    result.update(CHUNK_ID=chunk_id, QUALITY=prepared['quality'], STREAM_QUALITY=prepared.get('stream_quality', ''),
                  SFDE_PROFILE=prepared['sfde_profile'], OLD_TEMPLATES=prepared['old_templates'],
                  TEST_MODE='false', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
    return result


def main():
    destination = ROOT / 'validation-output'
    destination.mkdir(mode=0o700, exist_ok=True)
    report = {'status': 'running', 'phase': 'guard', 'chunks': [], 'screenshots': []}
    checkpoint = lambda: persist_report(destination, report)
    supervisor = ChildSupervisor(report, checkpoint)
    supervisor.install()
    try:
        checkpoint()
        validate_job(os.environ)
        selected = options(os.environ)
        if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() != os.environ['GITHUB_SHA']:
            raise ValidationFailure('Checked-out source does not match the dispatched commit')
        report.update(selection=selected, checkout_commit=os.environ['GITHUB_SHA'], actions_run_id=os.environ['GITHUB_RUN_ID'])
        supervisor.phase('health')
        verify_backend()  # Unauthenticated environment verification precedes either capability.
        supervisor.check()
        report['backend'] = public_json('/health')
        if (report['backend'].get('ok') is not True or report['backend'].get('environment') != 'validation'
                or not re.fullmatch(r'[a-f0-9]{40}', str(report['backend'].get('build_commit', '')))):
            raise ValidationFailure('Expected one identified validation backend build')
        supervisor.phase('reviewed_catalog')
        existing_catalog = None
        if selected['source'] == 'twitch':
            saved = vod_workflow.api('vod', {'source': 'twitch', 'source_id': selected['video_id']})
            existing_catalog = verify_twitch_catalog(saved, selected)
            video = saved
            report.update(catalog_method='existing_twitch_catalog', catalog=existing_catalog)
        else:
            metadata = youtube_metadata(selected['video_id'])
            supervisor.check()
            video = normalize_video(metadata, chapters=selected['ranges'], template_version=selected['templates'], recorded_at=selected['recorded_at'])
            reviewed_coverage(selected, video['duration_seconds'])
            account = ensure_account(metadata['channel_id'], metadata.get('channel') or metadata['channel_id'], enable=True, profile_id=selected['profile_id'])
            supervisor.check()
            saved = save_video(video, account, explicit_ranges=True)
            report['catalog_method'] = 'reviewed_youtube_catalog'
        cataloged_ranges = reviewed_coverage(selected, video['duration_seconds'])
        report.update(vod_id=saved['id'], source_duration_seconds=video['duration_seconds'],
                      cataloged_ranges=cataloged_ranges, full_source_video=cataloged_ranges == [[0, video['duration_seconds']]])
        os.environ.update(VOD_ID=selected['video_id'], VIDEO_SOURCE=selected['source'], REQUESTED_QUALITY=selected['quality'],
                          OLD_TEMPLATES=str(selected['templates'] == 'old').lower(), LOCAL='false', INPUT_CHUNKS='', QUEUED_AT='', SFDE_PROFILE='')
        supervisor.phase('prepare')
        output = destination / 'prepare.outputs'
        output.write_text('')
        supervisor.run([sys.executable, str(ROOT / 'scripts' / 'vod_workflow.py'), 'prepare'],
                       cwd=ROOT, env={**os.environ, 'GITHUB_OUTPUT': str(output)}, timeout=180)
        prepared = dict(line.split('=', 1) for line in output.read_text().splitlines())
        ids = json.loads(prepared.get('chunk_uuids', '[]'))
        if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_CHUNKS
                or any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value) for value in ids)
                or len(set(ids)) != len(ids)):
            raise ValidationFailure('Preparation must return 1–12 distinct chunk UUIDs')
        chunks = [vod_workflow.api(f'chunks/{chunk_id}') for chunk_id in ids]
        verify_plan(chunks, selected, saved['id'])
        profile = verify_prepared(prepared, selected, existing_catalog['profile'] if existing_catalog else None)
        quality = prepared.get('stream_quality') or prepared['quality']
        report['quality'] = quality
        report['profile'] = {key: profile.get(key) for key in ('id', 'profile_name', 'crop_region', 'igd_crop_region', 'scale', 'custom_edge', 'opaque_edge', 'from_date', 'to_date')}
        supervisor.phase('ocr')
        summaries = []
        for chunk in sorted(chunks, key=lambda item: item['start_seconds']):
            report['current_chunk'] = chunk['id']
            checkpoint()
            supervisor.run([sys.executable, '-u', 'src/sfde.py'], cwd=ROOT / 'sfde',
                           env=processor_environment(prepared, chunk['id']), timeout=CHUNK_TIMEOUT_SECONDS)
            summary = json.loads((OCR_OUTPUT / f'detections_{chunk["id"]}.json').read_text())
            state = vod_workflow.api(f'chunks/{chunk["id"]}')
            report['chunks'].append(verify_chunk(chunk, state, summary, quality=quality))
            summaries.append(summary)
            checkpoint()
        supervisor.phase('public_persistence')
        expected = [item for summary in summaries for item in summary['detections'] if item['confidence'] > 0.7]
        detections = public_detections(selected, saved['id'], len(expected))
        if any(row.get('vod_id') != saved['id'] or row.get('source') != selected['source']
               or row.get('source_id') != selected['video_id'] for row in detections):
            raise ValidationFailure('Public evidence belongs to another recording')
        visible = {(row['frame_time_seconds'], row['username']): row for row in detections}
        if len(detections) != len(expected) or len(visible) != len(expected):
            raise ValidationFailure('Public detection set differs from the fresh OCR result set')
        if len(expected) < selected['minimum_detections']:
            raise ValidationFailure('Reviewed ranges did not produce the required high-confidence detections')
        for item in expected:
            supervisor.check()
            row = visible.get((item['timestamp'], item['username']))
            if not row or row['igd'] != item['igd'] or row['rank'] != item['rank']:
                raise ValidationFailure('A reported detection or its extracted data is missing from the public API')
            path = row['storage_path']
            if not isinstance(path, str) or not path.startswith('/detections/') or '?' in path or '#' in path:
                raise ValidationFailure('Unexpected public screenshot path')
            with open_backend(Request(os.environ['BAZAARGHOST_API_URL'].rstrip('/') + path), timeout=30) as response:
                if response.status != 200 or response.headers.get_content_type() != 'image/jpeg':
                    raise ValidationFailure('A required screenshot is unavailable or is not JPEG')
                dimensions = verify_jpeg(response.read(MAX_JPEG_BYTES + 1))
            report['screenshots'].append({'detection_id': row['detection_id'], 'frame_time_seconds': item['timestamp'],
                                          'storage_path': path, 'igd': row['igd'], 'verified_jpeg': True, **dimensions})
        report['public_detections_verified'] = len(expected)
        report['igd_detections'] = sum(item['igd'] is not None for item in expected)
        if selected['require_igd'] and not report['igd_detections']:
            raise ValidationFailure('No extracted in-game day was observed')
        final = vod_workflow.get_vod()
        if final['status'] != 'completed':
            raise ValidationFailure('The cataloged VOD has not reached completed state')
        if existing_catalog is not None and verify_twitch_catalog(final, selected, completed=True) != existing_catalog:
            raise ValidationFailure('Twitch source metadata or profile changed during validation')
        report['backend_final'] = public_json('/health')
        if (report['backend_final'].get('ok') is not True or report['backend_final'].get('environment') != 'validation'
                or report['backend_final'].get('build_commit') != report['backend'].get('build_commit')):
            raise ValidationFailure('Backend changed during validation; repeat against one deployed build')
        supervisor.check()
        report.update(status='passed', phase='complete', vod_status=final['status'],
                      frames_processed=sum(chunk['frames_processed'] for chunk in report['chunks']))
    except ValidationCancelled:
        report.update(status='cancelled', error_type='ValidationCancelled')
        print(f'Validation cancelled during {report["phase"]}', file=sys.stderr)
    except Exception as error:
        report['status'] = 'failed'
        report['error_type'] = type(error).__name__
        if isinstance(error, ValidationFailure):
            report['error'] = str(error)
        print(f'Validation failed during {report["phase"]}: {report.get("error", type(error).__name__)}', file=sys.stderr)
    finally:
        try:
            checkpoint()
            with open(os.environ.get('GITHUB_STEP_SUMMARY', destination / 'summary.md'), 'a') as summary:
                summary.write(f'Validation **{report["status"]}** at `{report["phase"]}`. '
                              f'{len(report["chunks"])} chunks verified; see the validation artifact for exact ranges and sampled coverage.\n')
        finally:
            supervisor.restore()
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
