"""Natural EOF must be independently established, never inferred from decoder loss."""
import copy
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

import video_endpoint as endpoint


URL = 'https://media.example/leaf.m3u8?private-signature=do-not-retain'
HEADERS = ['-headers', 'Referer: https://provider.example/private-token\r\n']
META = {'format': {'format_name': 'mov,mp4,m4a,3gp,3g2,mj2', 'start_time': '62', 'duration': '100'},
        'streams': [{'index': 0, 'codec_type': 'audio', 'time_base': '1/48000', 'start_time': '62'},
                    {'index': 1, 'codec_type': 'video', 'time_base': '1/30', 'start_time': '62', 'disposition': {'attached_pic': 0}},
                    {'index': 2, 'codec_type': 'data'}]}
PACKETS = [{'stream_index': 1, 'pts': 4799, 'duration': 1},  # Last presentation frame; later rows are reordered.
           {'stream_index': 1, 'pts': 4797, 'duration': 1},
           {'stream_index': 0, 'pts': 7774976, 'duration': 1024},
           {'stream_index': 2, 'pts': 999999999}]
MANIFEST = b'#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + b'#EXTINF:10,\nsegment.ts\n' * 10 + b'#EXT-X-ENDLIST\n'


def verify(**changes):
    values = dict(requested_start=90, requested_end=100, last_decoded_seconds=97 + 29 / 30,
                  frame_interval_seconds=1 / 30, timestamp_quantum_seconds=1 / 30)
    return endpoint.verify_video_endpoint(URL, HEADERS, **{**values, **changes})


def probes(monkeypatch, *, metadata=None, packets=None, final_metadata=None):
    metadata = copy.deepcopy(META if metadata is None else metadata)
    result = {**copy.deepcopy(metadata if final_metadata is None else final_metadata),
              'packets': copy.deepcopy(PACKETS if packets is None else packets)}
    commands = []

    def probe(command):
        commands.append(command)
        return result if '-read_intervals' in command else metadata

    monkeypatch.setattr(endpoint, '_probe_json', probe)
    return commands


def test_packet_maxima_origin_and_absolute_tail_seek_prove_real_video_end(monkeypatch):
    commands = probes(monkeypatch)
    proof = verify()
    assert proof['method'] == 'ffprobe-packets-v1'
    assert proof['video_end_seconds'] == 98
    assert proof['last_video_frame_seconds'] == pytest.approx(97 + 29 / 30)
    assert proof['container_packet_end_seconds'] == 100
    assert proof['container_duration_seconds'] == 100
    assert proof['source_origin_seconds'] == 62
    assert proof['selected_video_start_seconds'] == 62
    assert proof['container_origin_alignment_seconds'] == 0
    assert proof['probe_start_seconds'] == 40
    assert proof['probe_start_timestamp_seconds'] == 102
    assert proof['video_stream_index'] == 1
    assert proof['video_packet_count'] == 2
    assert proof['closed'] and not proof['audio_only']
    assert commands[1][commands[1].index('-read_intervals') + 1] == '102.000000000%+#10000'
    assert all(command[-1] == URL and HEADERS[1] in command for command in commands)
    assert 'private-' not in json.dumps(proof)


def test_same_source_packet_probe_rejects_truncated_decoder_before_natural_end(monkeypatch):
    probes(monkeypatch)
    with pytest.raises(endpoint.VideoEndpointError, match='did not reach'):
        verify(last_decoded_seconds=96)


# An MP4 may end one rounded-up catalog second early (an audio tail the video
# lacks); two seconds is a mismatched catalog, not rounding.
@pytest.mark.parametrize('end', [98, 102, 17085])
def test_nonterminal_or_mismatched_catalog_end_fails_before_packet_probe(monkeypatch, end):
    commands = probes(monkeypatch)
    with pytest.raises(endpoint.VideoEndpointError, match='final catalog range'):
        verify(requested_end=end)
    assert len(commands) == 1


def test_no_decoded_frames_require_independently_proven_video_end_before_chunk(monkeypatch):
    probes(monkeypatch)
    proof = verify(requested_start=98, last_decoded_seconds=None,
                   frame_interval_seconds=None, timestamp_quantum_seconds=None)
    assert proof['audio_only'] and proof['video_end_seconds'] == 98
    with pytest.raises(endpoint.VideoEndpointError, match='audio-only'):
        verify(requested_start=97, last_decoded_seconds=None,
               frame_interval_seconds=None, timestamp_quantum_seconds=None)


@pytest.mark.parametrize('packets,match', [
    (PACKETS * 2500, 'natural EOF'),
    ([PACKETS[2]], 'terminal video'),
    ([PACKETS[0], {**PACKETS[2], 'duration': 0}], 'outside bounds'),
    ([PACKETS[0], {**PACKETS[2], 'duration': -1}], 'outside bounds'),
    ([PACKETS[0], {**PACKETS[2], 'duration': 48001}], 'game-media bound'),
    ([{**PACKETS[0], 'pts': 'N/A'}, PACKETS[2]], 'timestamp is invalid'),
    ([PACKETS[0], {**PACKETS[2], 'stream_index': 50}], 'unknown stream'),
    ([PACKETS[0], {**PACKETS[2], 'pts': 7700000}], 'container end'),
])
def test_packet_limits_missing_timestamps_and_incomplete_tail_are_not_eof(monkeypatch, packets, match):
    probes(monkeypatch, packets=packets)
    with pytest.raises(endpoint.VideoEndpointError, match=match):
        verify()


@pytest.mark.parametrize('change', [
    {'format': {**META['format'], 'duration': 'N/A'}},
    {'format': {**META['format'], 'duration': '0'}},
    {'format': {**META['format'], 'start_time': 'NaN'}},
    {'format': {**META['format'], 'format_name': 'matroska'}},
    {'streams': [{**META['streams'][1], 'time_base': '0/0'}]},
    {'streams': [{**META['streams'][1], 'disposition': {'attached_pic': 1}}]},
    {'streams': [META['streams'][0]]},
])
def test_ambiguous_or_missing_metadata_fails_closed(monkeypatch, change):
    probes(monkeypatch, metadata={**META, **change})
    with pytest.raises(endpoint.VideoEndpointError):
        verify()


def test_stream_selection_is_exact_first_video_and_cannot_change_between_probes(monkeypatch):
    metadata = {**META, 'streams': [*META['streams'], {'index': 3, 'codec_type': 'video', 'time_base': '1/60'}]}
    probes(monkeypatch, metadata=metadata)
    assert verify()['video_stream_index'] == 1
    probes(monkeypatch, final_metadata={**META, 'format': {**META['format'], 'start_time': '63'}})
    with pytest.raises(endpoint.VideoEndpointError, match='metadata changed'):
        verify()


def test_closed_hls_requires_identical_leaf_manifest_around_the_packet_probe(monkeypatch):
    probes(monkeypatch, metadata={**META, 'format': {**META['format'], 'format_name': 'hls'}})
    seen = []
    monkeypatch.setattr(endpoint, '_manifest_bytes', lambda *args: seen.append(args) or MANIFEST)
    proof = verify()
    assert proof['container'] == 'hls' and len(proof['manifest_sha256']) == 64
    assert proof['manifest_duration_seconds'] == 100 and len(seen) == 2
    snapshots = iter([MANIFEST, MANIFEST + b'#changed\n'])
    monkeypatch.setattr(endpoint, '_manifest_bytes', lambda *args: next(snapshots))
    with pytest.raises(endpoint.VideoEndpointError, match='manifest changed'):
        verify()


def test_zero_discontinuity_sequence_does_not_invent_a_discontinuity(monkeypatch):
    probes(monkeypatch, metadata={**META, 'format': {**META['format'], 'format_name': 'hls'}})
    manifest = MANIFEST.replace(b'#EXTM3U\n', b'#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n')
    monkeypatch.setattr(endpoint, '_manifest_bytes', lambda *args: manifest)
    assert verify()['container'] == 'hls'


@pytest.mark.parametrize('video_start,audio_pts,passes', [
    ('62.033000', 1543257660, True),
    ('62.100000', 1543257660, False),  # Offset exceeds one measured video frame.
    ('62.000000', 1543257660, False),  # Never normalize a negative offset.
    ('62.033000', 1543167660, False),  # A genuinely short audio tail is not EOF.
])
def test_hls_endpoint_accounts_only_for_measured_small_video_origin_offset(monkeypatch, video_start, audio_pts, passes):
    metadata = {'format': {'format_name': 'hls', 'start_time': '62.016667', 'duration': '17085.275'},
                'streams': [{'index': 0, 'codec_type': 'video', 'time_base': '1/90000', 'start_time': video_start},
                            {'index': 1, 'codec_type': 'audio', 'time_base': '1/90000', 'start_time': '62.016667'}]}
    packets = [{'stream_index': 0, 'pts': 1543136940, 'duration': 3000},
               {'stream_index': 1, 'pts': audio_pts, 'duration': 1920}]
    manifest = b'#EXTM3U\n#EXTINF:17085.275,\nsegment.ts\n#EXT-X-ENDLIST\n'
    probes(monkeypatch, metadata=metadata, packets=packets)
    monkeypatch.setattr(endpoint, '_manifest_bytes', lambda *args: manifest)
    values = dict(requested_start=17076, requested_end=17085,
                  last_decoded_seconds=1543136940 / 90000 - 62.016667,
                  frame_interval_seconds=1 / 30, timestamp_quantum_seconds=1 / 90000)
    if not passes:
        with pytest.raises(endpoint.VideoEndpointError):
            verify(**values)
        return
    proof = verify(**values)
    assert proof['selected_video_start_seconds'] == 62.033
    assert proof['container_origin_alignment_seconds'] == pytest.approx(0.016333)
    assert proof['selected_video_packet_duration_seconds'] == pytest.approx(1 / 30)
    assert proof['selected_video_timestamp_quantum_seconds'] == pytest.approx(1 / 90000)
    assert proof['container_tolerance_seconds'] == pytest.approx(0.016333 + 1920 / 90000 + 1 / 90000 + 1e-6)
    assert proof['container_packet_end_seconds'] == pytest.approx(17085.3119997)
    assert proof['video_end_seconds'] == pytest.approx(17083.9826663)
    assert proof['last_video_frame_seconds'] == pytest.approx(values['last_decoded_seconds'])


BENTO4_META = {'format': {'format_name': 'mov,mp4,m4a,3gp,3g2,mj2', 'start_time': '0.061000', 'duration': '4374.061000'},
               'streams': [{'index': 0, 'codec_type': 'video', 'time_base': '1/16000', 'start_time': '0.061000'}]}
# Real ffprobe values for Bilibili BV1fUn56tEwY:42856547006: the last presentation
# frame ends at 4374.061 s absolute, the declared duration measured from zero.
BENTO4_PACKETS = [{'stream_index': 0, 'pts': 69984443, 'duration': 533},
                  {'stream_index': 0, 'pts': 69983909, 'duration': 534}]


def bento4(monkeypatch, *, start='0.061000', duration='4374.061000', shift=0):
    metadata = copy.deepcopy(BENTO4_META)
    metadata['format'].update(start_time=start, duration=duration)
    metadata['streams'][0]['start_time'] = start
    packets = [{**packet, 'pts': packet['pts'] + shift} for packet in BENTO4_PACKETS]
    probes(monkeypatch, metadata=metadata, packets=packets)
    return verify(requested_start=3600, requested_end=4375, last_decoded_seconds=packets[0]['pts'] / 16000 - float(start),
                  frame_interval_seconds=1 / 30, timestamp_quantum_seconds=1 / 16000)


def test_mp4_duration_from_decode_zero_accounts_for_small_composition_delay(monkeypatch):
    proof = bento4(monkeypatch)
    assert proof['container'] == 'mp4'
    assert proof['container_origin_alignment_seconds'] == pytest.approx(0.061)
    assert proof['video_end_seconds'] == pytest.approx(4374.0)
    assert proof['container_packet_end_seconds'] == pytest.approx(4374.0)


def test_mp4_declared_end_may_round_the_final_sample_by_a_few_frames(monkeypatch):
    # Real ffprobe values for BV1nznG6oE9C:42854056865 (catalog 7213 s): neither
    # duration convention matches exactly; the declared end is 0.07 s past the last packet.
    metadata = copy.deepcopy(BENTO4_META)
    metadata['format'].update(start_time='0.033000', duration='7212.083500')
    metadata['streams'][0]['start_time'] = '0.033000'
    probes(monkeypatch, metadata=metadata, packets=[{'stream_index': 0, 'pts': 115391659, 'duration': 533}])
    proof = verify(requested_start=7200, requested_end=7213, last_decoded_seconds=115391659 / 16000 - 0.033,
                   frame_interval_seconds=1 / 30, timestamp_quantum_seconds=1 / 16000)
    assert proof['video_end_seconds'] == pytest.approx(7211.979)
    assert proof['container_origin_alignment_seconds'] == pytest.approx(0.1045)


def test_mp4_catalog_may_round_an_audio_tail_one_second_past_the_video(monkeypatch):
    # Real values for BV1H2JY6UEem:42805497523: play length 210.024 s (audio), catalog 211 s,
    # video-only MP4 exactly 210.000 s.
    metadata = copy.deepcopy(BENTO4_META)
    metadata['format'].update(start_time='0.000000', duration='210.000000')
    metadata['streams'][0]['start_time'] = '0.000000'
    probes(monkeypatch, metadata=metadata, packets=[{'stream_index': 0, 'pts': 3359467, 'duration': 533}])
    proof = verify(requested_start=0, requested_end=211, last_decoded_seconds=3359467 / 16000,
                   frame_interval_seconds=1 / 30, timestamp_quantum_seconds=1 / 16000)
    assert proof['video_end_seconds'] == pytest.approx(210.0)


@pytest.mark.parametrize('changes', [
    {'shift': -16000},                                                       # Packets stop a second early.
    {'start': '0.200000', 'duration': '4374.200000', 'shift': 2224},         # Delay beyond four frames.
])
def test_mp4_decode_zero_duration_never_covers_truncation_or_large_offsets(monkeypatch, changes):
    with pytest.raises(endpoint.VideoEndpointError, match='container end'):
        bento4(monkeypatch, **changes)


def test_ambiguous_mp4_duration_origin_is_rejected_without_rebasing(monkeypatch):
    metadata = {'format': {'format_name': 'mov,mp4', 'start_time': '1.978667', 'duration': '12'},
                'streams': [{'index': 0, 'codec_type': 'video', 'time_base': '1/30', 'start_time': '2'},
                            {'index': 1, 'codec_type': 'audio', 'time_base': '1/48000', 'start_time': '1.978667'}]}
    packets = [{'stream_index': 0, 'pts': 299, 'duration': 1},
               {'stream_index': 1, 'pts': 574976, 'duration': 1024}]
    probes(monkeypatch, metadata=metadata, packets=packets)
    with pytest.raises(endpoint.VideoEndpointError, match='container end'):
        verify(requested_start=0, requested_end=12, last_decoded_seconds=299 / 30 - 1.978667)


@pytest.mark.parametrize('manifest', [
    MANIFEST.replace(b'#EXT-X-ENDLIST\n', b''),
    b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nleaf.m3u8\n#EXT-X-ENDLIST\n',
    MANIFEST.replace(b'#EXTINF:10,', b'#EXT-X-GAP\n#EXTINF:10,', 1),
    MANIFEST.replace(b'#EXTINF:10,', b'#EXT-X-DISCONTINUITY\n#EXTINF:10,', 1),
    MANIFEST.replace(b'#EXTINF:10,', b'#EXTINF:5,', 1),
])
def test_live_master_gapped_or_mismatched_hls_cannot_prove_closure(monkeypatch, manifest):
    probes(monkeypatch, metadata={**META, 'format': {**META['format'], 'format_name': 'hls'}})
    monkeypatch.setattr(endpoint, '_manifest_bytes', lambda *args: manifest)
    with pytest.raises(endpoint.VideoEndpointError):
        verify()


@pytest.mark.parametrize('script,match', [
    ('import sys;sys.stderr.write("https://private.example/?secret=value");sys.exit(0)', 'reported an error'),
    ('import sys;sys.exit(2)', 'probe failed'),
    ('print("not-json-private-value")', 'could not be verified'),
    ('print("x"*4096)', 'output exceeded'),
    ('import time;time.sleep(30)', 'timed out'),
])
def test_probe_errors_output_limits_and_deadlines_are_static_and_bounded(monkeypatch, script, match):
    monkeypatch.setattr(endpoint, 'MAX_PROBE_BYTES', 1024)
    monkeypatch.setattr(endpoint, 'PROBE_TIMEOUT_SECONDS', 0.3)
    with pytest.raises(endpoint.VideoEndpointError, match=match) as error:
        endpoint._probe_json([sys.executable, '-c', script])
    assert 'private' not in str(error.value) and 'secret' not in str(error.value)


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='FFmpeg and FFprobe required')
@pytest.mark.parametrize('offset', [0, 2])
def test_real_muxed_longer_audio_requires_decoder_to_reach_actual_last_video(tmp_path, offset):
    media = tmp_path / 'longer-audio.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=red:s=64x64:r=30:d=8',
        '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000:duration=10',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', 'aac',
        '-output_ts_offset', str(offset), str(media),
    ], check=True, timeout=30)
    metadata = endpoint._probe_json(['ffprobe', '-v', 'error', '-show_entries', endpoint.METADATA_ENTRIES,
                                     '-of', 'json', str(media)])
    _, origin, duration, streams, index = endpoint._metadata(metadata)
    end = math.floor(duration)
    last_video = offset + 8 - 1 / 30 - float(origin)
    values = dict(requested_start=0, requested_end=end, last_decoded_seconds=last_video,
                  frame_interval_seconds=1 / 30, timestamp_quantum_seconds=float(streams[index]['time_base']), local_file=True)
    # FFprobe 5 reports this offset MP4's duration as 12 rather than its
    # origin-relative 10.021s extent. That ambiguity must fail closed; newer
    # FFprobe versions report the actual extent and can establish the endpoint.
    if abs(float(duration) - (offset + 10 - float(origin))) > 0.1:
        assert offset == 2
        with pytest.raises(endpoint.VideoEndpointError, match='container end'):
            endpoint.verify_video_endpoint(media, [], **values)
        return
    proof = endpoint.verify_video_endpoint(media, [], **values)
    assert proof['video_end_seconds'] == pytest.approx(offset + 8 - float(origin), abs=0.00001)
    assert proof['video_end_seconds'] < end
    assert proof['last_video_frame_seconds'] == pytest.approx(last_video, abs=0.00001)
    with pytest.raises(endpoint.VideoEndpointError, match='did not reach'):
        endpoint.verify_video_endpoint(media, [], **{**values, 'last_decoded_seconds': last_video - 1})
    pure_audio = endpoint.verify_video_endpoint(media, [], **{**values, 'requested_start': math.ceil(proof['video_end_seconds']),
                       'last_decoded_seconds': None, 'frame_interval_seconds': None, 'timestamp_quantum_seconds': None})
    assert pure_audio['audio_only']
