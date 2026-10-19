#!/usr/bin/env python3
"""
SFDE Processor - Main orchestrator for VOD processing pipeline
Stream → Filter → Detect → Extract
"""

import os
import sys
import signal
import queue
import threading
import subprocess
import time
import json
import logging
import math
from typing import Optional, Dict, Any, Tuple, List, Callable
from opentelemetry import context as otel_context
import yaml
import cv2
import numpy as np

# skips connectivity check to the paddle OCR model hoster (models are pre-downloaded)
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

# Import worker modules
from video import SourceTimeline, timestamped_frames
from video_endpoint import VideoEndpointError, verify_video_endpoint
from media_source import ffmpeg_input_args, ffmpeg_progressive_args, resolve_media, validate_source_id
from renditions import parse_rendition, processing_quality
from frame_processor import FrameProcessor
from backend_client import BackendClient
from json_logger import JSONFormatter
from telemetry import (
    init_telemetry,
    create_span,
    record_counter,
    record_histogram,
    record_gauge,
    extract_trace_context,
    shutdown_telemetry,
)

QUALITY_RESOLUTIONS = {
    '360p': (640, 360),
    '480p': (854, 480),
    '720p': (1280, 720),
    '1080p': (1920, 1080),
}



class MediaReadError(RuntimeError):
    """A progressive HTTP read that failed mid-stream; a fresh read usually succeeds.

    Uncached Bilibili CDN reads can return corrupt data, time out, or end early.
    The first read normally leaves the part cached, so the chunk retries once in
    process instead of waiting for the scheduler's cooldown and a new runner.
    """


MEDIA_READ_ATTEMPTS = 2
MEDIA_RETRY_DELAY_SECONDS = 20
# Never start a retry that the chunk's single deadline could not plausibly finish.
MEDIA_RETRY_MIN_REMAINING_SECONDS = 300
# A decode that stops this far before the requested end was truncated, not a
# rounding question at the recording's natural end.
TRUNCATED_READ_SECONDS = 10

class SFDEProcessor:
    """Main SFDE processor orchestrator"""

    def __init__(self, config: Dict[str, Any]) -> None:
        """Initialize SFDE processor with configuration"""
        self.chunk_id = config["chunk_id"]
        self.test_mode = config.get("test_mode", False)
        requested_quality = config.get('quality', '480p')
        self.quality = processing_quality(requested_quality)
        if self.quality not in QUALITY_RESOLUTIONS:
            raise ValueError(f'Unsupported QUALITY: {requested_quality}')
        self.old_templates = config.get('old_templates', False)
        if self.old_templates and self.quality != '480p':
            raise ValueError('Old templates require 480p quality')
        self.stream_quality = config.get('stream_quality') or None
        _, self.video_fps = parse_rendition(self.stream_quality or requested_quality)
        self.formatted_quality = self.stream_quality or requested_quality

        # Load configuration
        self.config = self._load_config()

        # Parse SFDE profile from environment variable
        self.profile = self._parse_sfde_profile()

        # Initialize backend client first to fetch chunk details
        self.backend = BackendClient(
            self.config, test_mode=self.test_mode, quality=self.quality
        )

        # Fetch chunk details from database
        chunk_details = self.backend.get_chunk_details(self.chunk_id)
        if not chunk_details:
            raise ValueError(f"Could not fetch details for chunk {self.chunk_id}")

        # Set processing parameters from chunk details
        self.vod_id = chunk_details["vod_id"]
        self.vod_pk = chunk_details.get("vod_pk")
        self.source = chunk_details.get("source", "twitch")
        validate_source_id(self.source, self.vod_id)
        self.start_time = chunk_details["start_seconds"]
        self.end_time = chunk_details["end_seconds"]
        self.streamer = chunk_details.get("streamer")
        if not self.vod_id or not 0 <= self.start_time < self.end_time:
            raise ValueError('Chunk must identify a VOD and a positive time range')

        # Set streamer on backend client for metric attribution
        self.backend.set_streamer(self.streamer)

        # Initialize components
        self.frame_queue = queue.Queue(maxsize=self.config["processing"]["queue_size"])
        self.result_queue = queue.Queue(maxsize=self.config["processing"]["queue_size"])
        self.shutdown = threading.Event()  # Cancellation/failure only; EOF uses done events.
        self.frames_done = threading.Event()
        self.results_done = threading.Event()
        self.worker_errors = queue.Queue()
        self.threads = []

        # Process state
        self.streamlink_proc: Optional[subprocess.Popen] = None
        self.ffmpeg_proc: Optional[subprocess.Popen] = None
        self.frames_processed = 0
        self.decode_coverage: Optional[Dict[str, Any]] = None
        self.matchups_found = 0
        self.result_batch = []  # Current batch being accumulated
        self.all_detections = []  # All detections for summary export

        # IGD subregion slices (computed by ffmpeg_worker, read by opencv_worker).
        # Initialize here so opencv_worker can safely read them before ffmpeg_worker sets them.
        self._nameplate_slice: Optional[List[int]] = None
        self._igd_slice: Optional[List[int]] = None

        self._setup_logging()
        self._init_telemetry()

        # Initialize frame processor with quality information and template selection
        self.frame_processor = FrameProcessor(
            self.config,
            quality=self.quality,
            old_templates=self.old_templates,
            profile=self.profile,
            streamer=self.streamer,
        )

        # Register signal handlers
        signal.signal(signal.SIGTERM, self._handle_shutdown)
        signal.signal(signal.SIGINT, self._handle_shutdown)

    def percent_to_pixels(
        self, crop_percent: List[float], frame_width: int, frame_height: int
    ) -> List[int]:
        """Convert percentage-based crop to pixel coordinates with proper rounding

        Args:
            crop_percent: [x, y, width, height] as fractions (0.0-1.0)
            frame_width: Width of the frame in pixels
            frame_height: Height of the frame in pixels

        Returns:
            [width, height, x, y] in pixels for FFmpeg crop filter
        """
        x_percent, y_percent, w_percent, h_percent = crop_percent

        # Calculate pixel values with proper rounding
        x = math.floor(x_percent * frame_width)  # Round left down
        y = math.floor(y_percent * frame_height)  # Round top down
        w = math.ceil(w_percent * frame_width)  # Round width up
        h = math.ceil(h_percent * frame_height)  # Round height up

        # Ensure values don't exceed frame bounds
        x = min(x, frame_width - 1)
        y = min(y, frame_height - 1)
        w = min(w, frame_width - x)
        h = min(h, frame_height - y)

        # Return in FFmpeg format [width, height, x, y]
        return [w, h, x, y]

    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from YAML file"""
        config_path = os.path.join(os.path.dirname(__file__), "..", "config.yaml")
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)

        # Override with environment variables if present
        if os.getenv("BAZAARGHOST_API_URL"):
            config["backend"]["url"] = os.getenv("BAZAARGHOST_API_URL")
        if os.getenv("BAZAARGHOST_PROCESSOR_KEY"):
            config["backend"]["secret_key"] = os.getenv("BAZAARGHOST_PROCESSOR_KEY")

        for section, names in [('processing', ['queue_size', 'timeout', 'frame_rate']),
                               ('backend', ['batch_size', 'connection_timeout'])]:
            for name in names:
                value = config[section][name]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                    raise ValueError(f'{section}.{name} must be positive and finite')
        if config['processing']['timeout'] >= 35 * 60:
            raise ValueError('Processing timeout must be shorter than the 35-minute claim lease')
        return config

    def _parse_sfde_profile(self) -> Dict[str, Any]:
        """Parse SFDE profile from environment variable

        Returns:
            Dictionary containing profile data with crop_region, scale, etc.

        Raises:
            ValueError: If SFDE_PROFILE is missing or invalid JSON
        """
        sfde_profile_json = os.getenv("SFDE_PROFILE")

        if not sfde_profile_json:
            raise ValueError(
                "SFDE_PROFILE environment variable is required. "
                "This should be provided by the GitHub Actions workflow as a JSON string."
            )

        try:
            profile = json.loads(sfde_profile_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"SFDE_PROFILE is not valid JSON: {e}")

        if not isinstance(profile, dict):
            raise ValueError('SFDE_PROFILE must be a JSON object')
        for field in ('crop_region', 'igd_crop_region'):
            region = profile.get(field)
            if region is None and field == 'igd_crop_region':
                continue
            if not isinstance(region, list) or len(region) != 4:
                raise ValueError(f'SFDE_PROFILE {field} must contain [x, y, width, height]')
            try:
                x, y, width, height = [float(value) for value in region]
            except (ValueError, TypeError) as error:
                raise ValueError(f'SFDE_PROFILE {field} must contain numbers') from error
            if not all(math.isfinite(value) for value in (x, y, width, height)) or not (
                0 <= x < 1 and 0 <= y < 1 and 0 < width <= 1 - x + 1e-9
                and 0 < height <= 1 - y + 1e-9
            ):
                raise ValueError(f'SFDE_PROFILE {field} must fit within the video frame')
            profile[field] = [x, y, width, height]
        edge = profile.get('custom_edge')
        if edge is not None:
            edge = float(edge)
            if not math.isfinite(edge) or not 0 < edge <= 1:
                raise ValueError('SFDE_PROFILE custom_edge must be in (0, 1]')
            profile['custom_edge'] = edge
        if not isinstance(profile.get('opaque_edge', False), bool):
            raise ValueError('SFDE_PROFILE opaque_edge must be a boolean')

        return profile

    def _compute_combined_crop(
        self, frame_width: int, frame_height: int
    ) -> Tuple[List[int], Optional[List[int]], Optional[List[int]]]:
        """Compute a combined FFmpeg crop that encompasses both nameplate and IGD regions.

        When igd_crop_region is present in the profile, computes a bounding box that
        covers both crop regions. Returns the combined crop for FFmpeg plus local offsets
        for slicing each subregion from the decoded frame.

        Args:
            frame_width: Width of the source frame in pixels.
            frame_height: Height of the source frame in pixels.

        Returns:
            Tuple of:
                - combined_crop: [w, h, x, y] in pixels for the FFmpeg crop filter
                - nameplate_slice: [x_offset, y_offset, w, h] local offsets within combined crop, or None if no IGD
                - igd_slice: [x_offset, y_offset, w, h] local offsets within combined crop, or None if no IGD
        """
        nameplate_pixels = self.percent_to_pixels(
            self.profile["crop_region"], frame_width, frame_height
        )
        np_w, np_h, np_x, np_y = nameplate_pixels

        igd_crop = self.profile.get("igd_crop_region")
        if not igd_crop:
            # No IGD — return nameplate crop only, no subregion slicing needed
            return nameplate_pixels, None, None

        igd_pixels = self.percent_to_pixels(igd_crop, frame_width, frame_height)
        igd_w, igd_h, igd_x, igd_y = igd_pixels

        # Compute bounding box that encompasses both regions
        bbox_x = min(np_x, igd_x)
        bbox_y = min(np_y, igd_y)
        bbox_right = max(np_x + np_w, igd_x + igd_w)
        bbox_bottom = max(np_y + np_h, igd_y + igd_h)
        bbox_w = bbox_right - bbox_x
        bbox_h = bbox_bottom - bbox_y

        # Clamp to frame bounds
        bbox_w = min(bbox_w, frame_width - bbox_x)
        bbox_h = min(bbox_h, frame_height - bbox_y)

        combined_crop = [bbox_w, bbox_h, bbox_x, bbox_y]

        # Compute local offsets within the combined crop
        nameplate_slice = [np_x - bbox_x, np_y - bbox_y, np_w, np_h]
        igd_slice = [igd_x - bbox_x, igd_y - bbox_y, igd_w, igd_h]

        return combined_crop, nameplate_slice, igd_slice

    def _setup_logging(self) -> None:
        """Setup structured JSON logging"""
        self.logger = logging.getLogger("sfde")
        self.logger.setLevel(getattr(logging, self.config["logging"]["level"]))

        # JSON formatter
        formatter = JSONFormatter()

        # Console handler (stdout for docker logs / GitHub Actions)
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        for handler in self.logger.handlers[:]:
            if isinstance(handler, logging.StreamHandler) and isinstance(handler.formatter, JSONFormatter):
                self.logger.removeHandler(handler)
                handler.close()
        self.logger.addHandler(console_handler)

        self.environment = os.getenv('ENVIRONMENT', 'production')
        self.logger.propagate = False
        context = {
            'vod_id': self.vod_id, 'chunk_id': self.chunk_id,
            'streamer': self.streamer, 'quality': self.formatted_quality,
        }
        def add_context(record: logging.LogRecord) -> bool:
            for key, value in context.items():
                if not hasattr(record, key):
                    setattr(record, key, value)
            return True
        console_handler.addFilter(add_context)

    def _init_telemetry(self) -> None:
        """Initialize OpenTelemetry for distributed tracing and metrics"""
        # Initialize telemetry (will be no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
        telemetry_enabled = init_telemetry(
            service_name="sfde", environment=self.environment
        )

        if telemetry_enabled:
            self.logger.info("OpenTelemetry initialized successfully")
        else:
            self.logger.info(
                "OpenTelemetry disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)"
            )

        # Extract trace context if provided (propagated from GitHub Actions via process-vod edge function)
        trace_parent = os.getenv("TRACEPARENT")
        if trace_parent:
            self.trace_context = extract_trace_context({"traceparent": trace_parent})
            self.logger.info(
                f"Trace context extracted from TRACEPARENT: {trace_parent[:50]}..."
            )
        else:
            self.trace_context = None

        # Common span attributes for this chunk
        self.span_attributes = {
            "vod.id": self.vod_id,
            "chunk.id": self.chunk_id,
            "streamer": self.streamer,
            "quality": self.formatted_quality,
            "profile.name": self.profile.get("profile_name", "default"),
            "start_seconds": self.start_time,
            "end_seconds": self.end_time,
        }

    def _handle_shutdown(self, signum, frame):
        """Handle shutdown signals gracefully"""
        self.logger.info(f"Received signal {signum}, initiating shutdown")
        self.shutdown.set()

    def process_vod_chunk(self) -> Dict[str, Any]:
        """Main processing entry point"""
        self.logger.info(
            f"Starting VOD processing: {self.vod_id} [{self.start_time}-{self.end_time}]"
        )
        self.logger.info(
            f"Using SFDE profile: {self.profile.get('profile_name', 'unknown')}"
        )
        self.logger.info(f"Crop region: {self.profile['crop_region']}")
        if self.old_templates:
            self.logger.info(
                "Using small templates (underscore-prefixed) for older VOD processing"
            )

        claimed = False

        # Track processing time for metrics
        processing_start_time = time.time()

        # Wrap entire processing in a root span
        with create_span("process_chunk", attributes=self.span_attributes, context=self.trace_context) as root_span:
            try:
                if not self.backend.claim_chunk(self.chunk_id, expected_profile=self.profile, expected_old_templates=self.old_templates):
                    raise ValueError(f'Chunk {self.chunk_id} is unavailable, already claimed, or has changed profile/templates')
                claimed = True
                self.backend.delete_chunk_detections(self.chunk_id)
                self.backend.update_chunk(self.chunk_id, 'processing', quality=self.formatted_quality)

                # Pre-compute combined crop and subregion slices so both
                # ffmpeg_worker and opencv_worker have them before they start.
                pre_fw, pre_fh = QUALITY_RESOLUTIONS[self.quality]
                combined_crop, nameplate_slice, igd_slice = self._compute_combined_crop(
                    pre_fw, pre_fh
                )
                self._combined_crop = combined_crop
                self._nameplate_slice = nameplate_slice
                self._igd_slice = igd_slice

                if igd_slice:
                    self.logger.info(
                        f"IGD detection enabled. Combined crop: {combined_crop}, "
                        f"nameplate slice: {nameplate_slice}, IGD slice: {igd_slice}"
                    )

                self.worker_context = otel_context.get_current()
                deadline = time.monotonic() + self.config['processing']['timeout']
                for attempt in range(1, MEDIA_READ_ATTEMPTS + 1):
                    try:
                        self._run_workers(deadline)
                        break
                    except MediaReadError as error:
                        self._stop_workers()
                        remaining = deadline - time.monotonic()
                        # A worker that outlived its stop would share the retry's fresh state.
                        if (attempt == MEDIA_READ_ATTEMPTS or any(thread.is_alive() for thread in self.threads)
                                or remaining < MEDIA_RETRY_MIN_REMAINING_SECONDS + MEDIA_RETRY_DELAY_SECONDS):
                            raise
                        self.logger.warning('media_read_retry', extra={
                            'event': 'media_read_retry', 'attempt': attempt, 'error': str(error),
                            'remaining_seconds': round(remaining)})
                        self._reset_for_retry()
                        time.sleep(MEDIA_RETRY_DELAY_SECONDS)
                if self.shutdown.is_set():
                    raise RuntimeError('Chunk processing was interrupted')
                if self.frames_processed == 0 and not (
                    self.decode_coverage and self.decode_coverage.get('completion_reason') == 'verified_video_eof'
                    and self.decode_coverage.get('minimum_expected_frames') == 0
                ):
                    raise RuntimeError('Decoder produced no frames')
                if self.decode_coverage is not None and self.frames_processed != self.decode_coverage['sampled_frames']:
                    raise RuntimeError('Decoded coverage was not fully processed')
                status = 'completed'

                # Record telemetry metrics
                duration_ms = (time.time() - processing_start_time) * 1000

                self.logger.info('chunk_finished', extra={
                    'event': 'chunk_finished', 'status': status,
                    'frames_processed': self.frames_processed, 'matchups_found': self.matchups_found,
                    'decode_coverage': self.decode_coverage,
                    'duration_ms': round(duration_ms, 2),
                })
                metric_attrs = {
                    "streamer": self.streamer or "unknown",
                    "quality": self.formatted_quality,
                }


                record_histogram("processing_duration", duration_ms, metric_attrs)

                if duration_ms > 0:
                    fps = self.frames_processed / (duration_ms / 1000)
                    record_histogram("frame_processing_rate", fps, metric_attrs)

                # Set span attributes with final results
                if root_span:
                    root_span.set_attribute("frames.processed", self.frames_processed)
                    root_span.set_attribute("matchups.found", self.matchups_found)
                    root_span.set_attribute("duration.ms", duration_ms)
                    root_span.set_attribute("status", status)

                self.backend.update_chunk(
                    self.chunk_id, 'completed', frames_processed=self.frames_processed,
                    detections_count=len(self.all_detections), quality=self.formatted_quality,
                    processing_duration_ms=round(duration_ms),
                )

                record_counter("chunks_completed", 1, metric_attrs)

                # Export detection summary for GitHub Actions workflow
                self.export_detection_summary()

                return {
                    "status": status,
                    "frames_processed": self.frames_processed,
                    "matchups_found": self.matchups_found,
                    "vod_id": self.vod_id,
                    "start_time": self.start_time,
                    "end_time": self.end_time,
                    "quality": self.quality,
                    "decode_coverage": self.decode_coverage,
                }

            except Exception as e:
                self.logger.error(f"Processing failed: {e}", exc_info=True)
                self._stop_workers()
                # Record failure metric
                record_counter(
                    "chunks_failed",
                    1,
                    {
                        "streamer": self.streamer or "unknown",
                        "quality": self.formatted_quality,
                        "error_type": type(e).__name__,
                    },
                )
                if claimed:
                    try:
                        self.backend.update_chunk(self.chunk_id, 'failed', error=str(e), quality=self.formatted_quality)
                    except Exception as update_error:
                        self.logger.error('Failed to persist chunk failure: %s', update_error)
                raise
            finally:
                self.cleanup()

    def _run_workers(self, deadline: float) -> None:
        """Decode, detect and upload one attempt; raise the first worker error."""
        self.threads = [
            threading.Thread(target=self._run_worker, args=(self.ffmpeg_worker, self.frames_done), name="ffmpeg", daemon=True),
            threading.Thread(target=self._run_worker, args=(self.opencv_worker, self.results_done), name="opencv", daemon=True),
            threading.Thread(target=self._run_worker, args=(self.result_worker,), name="results", daemon=True),
        ]
        for thread in self.threads:
            thread.start()
        while any(thread.is_alive() for thread in self.threads):
            if self.shutdown.is_set():
                if not self.worker_errors.empty():
                    raise self.worker_errors.get()
                raise RuntimeError('Chunk processing was interrupted')
            if time.monotonic() >= deadline:
                raise TimeoutError('Chunk processing deadline exceeded')
            for thread in self.threads:
                thread.join(timeout=0.1)
        if not self.worker_errors.empty():
            raise self.worker_errors.get()

    def _reset_for_retry(self) -> None:
        """Start the chunk over under the same claim; the caller stopped every worker."""
        # Uploaded detections belong to the failed attempt; the retry republishes.
        self.backend.delete_chunk_detections(self.chunk_id)
        self.frame_queue = queue.Queue(maxsize=self.config["processing"]["queue_size"])
        self.result_queue = queue.Queue(maxsize=self.config["processing"]["queue_size"])
        self.shutdown = threading.Event()
        self.frames_done = threading.Event()
        self.results_done = threading.Event()
        self.worker_errors = queue.Queue()
        self.threads = []
        self.ffmpeg_proc = None
        self.frames_processed = 0
        self.decode_coverage = None
        self.matchups_found = 0
        self.result_batch = []
        self.all_detections = []
        self.frame_processor.reset_state()

    def _run_worker(self, worker: Callable[[], None], done: Optional[threading.Event] = None) -> None:
        """Report worker exceptions to the orchestrator and always signal EOF."""
        token = otel_context.attach(getattr(self, 'worker_context', otel_context.get_current()))
        try:
            worker()
        except Exception as error:
            self.logger.exception('%s failed', threading.current_thread().name)
            self.worker_errors.put(error)
            self.shutdown.set()
        finally:
            otel_context.detach(token)
            if done is not None:
                done.set()

    def _put(self, destination: queue.Queue, value: Any) -> None:
        """Apply backpressure instead of dropping frames when OCR is slower."""
        while not self.shutdown.is_set():
            try:
                destination.put(value, timeout=0.1)
                return
            except queue.Full:
                continue
        raise RuntimeError('Processing cancelled during queue write')

    def _resolve_stream(self) -> str:
        """Resolve the selected HLS rendition; FFmpeg owns accurate VOD seeking.

        Piping a Streamlink segment rebases timestamps at a rounded segment
        boundary. Seeking the playlist itself preserves the requested offset.
        """
        media = resolve_media(self.source, self.vod_id, self.quality,
                              **({'stream_quality': self.stream_quality} if self.source == 'twitch' and self.stream_quality else {}))
        self._media_input_args = ffmpeg_input_args(media)
        self._media_progressive_args = ffmpeg_progressive_args(media)
        self.logger.info('Media resolved with %s (%sp input)', media['resolver'], media['height'])
        return media['url']

    def ffmpeg_worker(self) -> None:
        """Decode frames and enqueue each image together with its timestamp."""
        # Limit demuxing before sampling. An output -t is rounded to the encoder's
        # coarse FPS time base and can discard a valid final partial interval.
        # showinfo is our timestamp protocol. FFmpeg 5's threaded H.264
        # decoder can splice a multi-part warning into a showinfo record,
        # losing its filter prefix. Keep decoding on one thread and disable
        # progress output rather than accepting unattributed timestamps.
        cmd = ['ffmpeg', '-nostdin', '-nostats', '-hide_banner', '-loglevel', 'info',
               '-threads', '1',
               '-t', str(self.end_time - self.start_time)]
        # Read the opening chunk directly. FFmpeg 5's HLS input seek at zero
        # can skip opening frames when the transport timestamp origin is nonzero.
        seek = ['-ss', str(self.start_time)] if self.start_time > 0 else []
        if self.test_mode:
            directory = self.config['test_mode']['data_directory']
            if not os.path.isabs(directory):
                directory = os.path.join(os.path.dirname(__file__), '..', '..', directory)
            input_file = os.getenv('TEST_VIDEO') or os.path.join(directory, str(self.vod_id), f'{self.quality}.mp4')
            if not os.path.isfile(input_file):
                raise FileNotFoundError(f'Test video not found: {input_file}')
            cmd += seek + ['-i', input_file]
            locator, input_args = input_file, []
        else:
            url = self._resolve_stream()
            cmd += self._media_input_args + self._media_progressive_args
            cmd += ['-rw_timeout', '30000000'] + seek + ['-i', url]
            locator, input_args = url, self._media_input_args
        width, height = QUALITY_RESOLUTIONS[self.quality]
        w, h, x, y = self._combined_crop
        filters = (
            f'showinfo@bg_source=checksum=0,fps={self.config["processing"]["frame_rate"]}:eof_action=pass,'
            f'scale={width}:{height},crop={w}:{h}:{x}:{y}:exact=1,showinfo@bg_sample=checksum=0'
        )
        cmd += [
            '-map', '0:v:0', '-an', '-vf', filters,
            # An empty, independently verified audio-only tail still initializes
            # the encoder. FFmpeg 8 cannot infer JPEG's full range from frames
            # that do not exist, so make its normal JPEG pixel format explicit.
            '-fps_mode', 'passthrough', '-f', 'image2pipe', '-vcodec', 'mjpeg',
            '-pix_fmt', 'yuvj420p', 'pipe:1',
        ]
        self.ffmpeg_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        interval = 1 / self.config['processing']['frame_rate']
        source_timeline = SourceTimeline(self.end_time - self.start_time, interval)
        tolerance = max(0.001, interval * 1e-6)
        sample_count, first_pts, last_pts = 0, None, None
        diagnostics = []
        for frame_data, pts in timestamped_frames(
            self.ffmpeg_proc.stdout, self.ffmpeg_proc.stderr, self.logger,
            source_timeline=source_timeline, validate_end=False, diagnostics=diagnostics,
        ):
            timestamp = self.start_time + int(pts)
            if 0 <= pts < self.end_time - self.start_time:
                # Validate the sampled timeline before integer conversion for storage.
                # Missing/duplicate samples must not be hidden by a plausible total count.
                if last_pts is None:
                    first_pts = pts
                    if abs(pts) > tolerance:
                        raise RuntimeError(f'Incomplete decoder coverage: first sample starts at offset {pts:g}s')
                elif abs(pts - last_pts - interval) > tolerance:
                    raise RuntimeError(f'Incomplete decoder coverage: sample gap {pts - last_pts:g}s, expected {interval:g}s')
                last_pts = pts
                sample_count += 1
                self._put(self.frame_queue, (frame_data, timestamp))
                record_gauge("queue_depth", 1, {"streamer": self.streamer or "unknown", "quality": self.formatted_quality})
        code = self.ffmpeg_proc.wait(timeout=10)
        progressive = bool(getattr(self, '_media_progressive_args', None)) and not self.test_mode
        if code:
            raise (MediaReadError if progressive else RuntimeError)(
                f'FFmpeg exited with code {code}' + (f': {diagnostics[0]}' if diagnostics else ''))
        # Normally every requested tick must exist. A recording can end with
        # audio after its final video frame; only a separate probe of this same
        # finalized source may establish a shorter terminal video interval.
        duration = self.end_time - self.start_time
        requested_samples = math.ceil(duration / interval - 1e-8)
        endpoint = None
        try:
            source_timeline.validate()
            if sample_count != requested_samples:
                raise RuntimeError('Requested sampling timeline is incomplete')
        except RuntimeError as coverage_error:
            try:
                endpoint = verify_video_endpoint(
                    locator, input_args, requested_start=self.start_time, requested_end=self.end_time,
                    last_decoded_seconds=(self.start_time + float(source_timeline.last_pts * source_timeline.time_base)
                                          if source_timeline.count else None),
                    frame_interval_seconds=float(source_timeline.frame_interval) if source_timeline.frame_interval else None,
                    timestamp_quantum_seconds=float(source_timeline.time_base) if source_timeline.time_base else None,
                    local_file=self.test_mode,
                )
            except VideoEndpointError as error:
                decoded = (float(source_timeline.last_pts * source_timeline.time_base)
                           if source_timeline.count else 0.0)
                truncated = progressive and duration - decoded > TRUNCATED_READ_SECONDS
                raise (MediaReadError if truncated else RuntimeError)(
                    f'Incomplete decoder coverage: {coverage_error}; endpoint verification: {error}'
                    + (f'; FFmpeg: {diagnostics[0]}' if diagnostics else '')) from None
            duration = max(0, min(self.end_time, endpoint['video_end_seconds']) - self.start_time)
            source_timeline.validate(duration=duration)
        minimum_samples = math.ceil(duration / interval - 1e-8)
        if sample_count != minimum_samples:
            raise RuntimeError(
                f'Incomplete decoder coverage: {sample_count} samples, expected at least '
                f'{minimum_samples} for [{self.start_time},{self.end_time}) at '
                f'{self.config["processing"]["frame_rate"]:g} fps; last offset {last_pts}'
            )
        self.decode_coverage = {
            **source_timeline.summary(self.start_time, duration=duration),
            'sampled_frames': sample_count,
            'minimum_expected_frames': minimum_samples,
            'requested_expected_frames': requested_samples,
            'completion_reason': 'verified_video_eof' if endpoint else 'requested_range',
            'video_endpoint': endpoint,
            'effective_video_end_seconds': self.start_time + duration,
            'unobserved_catalog_tail_seconds': self.end_time - self.start_time - duration,
            'sample_interval_seconds': interval,
            'first_sample_seconds': self.start_time + first_pts if first_pts is not None else None,
            'last_sample_seconds': self.start_time + last_pts if last_pts is not None else None,
            'requested_start_seconds': self.start_time,
            'requested_end_seconds': self.end_time,
        }
        self.logger.info('decode_coverage_verified', extra={
            'event': 'decode_coverage_verified', **self.decode_coverage,
        })

    def _decode_jpeg(self, frame_data: bytes) -> Optional[np.ndarray]:
        """Decode JPEG bytes to a BGR numpy array.

        Args:
            frame_data: Raw JPEG bytes.

        Returns:
            BGR numpy array, or None if decoding fails.
        """
        arr = np.frombuffer(frame_data, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return frame

    def _encode_jpeg(self, frame: np.ndarray) -> bytes:
        """Encode a BGR numpy array to JPEG bytes.

        Args:
            frame: BGR numpy array.

        Returns:
            Raw JPEG bytes.
        """
        _, buf = cv2.imencode(".jpg", frame)
        return buf.tobytes()

    def _slice_subregion(self, frame: np.ndarray, region: List[int]) -> np.ndarray:
        """Slice a subregion from a decoded frame.

        Args:
            frame: Decoded BGR numpy array of the combined crop.
            region: [x_offset, y_offset, width, height] within the combined crop.

        Returns:
            Numpy array view of the subregion.
        """
        x, y, w, h = region
        return frame[y : y + h, x : x + w]

    def opencv_worker(self) -> None:
        """Worker to process frames with OpenCV (runs in parallel, consumes from frame queue)"""
        self.logger.info("OpenCV worker starting...")
        metric_attrs = {
            "streamer": self.streamer or "unknown",
            "quality": self.formatted_quality,
        }

        # IGD state machine
        igd_enabled = self._igd_slice is not None
        igd_scan_active = False
        igd_frames_scanned = 0
        igd_max_scan_frames = 15  # ~30 seconds at 0.5 fps
        igd_observations: List[Tuple[int, int]] = []
        pending_detection = None  # Held detection awaiting IGD resolution

        if igd_enabled:
            self.logger.info(
                f"IGD detection enabled, will scan up to {igd_max_scan_frames} frames after each username detection"
            )

        while not self.shutdown.is_set():
            try:
                frame_data, timestamp = self.frame_queue.get(timeout=0.1)
                record_gauge("queue_depth", -1, metric_attrs)

                # If using combined crop, decode and slice subregions.
                # Otherwise pass raw JPEG bytes directly (existing behavior).
                if self._nameplate_slice is not None:
                    full_frame = self._decode_jpeg(frame_data)
                    if full_frame is None:
                        raise ValueError('Could not decode a sampled frame')
                    nameplate_frame = self._slice_subregion(
                        full_frame, self._nameplate_slice
                    )
                    nameplate_data = self._encode_jpeg(nameplate_frame)
                else:
                    full_frame = None
                    nameplate_data = frame_data

                result = self.frame_processor.process_frame(
                    nameplate_data, timestamp, self.vod_id, self.chunk_id
                )

                self.frames_processed += 1
                record_counter("frames_processed", 1, metric_attrs)

                # --- IGD scan on current frame (if active) ---
                if igd_scan_active and full_frame is not None and not (result and result.get("is_matchup")):
                    igd_frames_scanned += 1
                    # A deduplicated intro returns no new matchup, but its
                    # artwork still hides the clock. Wait for the emblem to
                    # disappear, then require three agreeing readable frames.
                    if self.frame_processor.emblem_visible:
                        igd_observations.clear()
                    else:
                        igd_crop = self._slice_subregion(full_frame, self._igd_slice)
                        igd_value = self.frame_processor.extract_igd(igd_crop)
                        if igd_value is None or (igd_observations and igd_observations[-1][0] != igd_value):
                            igd_observations.clear()
                        if igd_value is not None:
                            igd_observations.append((igd_value, timestamp))

                    if len(igd_observations) == 3:
                        pending_detection["igd"] = igd_observations[-1][0]
                        pending_detection["igd_evidence"] = {
                            "samples": len(igd_observations),
                            "first_sample_seconds": igd_observations[0][1],
                            "last_sample_seconds": igd_observations[-1][1],
                        }
                        self.logger.info(
                            f"IGD confirmed: day {pending_detection['igd']} after {igd_frames_scanned} frames for {pending_detection.get('username')}"
                        )
                        record_counter("igd_detected", 1, metric_attrs)
                        self._enqueue_detection(pending_detection, metric_attrs)
                        pending_detection = None
                        igd_scan_active = False
                    elif igd_frames_scanned >= igd_max_scan_frames:
                        self.logger.warning(
                            f"IGD scan timed out after {igd_frames_scanned} frames for {pending_detection.get('username')}"
                        )
                        record_counter("igd_timeout", 1, metric_attrs)
                        self._enqueue_detection(pending_detection, metric_attrs)
                        pending_detection = None
                        igd_scan_active = False

                # --- Handle new matchup detection ---
                if result and result.get("is_matchup") and result.get("username"):
                    if igd_enabled:
                        # If a previous IGD scan is still active, flush it
                        if igd_scan_active and pending_detection is not None:
                            self.logger.warning(
                                f"New matchup detected while IGD scan active, flushing pending detection for {pending_detection.get('username')}"
                            )
                            self._enqueue_detection(pending_detection, metric_attrs)

                        # Start IGD scan for the new detection
                        pending_detection = result
                        igd_scan_active = True
                        igd_frames_scanned = 0
                        igd_observations.clear()
                    else:
                        # No IGD — enqueue immediately (existing behavior)
                        self._enqueue_detection(result, metric_attrs)

            except queue.Empty:
                if self.frames_done.is_set() and self.frame_queue.empty():
                    break
                continue

        # Shutdown: flush any pending detection
        if igd_scan_active and pending_detection is not None:
            self.logger.info(
                f"Shutdown: flushing pending IGD detection for {pending_detection.get('username')}"
            )
            self._enqueue_detection(pending_detection, metric_attrs)


    def _enqueue_detection(
        self, result: Dict[str, Any], metric_attrs: Dict[str, str]
    ) -> None:
        """Enqueue a matchup detection to the result queue and record metrics.

        Args:
            result: Detection result dict from process_frame().
            metric_attrs: Metric attributes for telemetry.
        """
        self._put(self.result_queue, result)
        self.matchups_found += 1

        self.logger.info('matchup_detected', extra={
            'event': 'matchup_detected', 'timestamp_seconds': result.get('timestamp'),
            'username': result.get('username'), 'ocr_confidence': result.get('confidence'),
            'emblem_rank': result.get('detected_rank'), 'truncated': result.get('truncated', False),
            'igd': result.get('igd'),
        })

        # Record matchup detection
        record_counter("matchups_detected", 1, metric_attrs)

        # Record OCR confidence histogram
        if result.get("confidence"):
            record_histogram("ocr_confidence", result["confidence"], metric_attrs)

    def result_worker(self) -> None:
        """Drain all detections, including the final partial batch, before success."""
        while not self.shutdown.is_set():
            try:
                result = self.result_queue.get(timeout=0.1)
            except queue.Empty:
                if self.results_done.is_set() and self.result_queue.empty():
                    break
                continue
            self.result_batch.append(result)
            if len(self.result_batch) >= self.config['backend']['batch_size']:
                self._flush_results()
        if not self.shutdown.is_set():
            self._flush_results()

    def _flush_results(self) -> None:
        if not self.result_batch:
            return
        self.backend.upload_batch(self.result_batch)
        for result in self.result_batch:
            self.all_detections.append({
                'timestamp': result['timestamp'], 'username': result['username'],
                'confidence': result.get('confidence', 0), 'rank': result.get('detected_rank'),
                'igd': result.get('igd'),
                'igd_evidence': result.get('igd_evidence'),
            })
        self.result_batch.clear()

    def export_detection_summary(self, output_dir: str = '/app/output') -> None:
        """Export only persisted detections; reporting failure does not discard work."""
        try:
            os.makedirs(output_dir, exist_ok=True)
            with open(os.path.join(output_dir, f'detections_{self.chunk_id}.json'), 'w') as destination:
                json.dump({
                    'chunk_id': self.chunk_id, 'vod_id': self.vod_id, 'source': self.source,
                    'vod_pk': self.vod_pk, 'streamer': self.streamer,
                    'start_time': self.start_time, 'end_time': self.end_time, 'quality': self.formatted_quality,
                    'frames_processed': self.frames_processed, 'matchups_found': len(self.all_detections),
                    'decode_coverage': self.decode_coverage,
                    'detections': self.all_detections,
                }, destination, indent=2)
        except OSError:
            self.logger.exception('Could not export detection summary')

    def _stop_workers(self) -> None:
        """Stop subprocesses before waiting for blocked worker reads."""

        # Set shutdown flag
        self.shutdown.set()

        # Terminate subprocesses
        for proc_name, proc in [
            ("ffmpeg", self.ffmpeg_proc),
            ("streamlink", self.streamlink_proc),
        ]:
            if proc and proc.poll() is None:
                self.logger.info(f"Terminating {proc_name}")
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.logger.warning(f"Force killing {proc_name}")
                    proc.kill()
                    proc.wait(timeout=5)

        for thread in self.threads:
            thread.join(timeout=10)

    def cleanup(self) -> None:
        self._stop_workers()
        shutdown_telemetry()



def main() -> None:
    """Main entry point"""
    # Parse command line arguments or environment variables
    config = {
        "chunk_id": os.getenv("CHUNK_ID", sys.argv[1] if len(sys.argv) > 1 else None),
        "test_mode": os.getenv("TEST_MODE", "false").lower() == "true",
        "quality": os.getenv("QUALITY", "480p"),
        "old_templates": os.getenv("OLD_TEMPLATES", "false").lower() == "true",
        "stream_quality": os.getenv("STREAM_QUALITY"),
    }

    if not config["chunk_id"]:
        print("Usage: sfde.py <chunk_id>")
        print("Or set CHUNK_ID environment variable")
        print(
            "Optional: TEST_MODE=true/false, QUALITY=480p (or 360p,720p,1080p60), OLD_TEMPLATES=true/false"
        )
        sys.exit(1)

    # Create and run processor
    try:
        processor = SFDEProcessor(config)
        result = processor.process_vod_chunk()
        # Exit with appropriate code
        sys.exit(0 if result["status"] == "completed" else 1)
    except Exception as e:
        print(f"Failed to process chunk: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
