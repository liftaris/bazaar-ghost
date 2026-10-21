"""Shared CPU OCR settings for runtime and Docker's model-cache warmup."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from paddleocr import PaddleOCR


TEXT_DETECTION_MODEL = 'PP-OCRv5_mobile_det'
TEXT_RECOGNITION_MODEL = 'en_PP-OCRv5_mobile_rec'
CPU_THREADS = 1


def create_ocr_reader(confidence_threshold: float = 0.5) -> 'PaddleOCR':
    """Load the small English pipeline without optional document models.

    Keep explicit model IDs: PaddleOCR 3.7 defaults to PP-OCRv6 medium.
    One inference thread leaves CPU headroom for FFmpeg on small runners
    instead of the upstream ten-thread default. Disable oneDNN for Paddle 3.3
    mobile graph compatibility, including during build-time inference.
    """
    from paddleocr import PaddleOCR

    return PaddleOCR(
        text_detection_model_name=TEXT_DETECTION_MODEL,
        text_recognition_model_name=TEXT_RECOGNITION_MODEL,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device='cpu',
        cpu_threads=CPU_THREADS,
        enable_mkldnn=False,
        text_rec_score_thresh=confidence_threshold,
    )
