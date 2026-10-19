"""
Frame processor module - Handles OpenCV detection and PaddleOCR
"""

import math
from numbers import Real
from pathlib import Path
import re
import cv2
import numpy as np
from typing import Optional, Dict, Any, Tuple
import logging
import base64
from emblem_detector import EmblemDetector
from right_edge_detector import RightEdgeDetector
from telemetry import create_span, record_histogram, record_counter


class FrameProcessor:
    """Process frames for matchup detection and OCR"""

    def __init__(
        self,
        config: Dict[str, Any],
        quality: str = "480p",
        old_templates: bool = False,
        profile: Optional[Dict[str, Any]] = None,
        streamer: Optional[str] = None,
    ):
        """Initialize frame processor with configuration

        Args:
            config: Configuration dictionary
            quality: Video quality being processed (360p, 480p, 720p, 1080p)
            old_templates: Whether to use underscore-prefixed templates for older VODs
            profile: SFDE profile containing custom_edge and opaque_edge settings
            streamer: Streamer login name for metric labeling
        """
        self.config = config
        self.quality = quality
        self.old_templates = old_templates
        self.streamer = streamer or "unknown"
        self.logger = logging.getLogger("sfde.frame_processor")

        # Store profile settings for custom edge detection
        self.profile = profile or {}
        # Convert custom_edge to float if present (it may come as string from JSON)
        custom_edge_value = self.profile.get("custom_edge")
        self.custom_edge_percent = (
            float(custom_edge_value) if custom_edge_value is not None else None
        )
        self.opaque_edge = self.profile.get(
            "opaque_edge", False
        )  # Default False for backward compatibility

        # Log custom edge settings if present
        if self.custom_edge_percent is not None:
            self.logger.info(
                f"Custom edge configured: {self.custom_edge_percent * 100:.1f}% of crop width, opaque={self.opaque_edge}"
            )

        # Map quality to resolution for templates
        template_resolution = quality.removesuffix('60')
        if template_resolution not in ('360p', '480p', '720p', '1080p'):
            raise ValueError(f'Unsupported template quality: {quality}')

        # Initialize emblem detector
        self.emblem_detector = None
        if config.get("emblem_detection", {}).get("enabled", False):
            try:
                emblem_config = config["emblem_detection"]
                templates_dir = emblem_config.get("templates_dir", "templates/")
                template_method = emblem_config.get(
                    "template_method", "TM_CCOEFF_NORMED"
                )
                self.emblem_threshold = emblem_config.get("template_threshold", 0.5)

                if not Path(templates_dir).is_absolute():
                    templates_dir = str(Path(__file__).resolve().parent.parent / templates_dir)
                self.emblem_detector = EmblemDetector(
                    templates_dir,
                    resolution=template_resolution,
                    old_templates=self.old_templates,
                    template_method=template_method,
                )

                self.logger.info(
                    f"Initialized emblem detector with {template_resolution} templates (threshold={self.emblem_threshold})"
                )

                # Log template dimensions for debugging
                if hasattr(self.emblem_detector, "templates"):
                    for rank, template in self.emblem_detector.templates.items():
                        if template is not None:
                            h, w = template.shape[:2]
                            self.logger.info(
                                f"Template '{rank}' dimensions: {w}x{h} pixels ({template_resolution})"
                            )

            except Exception as e:
                raise ValueError(f"Could not initialize emblem detector: {e}") from e

        # Initialize right edge detector
        self.right_edge_detector = None
        self.right_edge_crop_margin = 0.0
        if config.get("right_edge_detection", {}).get("enabled", True):
            try:
                templates_dir = config.get("right_edge_detection", {}).get(
                    "templates_dir",
                    config.get("emblem_detection", {}).get(
                        "templates_dir", "templates/"
                    ),
                )
                if not Path(templates_dir).is_absolute():
                    templates_dir = str(Path(__file__).resolve().parent.parent / templates_dir)
                self.right_edge_detector = RightEdgeDetector(
                    templates_dir, resolution=template_resolution
                )
                self.right_edge_threshold = config.get("right_edge_detection", {}).get(
                    "threshold", 0.7
                )
                # Crop margin: crop this % more to avoid edge artifacts (e.g., 10% = crop at x=90 if edge at x=100)
                self.right_edge_crop_margin = (
                    config.get("right_edge_detection", {}).get(
                        "crop_margin_percent", 10
                    )
                    / 100.0
                )
                self.logger.info(
                    f"Initialized right edge detector with {template_resolution} template (crop margin: {self.right_edge_crop_margin * 100:.0f}%)"
                )
            except Exception as e:
                raise ValueError(f"Could not initialize right edge detector: {e}") from e

        # Initialize PaddleOCR with mobile models (smallest footprint)
        self.ocr_confidence_threshold = config.get('ocr', {}).get('confidence_threshold', 0.5)
        try:
            from paddleocr import PaddleOCR

            self.reader = PaddleOCR(
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="en_PP-OCRv5_mobile_rec",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                # Paddle 3.3's oneDNN executor cannot run these mobile model graphs.
                enable_mkldnn=False,
                text_rec_score_thresh=self.ocr_confidence_threshold,
            )
            self.logger.info("Initialized PaddleOCR (mobile models)")
        except Exception as e:
            self.logger.error(f"Failed to initialize PaddleOCR: {e}")
            raise

        self.reset_state()
        self.min_matchup_interval = config.get('ocr', {}).get('min_matchup_interval', 10)

    def reset_state(self) -> None:
        """Forget matchup deduplication and scene evidence before a fresh decode."""
        self.last_matchup_time = None
        self.matchup_active = False
        # Current-frame scene evidence is separate from saved-matchup deduplication.
        self.emblem_visible = False

    def process_frame(
        self, frame_data: bytes, timestamp: int, vod_id: str, chunk_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Process a single frame for matchup detection

        Args:
            frame_data: JPEG frame data
            timestamp: Timestamp in seconds
            vod_id: VOD identifier
            chunk_id: Chunk uuid

        Returns:
            Detection result or None
        """
        try:
            # Decode frame
            frame = self._decode_frame(frame_data)
            if frame is None:
                raise ValueError('Could not decode sampled JPEG')

            # Emblem detection first (5 template scans)
            detected_rank, emblem_bbox, emblem_confidence = self._detect_emblem(frame)
            self.emblem_visible = detected_rank is not None

            if detected_rank is None:
                self.matchup_active = False
                # No emblem found, no matchup
                record_counter(
                    "emblem_not_found",
                    1,
                    {"streamer": self.streamer, "quality": self.quality},
                )
                return None

            # Reject if bbox is None (detection without valid bounding box)
            if emblem_bbox is None:
                self.logger.info(
                    f"Rejecting detection at {timestamp}s: emblem detected but bbox is None"
                )
                return None

            if getattr(self, "matchup_active", False):
                return None

            # Check minimum interval
            if self.last_matchup_time is not None and timestamp - self.last_matchup_time < self.min_matchup_interval:
                return None

            # Calculate emblem right boundary for cropping (needed for multi-crop OCR)
            emblem_right_x = None
            if emblem_bbox:
                x, y, w, h = emblem_bbox
                emblem_right_x = min(frame.shape[1], x + w)  # Use exact bbox width

            # Right edge detection with custom edge support
            right_edge_x = None
            no_right_edge = False
            truncated = False  # Track if custom edge was used

            if self.opaque_edge and self.custom_edge_percent is not None:
                # Case 1: opaque_edge=true - always use custom_edge, skip detection entirely
                # Calculate custom edge position based on frame width
                right_edge_x = int(frame.shape[1] * self.custom_edge_percent)
                truncated = True
                self.logger.info(
                    f"Using custom edge (opaque mode) at {right_edge_x}px ({self.custom_edge_percent * 100:.1f}% of frame width)"
                )

            elif self.right_edge_detector:
                # Case 2: Try right edge detection
                right_edge_x, right_conf = self.right_edge_detector.detect_right_edge(
                    frame, self.right_edge_threshold
                )

                if right_edge_x is None:
                    # No right edge detected
                    no_right_edge = True

                    # Case 3: Fall back to custom_edge if configured
                    if self.custom_edge_percent is not None:
                        right_edge_x = int(frame.shape[1] * self.custom_edge_percent)
                        truncated = True
                        self.logger.info(
                            f"No right edge detected at {timestamp}s, using custom_edge at {right_edge_x}px"
                        )
                    else:
                        # No custom_edge configured
                        self.logger.info(
                            f"No right edge detected (conf: {right_conf:.3f}) - "
                            f"possible streamer cam occlusion"
                        )
                        record_counter(
                            "right_edge_failed",
                            1,
                            {"streamer": self.streamer, "quality": self.quality},
                        )
                else:
                    self.logger.debug(
                        f"Right edge detected at {timestamp}s, x={right_edge_x} (conf: {right_conf:.3f})"
                    )
                    # Record right edge confidence metric
                    record_histogram(
                        "right_edge_confidence",
                        right_conf,
                        {"streamer": self.streamer, "quality": self.quality},
                    )

            # Remove emblem from frame for better OCR
            cropped_frame = self._crop(frame, emblem_bbox, right_edge_x, truncated)
            if cropped_frame.size == 0:
                return None

            # Extract username via OCR using BGR frame (PaddleOCR expects 3-channel images)
            # PaddleOCR will handle any necessary preprocessing internally
            username, ocr_confidence, ocr_data = self._extract_usernames(cropped_frame)
            if not username or not math.isfinite(ocr_confidence) or ocr_confidence < self.ocr_confidence_threshold:
                return None
            self.last_matchup_time = timestamp
            self.matchup_active = True

            # Encode the original frame (already cropped by FFmpeg)
            success, encoded = cv2.imencode(
                ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85]
            )
            if not success:
                raise RuntimeError('Could not encode detection screenshot')
            frame_jpeg = encoded.tobytes()

            # Create OCR debug visualization (always on matchup frames)
            debug_jpeg = None
            if ocr_data is not None:
                # Generate OCR visualization with bounding boxes on cropped BGR frame
                debug_jpeg = self._create_ocr_visualization(cropped_frame, ocr_data)

            # Draw the coordinates already used for OCR; do not run detection again.
            boxes_vis = frame.copy()
            x, y, w, h = emblem_bbox
            cv2.rectangle(boxes_vis, (x, y), (x + w, y + h), (0, 255, 0), 1)
            if right_edge_x is not None:
                cv2.line(boxes_vis, (right_edge_x, 0), (right_edge_x, frame.shape[0]), (255, 255, 0), 1)
            success_boxes, encoded_boxes = cv2.imencode('.jpg', boxes_vis)
            boxes_jpeg = encoded_boxes.tobytes() if success_boxes else None

            # Prepare result
            result = {
                "vod_id": vod_id,
                "timestamp": timestamp,
                "is_matchup": True,
                "confidence": ocr_confidence,
                "username": username,
                "detected_rank": detected_rank,
                "chunk_id": chunk_id,
                "emblem_right_x": emblem_right_x,
                "right_edge_x": right_edge_x,
                "no_right_edge": no_right_edge,
                "truncated": truncated,
                "frame_base64": base64.b64encode(frame_jpeg).decode("utf-8")
                if frame_jpeg
                else None,
                "ocr_debug_frame": base64.b64encode(debug_jpeg).decode("utf-8")
                if debug_jpeg
                else None,
            }

            # Add bounding box frame if created
            if boxes_jpeg:
                result["emblem_boxes_frame"] = base64.b64encode(boxes_jpeg).decode(
                    "utf-8"
                )

            self.logger.debug(f"Detected matchup at {timestamp}s: {username}")
            return result

        except Exception as e:
            self.logger.error(f'Frame processing error: {e}')
            raise

    def extract_igd(self, igd_frame: np.ndarray) -> Optional[int]:
        """Extract in-game day number (1-20) from the IGD crop region.

        Args:
            igd_frame: BGR numpy array of the IGD region.

        Returns:
            Day number (1-20) or None.
        """
        try:
            # Upscale
            h, w = igd_frame.shape[:2]
            scale = max(200 / h, 200 / w, 4.0)
            upscaled = cv2.resize(
                igd_frame,
                (int(w * scale), int(h * scale)),
                interpolation=cv2.INTER_LINEAR,
            )

            # Binary threshold
            gray = cv2.cvtColor(upscaled, cv2.COLOR_BGR2GRAY)
            _, binary = cv2.threshold(gray, 65, 255, cv2.THRESH_BINARY)
            ocr_input = cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)

            # Pad for text detector border requirements
            pad = 50
            padded = cv2.copyMakeBorder(
                ocr_input,
                pad,
                pad,
                pad,
                pad,
                cv2.BORDER_CONSTANT,
                value=(0, 0, 0),
            )

            # OCR with low detection thresholds
            results = self.reader.predict(
                padded,
                text_det_thresh=0.1,
                text_det_box_thresh=0.1,
            )

            if not results or len(results) != 1:
                return None
            rec_texts = results[0].get("rec_texts", [])
            rec_scores = results[0].get("rec_scores", [])
            if len(rec_texts) != len(rec_scores):
                return None
            qualifying = []
            for text, score in zip(rec_texts, rec_scores):
                if (not isinstance(text, str) or not isinstance(score, Real)
                        or isinstance(score, bool) or not math.isfinite(score)):
                    return None
                if score >= 0.9:
                    qualifying.append(text.strip())
            # A clock is one whole token. Do not manufacture a day from "1I",
            # "day11", split digits, or a crop containing multiple text boxes.
            if len(qualifying) != 1 or not re.fullmatch(r'(?:[1-9]|1[0-9]|20)', qualifying[0]):
                return None
            return int(qualifying[0])

        except Exception as e:
            self.logger.debug(f"IGD extraction error: {e}")
            return None

    def _decode_frame(self, frame_data: bytes) -> Optional[np.ndarray]:
        """Decode JPEG frame data to numpy array"""
        try:
            # Convert bytes to numpy array
            nparr = np.frombuffer(frame_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            return frame
        except Exception as e:
            self.logger.error(f"Failed to decode frame: {e}")
            return None

    def _detect_emblem(
        self, frame: np.ndarray
    ) -> Tuple[Optional[str], Optional[Tuple[int, int, int, int]], float]:
        """
        Detect matchup by looking for rank emblems first (5 template scans)

        Args:
            frame: Input frame

        Returns:
            (detected_rank, emblem_bbox, confidence) or (None, None, 0.0) if no emblem found
        """
        if self.emblem_detector is None:
            self.logger.warning(
                "Emblem detector not initialized, cannot detect matchups"
            )
            return None, None, 0.0

        with create_span("emblem_detection") as span:
            try:
                # Try to detect any of the 5 rank emblems
                rank, bbox, confidence = self.emblem_detector.detect_emblem(
                    frame, threshold=self.emblem_threshold
                )

                if rank is not None:
                    self.logger.info(
                        f"Matchup detected via {rank} emblem at {bbox}, confidence={confidence:.3f}"
                    )
                    if span:
                        span.set_attribute("emblem.rank", rank)
                        span.set_attribute("emblem.confidence", confidence)
                        span.set_attribute("emblem.detected", True)
                    # Record emblem confidence histogram
                    record_histogram(
                        "emblem_confidence",
                        confidence,
                        {
                            "rank": rank,
                            "streamer": self.streamer,
                            "quality": self.quality,
                        },
                    )
                    return rank, bbox, confidence

                if span:
                    span.set_attribute("emblem.detected", False)
                return None, None, 0.0

            except Exception as e:
                self.logger.error(f'Emblem detection error: {e}')
                raise

    def _crop(
        self, frame: np.ndarray, emblem_bbox: Optional[Tuple[int, int, int, int]] = None,
        right_edge_x: Optional[int] = None, truncated: bool = False,
    ) -> np.ndarray:
        """Crop the username between the emblem and the visible/occluded edge.

        Invalid bounds return an empty crop. Falling back to the full frame
        would let OCR recognize unrelated overlay text as an opponent.
        """
        height, width = frame.shape[:2]
        y1, y2 = int(height * 0.24), height - int(height * 0.24)
        x1 = 0 if emblem_bbox is None else emblem_bbox[0] + emblem_bbox[2]
        x2 = width if right_edge_x is None else min(width, right_edge_x)
        if right_edge_x is not None and not truncated:
            x2 -= int(max(0, x2 - x1) * self.right_edge_crop_margin)
        return frame[y1:y2, max(0, x1):max(0, x2)]

    def _extract_usernames(
        self, frame: np.ndarray
    ) -> Tuple[Optional[str], float, Optional[dict]]:
        """
        Extract username from cropped nameplate frame using PaddleOCR

        Args:
            frame: Cropped BGR frame (PaddleOCR requires 3-channel images)

        Returns:
            Tuple of (username, confidence, ocr_data) where confidence is 0-1 scale
            ocr_data contains detection details for debugging
        """
        if frame.size == 0:
            return None, 0.0, {"detections": []}

        with create_span("ocr_extraction") as span:
            try:
                # Run PaddleOCR prediction
                results = self.reader.predict(frame)

                # Handle empty results
                if not results:
                    if span:
                        span.set_attribute("ocr.text", "")
                        span.set_attribute("ocr.confidence", 0.0)
                        span.set_attribute("ocr.detection_count", 0)
                    record_counter(
                        "ocr_empty",
                        1,
                        {"streamer": self.streamer, "quality": self.quality},
                    )
                    return None, 0.0, {"detections": []}

                # Extract result data
                result = results[0]
                result_json = result.json
                res_data = result_json.get("res", None)

                if res_data is None or not res_data:
                    if span:
                        span.set_attribute("ocr.text", "")
                        span.set_attribute("ocr.confidence", 0.0)
                        span.set_attribute("ocr.detection_count", 0)
                    record_counter(
                        "ocr_empty",
                        1,
                        {"streamer": self.streamer, "quality": self.quality},
                    )
                    return None, 0.0, {"detections": []}

                # Extract recognition results from res_data
                rec_texts = res_data.get("rec_texts", [])
                rec_scores = res_data.get("rec_scores", [])
                rec_polys = res_data.get("rec_polys", [])

                # Handle empty detections
                if not rec_texts:
                    if span:
                        span.set_attribute("ocr.text", "")
                        span.set_attribute("ocr.confidence", 0.0)
                        span.set_attribute("ocr.detection_count", 0)
                    record_counter(
                        "ocr_empty",
                        1,
                        {"streamer": self.streamer, "quality": self.quality},
                    )
                    return None, 0.0, {"detections": []}

                # Find text with highest confidence
                best_idx = max(range(len(rec_scores)), key=lambda i: rec_scores[i])
                text = rec_texts[best_idx]
                confidence = rec_scores[best_idx]

                # Clean up text
                cleaned = self._clean_username(text)

                # Track invalid username rejections
                if cleaned is None and text:
                    record_counter(
                        "ocr_invalid_username",
                        1,
                        {"streamer": self.streamer, "quality": self.quality},
                    )

                # Build debug data structure (convert numpy arrays to lists)
                ocr_data = {"detections": []}
                for i in range(len(rec_texts)):
                    detection = {"text": rec_texts[i], "confidence": rec_scores[i]}
                    # Handle bbox - might be numpy array or list
                    if i < len(rec_polys):
                        bbox = rec_polys[i]
                        if hasattr(bbox, "tolist"):
                            detection["bbox"] = bbox.tolist()
                        else:
                            detection["bbox"] = bbox
                    else:
                        detection["bbox"] = []
                    ocr_data["detections"].append(detection)

                # Log low confidence
                if confidence < self.ocr_confidence_threshold:
                    self.logger.warning(
                        f"Low OCR confidence: text='{text}', "
                        f"confidence={confidence:.3f}"
                    )

                # Set span attributes
                if span:
                    span.set_attribute("ocr.text", cleaned or "")
                    span.set_attribute("ocr.confidence", confidence)
                    span.set_attribute("ocr.detection_count", len(rec_texts))
                    span.set_attribute("ocr.raw_text", text)

                return cleaned, confidence, ocr_data

            except Exception as e:
                self.logger.error(f"Username extraction error: {e}")
                if span:
                    span.set_attribute("ocr.error", str(e))
                raise

    def _create_ocr_visualization(
        self, frame: np.ndarray, ocr_data: dict
    ) -> Optional[bytes]:
        """
        Create visualization showing PaddleOCR bounding boxes

        Args:
            frame: The cropped frame passed to PaddleOCR
            ocr_data: PaddleOCR output dict with detection list

        Returns:
            JPEG bytes of visualization, or None on error
        """
        try:
            # Ensure color image for visualization
            if len(frame.shape) == 2:
                vis = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
            else:
                vis = frame.copy()

            # Draw bounding boxes for each detection
            for detection in ocr_data.get("detections", []):
                bbox = detection["bbox"]  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
                text = detection["text"]
                conf = detection["confidence"]

                # Convert bbox to numpy array
                points = np.array(bbox, dtype=np.int32)

                # Color based on confidence
                if conf > 0.7:
                    color = (0, 255, 0)  # Green
                elif conf > 0.3:
                    color = (0, 255, 255)  # Yellow
                else:
                    color = (0, 0, 255)  # Red

                # Draw polygon
                cv2.polylines(vis, [points], True, color, 2)

                # Draw text label
                label = f"{text} ({conf:.2f})"
                cv2.putText(
                    vis,
                    label,
                    tuple(points[0]),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    color,
                    1,
                )

            # Encode to JPEG
            success, encoded = cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 90])
            return encoded.tobytes() if success else None

        except Exception as e:
            self.logger.error(f"OCR visualization error: {e}")
            return None

    def _clean_username(self, text: str) -> Optional[str]:
        """
        Clean and validate extracted username
        Enforces alphanumeric + dot + dash character allowlist
        """
        if not text:
            return None

        # Remove non-alphanumeric characters except underscore, dash, and dot
        cleaned = re.sub(r"[^a-zA-Z0-9_\-.]", "", text)

        # Additional validation: Bazaar username rules
        # - 2-13 characters (validated corpus)
        # - Must start with letter or number
        if len(cleaned) < 2 or len(cleaned) > 13:
            return None

        if not cleaned[0].isalnum():
            return None

        return cleaned if cleaned else None
