#!/usr/bin/env python3
"""
SFOT Processor - Main orchestrator for VOD processing pipeline
Streamlink → FFmpeg → OpenCV → Tesseract
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
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, Tuple, List, Callable
from urllib.parse import urlparse
import yaml
import numpy as np
from dotenv import load_dotenv
# skips connectivity check to the paddle OCR model hoster (models are pre-downloaded)
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
# Load environment variables
load_dotenv(".env.local")

# Import worker modules
from frame_processor import FrameProcessor
from supabase_client import SupabaseClient
from json_logger import JSONFormatter
from renditions import QUALITY_RESOLUTIONS, parse_rendition, processing_quality, select_rendition
from video import timestamped_frames
from telemetry import (
    init_telemetry, create_span, record_counter, record_histogram, record_gauge,
    extract_trace_context, set_span_attribute, add_span_event,
    shutdown_telemetry
)

# Quality configuration mapping for test mode
QUALITY_CONFIGS = {
    '360p': {'resolution': (640, 360), 'file_suffix': '360p.mp4'},
    '480p': {'resolution': (854, 480), 'file_suffix': '480p.mp4'},
    '720p': {'resolution': (1280, 720), 'file_suffix': '720p.mp4'},
    '1080p': {'resolution': (1920, 1080), 'file_suffix': '1080p.mp4'},
    '1080p60': {'resolution': (1920, 1080), 'file_suffix': '1080p.mp4'}
}

class SFOTProcessor:
    """Main SFOT processor orchestrator"""

    def __init__(self, config: Dict[str, Any]):
        """Initialize SFOT processor with configuration"""
        self.chunk_id = config['chunk_id']
        self.test_mode = config.get('test_mode', False)
        self.requested_quality = config.get('quality', '480p')
        self.quality = processing_quality(self.requested_quality)
        self.old_templates = config.get('old_templates', False)
        if self.old_templates:
            self.quality = '480p'
        self.stream_quality = config.get('stream_quality') or None
        if self.stream_quality:
            _, self.video_fps = parse_rendition(self.stream_quality)
        else:
            self.video_fps = None
        # Native rendition names are metadata, never template names or sampling rates.
        self.formatted_quality = self.stream_quality or self.quality

        # Load configuration
        self.config = self._load_config()

        # Parse SFOT profile from environment variable
        self.profile = self._parse_sfot_profile()

        # Initialize Supabase client first to fetch chunk details
        self.supabase = SupabaseClient(self.config, test_mode=self.test_mode, quality=self.quality)

        # Fetch chunk details from database
        chunk_details = self.supabase.get_chunk_details(self.chunk_id)
        if not chunk_details:
            raise ValueError(f"Could not fetch details for chunk {self.chunk_id}")

        # Set processing parameters from chunk details
        self.vod_id = chunk_details['vod_id']
        self.start_time = chunk_details['start_seconds']
        self.end_time = chunk_details['end_seconds']
        self.streamer = chunk_details.get('streamer')
        self.initial_status = chunk_details.get('status')  # Store for later use

        # Set streamer on supabase client for metric attribution
        self.supabase.set_streamer(self.streamer)

        # Initialize components
        self.frame_queue = queue.Queue(maxsize=self.config['processing']['queue_size'])
        self.result_queue = queue.Queue()
        self.shutdown = threading.Event()  # Cancellation/failure, never normal EOF.
        self.frames_done = threading.Event()
        self.results_done = threading.Event()
        self.worker_errors = queue.Queue()
        self.threads = []

        # Process state
        self.streamlink_proc: Optional[subprocess.Popen] = None
        self.ffmpeg_proc: Optional[subprocess.Popen] = None
        self.frames_processed = 0
        self.matchups_found = 0
        self.result_batch = []  # Current batch being accumulated
        self.all_detections = []  # All detections for summary export

        # Initialize frame processor with quality information and template selection
        self.frame_processor = FrameProcessor(self.config, quality=self.quality, old_templates=self.old_templates, profile=self.profile, streamer=self.streamer)

        # Setup logging
        self._setup_logging()

        # Initialize OpenTelemetry
        self._init_telemetry()

        # Register signal handlers
        signal.signal(signal.SIGTERM, self._handle_shutdown)
        signal.signal(signal.SIGINT, self._handle_shutdown)

    def percent_to_pixels(self, crop_percent: List[float], frame_width: int, frame_height: int) -> List[int]:
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
        x = math.floor(x_percent * frame_width)      # Round left down
        y = math.floor(y_percent * frame_height)     # Round top down
        w = math.ceil(w_percent * frame_width)       # Round width up
        h = math.ceil(h_percent * frame_height)      # Round height up

        # Ensure values don't exceed frame bounds
        x = min(x, frame_width - 1)
        y = min(y, frame_height - 1)
        w = min(w, frame_width - x)
        h = min(h, frame_height - y)

        # Return in FFmpeg format [width, height, x, y]
        return [w, h, x, y]

    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from YAML file"""
        config_path = os.path.join(os.path.dirname(__file__), '..', 'config.yaml')
        with open(config_path, 'r') as f:
            config = yaml.safe_load(f)

        # Override with environment variables if present
        if os.getenv('SUPABASE_URL'):
            config['supabase']['url'] = os.getenv('SUPABASE_URL')
        if os.getenv('SUPABASE_SECRET_KEY'):
            config['supabase']['secret_key'] = os.getenv('SUPABASE_SECRET_KEY')

        return config

    def _parse_sfot_profile(self) -> Dict[str, Any]:
        """Parse SFOT profile from environment variable

        Returns:
            Dictionary containing profile data with crop_region, scale, etc.

        Raises:
            ValueError: If SFOT_PROFILE is missing or invalid JSON
        """
        sfot_profile_json = os.getenv('SFOT_PROFILE')

        if not sfot_profile_json:
            raise ValueError(
                "SFOT_PROFILE environment variable is required. "
                "This should be provided by the GitHub Actions workflow as a JSON string."
            )

        try:
            profile = json.loads(sfot_profile_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"SFOT_PROFILE is not valid JSON: {e}")

        # Validate required fields
        if 'crop_region' not in profile:
            raise ValueError("SFOT_PROFILE missing required field: crop_region")

        if not isinstance(profile['crop_region'], list) or len(profile['crop_region']) != 4:
            raise ValueError(
                f"SFOT_PROFILE crop_region must be array of 4 numbers, got: {profile.get('crop_region')}"
            )

        return profile
    
    def _setup_logging(self):
        """Setup structured JSON logging"""
        self.logger = logging.getLogger('sfot')
        self.logger.setLevel(getattr(logging, self.config['logging']['level']))

        # JSON formatter
        formatter = JSONFormatter()

        # Console handler (stdout for docker logs / GitHub Actions)
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        self.logger.addHandler(console_handler)

        # Add context to all logs for Grafana/Loki queryability
        # Note: environment comes from OpenTelemetry resource attributes, not here
        self.environment = os.getenv('ENVIRONMENT', 'production')
        self.logger = logging.LoggerAdapter(self.logger, {
            'vod_id': self.vod_id,
            'chunk_id': self.chunk_id,
            'streamer': self.streamer,
            'quality': self.formatted_quality,
        })

    def _init_telemetry(self):
        """Initialize OpenTelemetry for distributed tracing and metrics"""
        # Initialize telemetry (will be no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
        telemetry_enabled = init_telemetry(
            service_name="sfot",
            environment=self.environment
        )

        if telemetry_enabled:
            self.logger.info("OpenTelemetry initialized successfully")
        else:
            self.logger.info("OpenTelemetry disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)")

        # Extract trace context if provided (propagated from GitHub Actions via process-vod edge function)
        trace_parent = os.getenv("TRACEPARENT")
        if trace_parent:
            self.trace_context = extract_trace_context({"traceparent": trace_parent})
            self.logger.info(f"Trace context extracted from TRACEPARENT: {trace_parent[:50]}...")
        else:
            self.trace_context = None

        # Common span attributes for this chunk
        self.span_attributes = {
            "vod.id": self.vod_id,
            "chunk.id": self.chunk_id,
            "streamer": self.streamer,
            "quality": self.formatted_quality,
            "profile.name": self.profile.get('profile_name', 'default'),
            "start_seconds": self.start_time,
            "end_seconds": self.end_time,
        }

    def _handle_shutdown(self, signum, frame):
        """Handle shutdown signals gracefully"""
        self.logger.info(f"Received signal {signum}, initiating shutdown")
        self.shutdown.set()
    
    def process_vod_chunk(self) -> Dict[str, Any]:
        """Main processing entry point"""
        self.logger.info(f"Starting VOD processing: {self.vod_id} [{self.start_time}-{self.end_time}]")
        self.logger.info(f"Using SFOT profile: {self.profile.get('profile_name', 'unknown')}")
        self.logger.info(f"Crop region: {self.profile['crop_region']}")
        if self.old_templates:
            self.logger.info("Using small templates (underscore-prefixed) for older VOD processing")

        # Track processing time for metrics
        processing_start_time = time.time()

        # Wrap entire processing in a root span
        with create_span("process_chunk", attributes=self.span_attributes) as root_span:
            try:
                # Verify source selection before replacing any existing chunk results.
                if not self.test_mode:
                    self._media_url = self._resolve_stream()
                # Always clean up existing detections and images when rerunning a chunk
                # This ensures clean slate whether chunk was completed, failed, or partially processed
                self.logger.info(f"Cleaning up any existing detections for chunk {self.chunk_id} (status: {self.initial_status})...")
                deleted_count = self.supabase.delete_chunk_detections(self.chunk_id)
                if deleted_count > 0:
                    self.logger.info(f"Deleted {deleted_count} existing detections and their images for clean reprocessing")
                else:
                    self.logger.info(f"No existing detections found for chunk {self.chunk_id}")

                # Update chunk status to processing with quality info
                if not self.supabase.update_chunk(
                    self.chunk_id,
                    'processing',
                    quality=self.formatted_quality
                ):
                    raise RuntimeError('Could not persist processing chunk status')

                self.threads = [
                    threading.Thread(target=self._run_worker, args=(self.ffmpeg_worker, self.frames_done), name='ffmpeg'),
                    threading.Thread(target=self._run_worker, args=(self.opencv_worker, self.results_done), name='opencv'),
                    threading.Thread(target=self._run_worker, args=(self.result_worker,), name='results'),
                ]
                for thread in self.threads:
                    thread.start()
                deadline = time.monotonic() + self.config['processing']['timeout']
                while any(thread.is_alive() for thread in self.threads):
                    if not self.worker_errors.empty():
                        raise self.worker_errors.get()
                    if self.shutdown.is_set():
                        raise RuntimeError('Chunk processing cancelled')
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Chunk processing deadline exceeded')
                    for thread in self.threads:
                        thread.join(timeout=0.05)
                if not self.worker_errors.empty():
                    raise self.worker_errors.get()
                if self.shutdown.is_set() or not self.frames_processed:
                    raise RuntimeError('Chunk produced no complete result')
                if not self.supabase.update_chunk(
                    self.chunk_id,
                    'completed',
                    frames_processed=self.frames_processed,
                    detections_count=self.matchups_found,
                    quality=self.formatted_quality
                ):
                    raise RuntimeError('Could not persist completed chunk status')
                status = 'completed'

                # Record telemetry metrics
                duration_ms = (time.time() - processing_start_time) * 1000

                # Structured JSON event for chunk completion
                # Log as JSON so Loki can parse with | json
                self.logger.info(json.dumps({
                    'event': 'chunk_finished',
                    'status': status,
                    'frames_processed': self.frames_processed,
                    'matchups_found': self.matchups_found,
                    'duration_ms': round(duration_ms, 2),
                    'fps': round(self.frames_processed / (duration_ms / 1000), 2) if duration_ms > 0 else 0,
                }))
                metric_attrs = {
                    "streamer": self.streamer or "unknown",
                    "quality": self.formatted_quality,
                }

                if status == 'completed':
                    record_counter("chunks_completed", 1, metric_attrs)
                else:
                    record_counter("chunks_failed", 1, metric_attrs)

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

                # Export detection summary for GitHub Actions workflow
                self.export_detection_summary()

                return {
                    'status': status,
                    'frames_processed': self.frames_processed,
                    'matchups_found': self.matchups_found,
                    'vod_id': self.vod_id,
                    'start_time': self.start_time,
                    'end_time': self.end_time,
                    'quality': self.quality,
                    'stream_quality': self.stream_quality,
                    'video_fps': self.video_fps,
                }

            except Exception as e:
                # Stop uploads before publishing a failed chunk state.
                self._stop_workers()
                self.logger.error(f"Processing failed: {e}", exc_info=True)
                # Record failure metric
                record_counter("chunks_failed", 1, {
                    "streamer": self.streamer or "unknown",
                    "quality": self.formatted_quality,
                    "error_type": type(e).__name__,
                })
                # Update chunk status to failed with error message
                try:
                    self.supabase.update_chunk(
                        self.chunk_id,
                        'failed',
                        error=f"Processing failed: {str(e)}",
                        quality=self.formatted_quality
                    )
                except Exception as update_error:
                    self.logger.error(f"Failed to update chunk status on error: {update_error}")
                raise
            finally:
                self.cleanup()
    
    def _run_worker(self, worker: Callable[[], None], done: Optional[threading.Event] = None) -> None:
        """Propagate worker errors and distinguish end-of-input from cancellation."""
        try:
            worker()
        except Exception as error:
            self.worker_errors.put(error)
            self.shutdown.set()
            self.logger.exception('%s failed', threading.current_thread().name)
        finally:
            if done is not None:
                done.set()

    def _put(self, destination: queue.Queue, value: Any) -> None:
        """Wait for downstream capacity without dropping frames or timestamps."""
        while not self.shutdown.is_set():
            try:
                destination.put(value, timeout=0.1)
                return
            except queue.Full:
                continue
        raise RuntimeError('Processing cancelled during queue write')

    def _resolve_stream(self) -> str:
        """Resolve a fresh exact rendition; FFmpeg owns precise VOD seeking."""
        response = subprocess.run(
            ['streamlink', '--no-config', '--json', f'https://www.twitch.tv/videos/{self.vod_id}'],
            capture_output=True, text=True, timeout=90, check=False,
        )
        if response.returncode:
            raise RuntimeError('Streamlink could not discover video renditions')
        streams = json.loads(response.stdout).get('streams', {})
        if not self.stream_quality:
            selected = select_rendition(streams, getattr(self, 'requested_quality', self.quality), self.old_templates)
            self.stream_quality = selected['stream_quality']
        if self.stream_quality not in streams:
            raise ValueError('The selected video rendition is no longer available')
        _, self.video_fps = parse_rendition(self.stream_quality)
        stream = streams[self.stream_quality]
        url = stream.get('url', '')
        parsed = urlparse(url)
        if stream.get('type') not in ('hls', 'http') or parsed.scheme not in ('https', 'http') or not parsed.hostname:
            raise ValueError('Selected rendition must be HTTP video media')
        headers = []
        for key, value in (stream.get('headers') or {}).items():
            if key.lower() in ('user-agent', 'referer', 'origin'):
                if not isinstance(value, str) or '\n' in value or '\r' in value:
                    raise ValueError('Invalid playback header')
                headers.append(f'{key}: {value}\r\n')
        self._media_input_args = ['-headers', ''.join(headers)] if headers else []
        self.formatted_quality = self.stream_quality
        self.logger.info('Selected source %s; processing geometry %s', self.stream_quality, self.quality)
        return url

    def ffmpeg_worker(self) -> None:
        """Normalize geometry, seek accurately, and enqueue every sampled frame."""
        cmd = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'info']
        if self.test_mode:
            directory = self.config.get('test_mode', {}).get('data_directory', 'test_data')
            input_file = os.getenv('TEST_VIDEO') or os.path.join('/app', directory, self.vod_id, f'{self.quality}.mp4')
            if not os.path.isfile(input_file):
                raise FileNotFoundError('Test video is missing')
            cmd += ['-ss', str(self.start_time), '-i', input_file]
        else:
            url = getattr(self, '_media_url', None) or self._resolve_stream()
            cmd += getattr(self, '_media_input_args', [])
            cmd += ['-rw_timeout', '30000000', '-ss', str(self.start_time), '-i', url]
        width, height = QUALITY_RESOLUTIONS[self.quality]
        w, h, x, y = self.percent_to_pixels(self.profile['crop_region'], width, height)
        filters = (
            f'scale={width}:{height},fps={self.config["processing"]["frame_rate"]},'
            f'crop={w}:{h}:{x}:{y}:exact=1,showinfo'
        )
        cmd += [
            '-t', str(self.end_time - self.start_time), '-an', '-vf', filters,
            '-fps_mode', 'passthrough', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ]
        self.ffmpeg_proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for pixels, pts in timestamped_frames(self.ffmpeg_proc.stdout, self.ffmpeg_proc.stderr, self.logger):
            timestamp = self.start_time + int(pts)
            if self.start_time <= timestamp < self.end_time:
                self._put(self.frame_queue, (pixels, timestamp))
        try:
            return_code = self.ffmpeg_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            raise RuntimeError('FFmpeg did not finish after decoding') from None
        if return_code:
            raise RuntimeError('FFmpeg failed to decode the complete chunk')

    def opencv_worker(self) -> None:
        """Consume all decoded frames before signalling that results are complete."""
        metric_attrs = {'streamer': self.streamer or 'unknown', 'quality': self.formatted_quality}
        while not self.shutdown.is_set():
            try:
                frame_data, timestamp = self.frame_queue.get(timeout=0.1)
            except queue.Empty:
                if self.frames_done.is_set() and self.frame_queue.empty():
                    return
                continue
            result = self.frame_processor.process_frame(frame_data, timestamp, self.vod_id, self.chunk_id)
            self.frames_processed += 1
            record_counter('frames_processed', 1, metric_attrs)
            if result and result.get('is_matchup'):
                self._put(self.result_queue, result)
                self.matchups_found += 1
                self.logger.info(json.dumps({
                    'event': 'matchup_detected', 'timestamp_seconds': timestamp,
                    'username': result.get('username'), 'ocr_confidence': result.get('confidence'),
                    'emblem_rank': result.get('detected_rank'), 'truncated': result.get('truncated', False),
                }))
                record_counter('matchups_detected', 1, metric_attrs)
                if result.get('confidence'):
                    record_histogram('ocr_confidence', result['confidence'], metric_attrs)

    def result_worker(self) -> None:
        """Persist every result, including the final partial batch, before success."""
        while not self.shutdown.is_set():
            try:
                result = self.result_queue.get(timeout=0.1)
            except queue.Empty:
                if self.results_done.is_set() and self.result_queue.empty():
                    break
                continue
            self.result_batch.append(result)
            if len(self.result_batch) >= self.config['supabase']['batch_size']:
                self._flush_results()
        if not self.shutdown.is_set():
            self._flush_results()

    def _flush_results(self) -> None:
        """Only count persisted detections in the exported summary."""
        if not self.result_batch:
            return
        if not self.supabase.upload_batch(self.result_batch):
            raise RuntimeError('Detection batch could not be persisted')
        for result in self.result_batch:
            self.all_detections.append({
                'timestamp': result['timestamp'], 'username': result['username'],
                'confidence': result.get('confidence', 0), 'rank': result.get('detected_rank'),
                'frame_base64': result.get('frame_base64'),
            })
        self.result_batch = []

    def export_detection_summary(self, output_dir: str = "/app/output"):
        """Export detection summary for GitHub Actions workflow summary

        Args:
            output_dir: Directory to write the summary JSON file
        """
        try:
            self.logger.info(f"Exporting detection summary for chunk {self.chunk_id}")
            self.logger.info(f"Total detections tracked: {len(self.all_detections)}")

            # Prepare summary
            summary = {
                'chunk_id': self.chunk_id,
                'vod_id': self.vod_id,
                'streamer': self.streamer,
                'start_time': self.start_time,
                'end_time': self.end_time,
                'quality': self.formatted_quality,
                'processing_quality': self.quality,
                'stream_quality': self.stream_quality,
                'video_fps': self.video_fps,
                'frames_processed': self.frames_processed,
                'matchups_found': self.matchups_found,
                'detections': []
            }

            # Add ALL detection details (images are in Supabase storage)
            for detection in self.all_detections:
                summary['detections'].append({
                    'timestamp': detection['timestamp'],
                    'username': detection['username'],
                    'confidence': detection['confidence'],
                    'rank': detection['rank']
                })

            # Ensure output directory exists and is writable
            try:
                os.makedirs(output_dir, exist_ok=True)
                self.logger.info(f"Output directory ready: {output_dir}")
            except Exception as mkdir_err:
                self.logger.error(f"Failed to create output directory: {mkdir_err}")
                raise

            # Write to output directory with unique filename per chunk
            output_path = os.path.join(output_dir, f"detections_{self.chunk_id}.json")
            self.logger.info(f"Writing summary to: {output_path}")

            with open(output_path, 'w') as f:
                json.dump(summary, f, indent=2)

            # Verify file was written
            if os.path.exists(output_path):
                file_size = os.path.getsize(output_path)
                self.logger.info(f"Successfully exported detection summary ({file_size} bytes)")
            else:
                self.logger.error(f"File was not created: {output_path}")

        except Exception as e:
            self.logger.error(f"Failed to export detection summary: {e}", exc_info=True)

    def _stop_workers(self) -> None:
        """Cancel workers and stop subprocesses before publishing failure."""

        # Set shutdown flag
        self.shutdown.set()

        # Terminate subprocesses
        for proc_name, proc in [('ffmpeg', self.ffmpeg_proc), ('streamlink', self.streamlink_proc)]:
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
            if thread is not threading.current_thread():
                thread.join(timeout=10)

        # Clear queues
        while not self.frame_queue.empty():
            try:
                self.frame_queue.get_nowait()
            except queue.Empty:
                break

    def cleanup(self) -> None:
        """Stop workers, then flush telemetry after final chunk status is known."""
        self._stop_workers()
        self.logger.info("Flushing telemetry...")
        shutdown_telemetry()

        self.logger.info("Cleanup completed")


def main():
    """Main entry point"""
    # Parse command line arguments or environment variables
    config = {
        'chunk_id': os.getenv('CHUNK_ID', sys.argv[1] if len(sys.argv) > 1 else None),
        'test_mode': os.getenv('TEST_MODE', 'false').lower() == 'true',
        'quality': os.getenv('QUALITY', '480p'),  # Processing/template geometry
        'stream_quality': os.getenv('STREAM_QUALITY'),  # Exact native rendition
        'old_templates': os.getenv('OLD_TEMPLATES', 'false').lower() == 'true',
    }

    if not config['chunk_id']:
        print("Usage: sfot.py <chunk_id>")
        print("Or set CHUNK_ID environment variable")
        print("Optional: TEST_MODE=true/false, QUALITY=480p (or 480p,360p,1080p60), OLD_TEMPLATES=true/false")
        sys.exit(1)

    # Create and run processor
    try:
        processor = SFOTProcessor(config)
        result = processor.process_vod_chunk()
        # Exit with appropriate code
        sys.exit(0 if result['status'] == 'completed' else 1)
    except Exception as e:
        print(f"Failed to process chunk: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
