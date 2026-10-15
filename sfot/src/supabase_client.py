"""
Supabase client module - Handles all Supabase interactions
"""

import os
import time
import logging
from typing import List, Dict, Any, Optional
from supabase import create_client, Client
from supabase.client import ClientOptions
import requests
from datetime import datetime, timedelta
from telemetry import create_span, record_histogram, record_counter

class SupabaseClient:
    """Handle Supabase operations for SFOT processor"""

    def __init__(self, config: Dict[str, Any], test_mode: bool = False, quality: str = '480p', streamer: str = None):
        """Initialize Supabase client with optional test mode and quality"""
        self.config = config
        self.logger = logging.getLogger('sfot.supabase')
        self.test_mode = test_mode
        self.quality = quality
        self.schema = 'test' if test_mode else 'public'
        self.streamer = streamer  # Set later via set_streamer() after chunk details are fetched

        # Get credentials from environment
        url = os.getenv('SUPABASE_URL', config.get('supabase', {}).get('url'))
        key = os.getenv('SUPABASE_SECRET_KEY', config.get('supabase', {}).get('secret_key'))

        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")

        # Initialize client with schema option if in test mode
        if test_mode:
            # Create client with test schema
            options = ClientOptions(schema='test')
            self.client: Client = create_client(url, key, options)
        else:
            # Create client with default public schema
            self.client: Client = create_client(url, key)
        self.storage_bucket = config['supabase']['storage_bucket']

        # Batch processing settings
        self.batch_size = config['supabase']['batch_size']
        self.retry_attempts = config['supabase']['retry_attempts']

        self.logger.info(f"Supabase client initialized (schema: {self.schema})")

    def set_streamer(self, streamer: str):
        """Set the streamer name for metric attribution"""
        self.streamer = streamer

    def get_chunk_details(self, chunk_id: str) -> Optional[Dict[str, Any]]:
        """Get chunk details with VOD and streamer information"""
        try:
            # Fetch chunk with joined VOD and streamer data
            response = self.client.table('chunks')\
                .select('*, vods(source_id, streamer_id, streamers(login))')\
                .eq('id', chunk_id)\
                .single()\
                .execute()

            if response and response.data:
                chunk_data = response.data
                self.logger.info(f"Retrieved chunk details for {chunk_id}")

                # Flatten the response structure for easier access
                result = {
                    'id': chunk_data['id'],
                    'start_seconds': chunk_data['start_seconds'],
                    'end_seconds': chunk_data['end_seconds'],
                    'status': chunk_data.get('status'),
                    'vod_id': chunk_data['vods']['source_id'] if chunk_data.get('vods') else None,
                    'streamer': chunk_data['vods']['streamers']['login'] if chunk_data.get('vods') and chunk_data['vods'].get('streamers') else None
                }
                return result
            else:
                self.logger.error(f"No chunk found with ID {chunk_id}")
                return None

        except Exception as e:
            self.logger.error(f"Failed to get chunk details: {e}")
            return None

    def update_chunk(self, chunk_id: str, status: str, **kwargs):
        """Update chunk status"""
        try:
            data = {
                'status': status,
                'updated_at': datetime.utcnow().isoformat()
            }

            # Add optional fields
            if 'error' in kwargs:
                data['last_error'] = kwargs['error']
            if 'frames_processed' in kwargs:
                data['frames_processed'] = kwargs['frames_processed']
            if 'detections_count' in kwargs:
                data['detections_count'] = kwargs['detections_count']
            if 'quality' in kwargs:
                data['quality'] = kwargs['quality']
            if status == 'completed':
                data['completed_at'] = datetime.utcnow().isoformat()
            elif status == 'processing':
                data['started_at'] = datetime.utcnow().isoformat()
                # Reset attempt count on processing start
                data['attempt_count'] = 1
            elif status == 'pending':
                # Increment attempt count on failure
                # First get current attempt count
                current_chunk = self.client.table('chunks')\
                    .select('attempt_count')\
                    .eq('id', chunk_id)\
                    .single()\
                    .execute()

                if current_chunk and current_chunk.data:
                    data['attempt_count'] = (current_chunk.data.get('attempt_count', 0) or 0) + 1

            # Update chunk
            response = self.client.table('chunks').update(data).eq('id', chunk_id).execute()

            self.logger.info(f"Updated chunk {chunk_id} to {status}")
            return response

        except Exception as e:
            self.logger.error(f"Failed to update chunk: {e}")
            return None
    
    def update_chunk_progress(self, chunk_id: str, frames_processed: int, detections_count: int):
        """Update chunk progress metrics"""
        try:
            data = {
                'frames_processed': frames_processed,
                'detections_count': detections_count,
                'updated_at': datetime.utcnow().isoformat()
            }

            response = self.client.table('chunks').update(data).eq('id', chunk_id).execute()
            return response
            
        except Exception as e:
            self.logger.error(f"Failed to update chunk progress: {e}")
            return None
    
    def upload_batch(self, matchups: List[Dict[str, Any]]):
        """Upload batch of detection results"""
        start_time_ms = time.time() * 1000
        metric_attrs = {"streamer": self.streamer or "unknown", "quality": self.quality}

        with create_span("supabase_upload", attributes={"batch.size": len(matchups)}) as span:
            for attempt in range(self.retry_attempts):
                try:
                    # Prepare batch data
                    batch_data = []
                    image_uploads = []
                    text_logs = []

                    # Cache for VOD ID lookups
                    vod_id_cache = {}

                    for matchup in matchups:
                        # Look up the actual database vod_id from source_id if not cached
                        source_id = str(matchup['vod_id'])
                        if source_id not in vod_id_cache:
                            try:
                                vod_response = self.client.table('vods').select('id').eq('source_id', source_id).single().execute()
                                vod_id_cache[source_id] = vod_response.data['id']
                            except Exception as e:
                                self.logger.error(f"Failed to find VOD with source_id {source_id}: {e}")
                                # Retry the whole batch; skipping this row would
                                # silently report success with missing detections.
                                raise

                        actual_vod_id = vod_id_cache[source_id]

                        # Create detection record if username was extracted
                        if matchup.get('username'):
                            # Generate storage path for the detection image
                            if self.test_mode:
                                storage_path = f"/detections/test/{self.quality}/{source_id}/{matchup['timestamp']}.jpg" if 'frame_base64' in matchup else None
                            else:
                                storage_path = f"/detections/{source_id}/{matchup['timestamp']}.jpg" if 'frame_base64' in matchup else None

                            record = {
                                'vod_id': actual_vod_id,  # Use the database ID
                                'frame_time_seconds': matchup['timestamp'],
                                'username': matchup['username'],
                                'confidence': matchup.get('confidence', 0),
                                'rank': matchup.get('detected_rank'),
                                'chunk_id': matchup.get('chunk_id'),
                                'storage_path': storage_path,
                                'no_right_edge': matchup.get('no_right_edge', False),
                                'truncated': matchup.get('truncated', False),  # Track if custom edge was used
                            }
                            batch_data.append(record)

                            # Queue image uploads ONLY if we have a valid detection record
                            # This prevents storing frames for false positives with empty usernames

                            # Upload detection frame
                            if 'frame_base64' in matchup:
                                image_uploads.append({
                                    'vod_id': matchup['vod_id'],
                                    'timestamp': matchup['timestamp'],
                                    'data': matchup['frame_base64'],
                                    'type': 'detection'
                                })

                            # Upload OCR debug frame
                            if 'ocr_debug_frame' in matchup:
                                image_uploads.append({
                                    'vod_id': matchup['vod_id'],
                                    'timestamp': matchup['timestamp'],
                                    'data': matchup['ocr_debug_frame'],
                                    'type': 'ocr_debug'
                                })

                            # Upload emblem bounding box frame
                            if 'emblem_boxes_frame' in matchup:
                                image_uploads.append({
                                    'vod_id': matchup['vod_id'],
                                    'timestamp': matchup['timestamp'],
                                    'data': matchup['emblem_boxes_frame'],
                                    'type': 'emblem_boxes'
                                })

                            # Upload OCR text log
                            if 'ocr_log_text' in matchup:
                                text_logs.append({
                                    'timestamp': matchup['timestamp'],
                                    'data': matchup['ocr_log_text']
                                })
                        else:
                            # No valid username - skip this match entirely
                            self.logger.debug(f"Skipping matchup at {matchup['timestamp']}: no valid username extracted")

                    # Insert detection records
                    if batch_data:
                        response = self.client.table('detections').insert(batch_data).execute()
                        self.logger.info(f"Uploaded {len(batch_data)} detections to {self.schema} schema")
                        record_counter("detections_uploaded", len(batch_data), metric_attrs)

                    # Upload images to storage
                    for img in image_uploads:
                        self._upload_image(img['vod_id'], img['timestamp'], img['data'], img.get('type', 'detection'))

                    # Upload text logs to logs bucket
                    for log in text_logs:
                        self._upload_text_log(log['timestamp'], log['data'])

                    # Record upload duration on success
                    duration_ms = time.time() * 1000 - start_time_ms
                    record_histogram("upload_duration", duration_ms, metric_attrs)
                    if span:
                        span.set_attribute("duration.ms", duration_ms)
                        span.set_attribute("detections.count", len(batch_data))
                        span.set_attribute("images.count", len(image_uploads))

                    return True

                except Exception as e:
                    self.logger.error(f"Batch upload attempt {attempt + 1} failed: {e}")
                    if attempt < self.retry_attempts - 1:
                        time.sleep(2 ** attempt)  # Exponential backoff
                    else:
                        record_counter("errors", 1, {**metric_attrs, "component": "supabase", "error_type": type(e).__name__})
                        raise
    
    def _upload_image(self, vod_id: str, timestamp: int, base64_data: str, image_type: str = 'detection'):
        """Upload matchup screenshot to storage"""
        try:
            # Generate filename based on type and test mode
            if self.test_mode:
                if image_type == 'detection':
                    filename = f"test/{self.quality}/{vod_id}/{timestamp}.jpg"
                elif image_type == 'ocr_debug':
                    # OCR preprocessed frames go in ocr_debug folder
                    filename = f"test/{self.quality}/{vod_id}/ocr_debug/preprocessed_{timestamp}.jpg"
                elif image_type == 'emblem_boxes':
                    # Emblem bounding box frames go in ocr_debug folder (test mode only)
                    filename = f"test/{self.quality}/{vod_id}/ocr_debug/boxes_{timestamp}.jpg"
                else:
                    # Fallback for any other debug type
                    filename = f"test/{self.quality}/{vod_id}/ocr_debug/{image_type}_{timestamp}.jpg"
            else:
                if image_type == 'detection':
                    filename = f"{vod_id}/{timestamp}.jpg"
                else:
                    # For OCR debug frames in production (keep existing behavior)
                    filename = f"{vod_id}/{image_type}_{timestamp}.jpg"
            
            # Decode base64
            import base64
            image_data = base64.b64decode(base64_data)
            
            # Upload to storage
            response = self.client.storage.from_(self.storage_bucket).upload(
                path=filename,
                file=image_data,
                file_options={"content-type": "image/jpeg", "upsert": "true"}
            )
            
            self.logger.debug(f"Uploaded image: {filename}")
            return response

        except Exception as e:
            self.logger.error(f"Image upload failed: {e}")
            return None

    def _upload_text_log(self, timestamp: int, text_data: str):
        """Upload text log to logs bucket"""
        try:
            # Generate filename for logs bucket
            filename = f"ocr_data/{timestamp}.txt"

            # Convert text to bytes
            text_bytes = text_data.encode('utf-8')

            # Upload to logs bucket
            response = self.client.storage.from_('logs').upload(
                path=filename,
                file=text_bytes,
                file_options={"content-type": "text/plain; charset=utf-8", "upsert": "true"}
            )

            self.logger.debug(f"Uploaded text log: {filename}")
            return response

        except Exception as e:
            self.logger.error(f"Text log upload failed: {e}")
            return None

    def get_pending_chunks(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get pending chunks for processing"""
        try:
            response = self.client.table('chunks')\
                .select('*')\
                .eq('status', 'pending')\
                .order('priority', desc=True)\
                .order('scheduled_for')\
                .limit(limit)\
                .execute()

            return response.data if response else []

        except Exception as e:
            self.logger.error(f"Failed to get pending chunks: {e}")
            return []

    def delete_chunk_detections(self, chunk_id: str) -> int:
        """Delete all detections and associated images for a chunk

        Returns:
            Number of detections deleted
        """
        try:
            # First, get all detections for this chunk to identify storage paths
            detections_response = self.client.table('detections')\
                .select('id, storage_path')\
                .eq('chunk_id', chunk_id)\
                .execute()

            if not detections_response.data:
                self.logger.info(f"No existing detections found for chunk {chunk_id}")
                return 0

            detections = detections_response.data
            self.logger.info(f"Found {len(detections)} existing detections for chunk {chunk_id}, deleting...")

            # Delete images from storage
            for detection in detections:
                if detection.get('storage_path'):
                    try:
                        # Remove leading slash if present
                        storage_path = detection['storage_path'].lstrip('/')
                        # Delete from storage bucket
                        self.client.storage.from_(self.storage_bucket).remove([storage_path])
                        self.logger.debug(f"Deleted image: {storage_path}")
                    except Exception as e:
                        self.logger.warning(f"Failed to delete image {detection['storage_path']}: {e}")

            # Delete detection records from database
            delete_response = self.client.table('detections')\
                .delete()\
                .eq('chunk_id', chunk_id)\
                .execute()

            deleted_count = len(detections)
            self.logger.info(f"Deleted {deleted_count} detections for chunk {chunk_id}")
            return deleted_count

        except Exception as e:
            self.logger.error(f"Failed to delete chunk detections: {e}")
            return 0

    def claim_chunk(self, chunk_id: str, worker_id: str) -> bool:
        """Claim a chunk for processing"""
        try:
            # Atomic update to claim chunk
            response = self.client.table('chunks')\
                .update({
                    'status': 'processing',
                    'worker_id': worker_id,
                    'started_at': datetime.utcnow().isoformat(),
                    'lease_expires_at': (datetime.utcnow() + timedelta(minutes=30)).isoformat()
                })\
                .eq('id', chunk_id)\
                .eq('status', 'pending')\
                .execute()

            # Check if update was successful
            if response.data and len(response.data) > 0:
                self.logger.info(f"Claimed chunk {chunk_id}")
                return True
            return False

        except Exception as e:
            self.logger.error(f"Failed to claim chunk: {e}")
            return False

    def upload_logs(self, filename: str, log_contents: str) -> bool:
        """Upload log file to the logs storage bucket

        Args:
            filename: The filename to save the logs as (e.g., "test/360p/chunk_id_timestamp.jsonl")
            log_contents: The log contents as a string

        Returns:
            True if upload successful, False otherwise
        """
        try:
            # Convert string to bytes
            log_data = log_contents.encode('utf-8')

            # Upload to logs bucket
            response = self.client.storage.from_('logs').upload(
                path=filename,
                file=log_data,
                file_options={"content-type": "application/x-ndjson", "upsert": "true"}  # JSONL content type
            )

            self.logger.info(f"Successfully uploaded logs to: {filename}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to upload logs: {e}")
            return False
