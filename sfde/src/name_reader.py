"""Name display state, preserving raw OCR before any identity cleanup."""
import math
import json
from numbers import Real
import cv2


def tokens(reader, image, *, boxes=None, **predict_options):
    results = reader.predict(image, **predict_options)
    if not results or len(results) != 1:
        return []
    result = results[0]
    data = result.json.get('res', {}) if hasattr(result, 'json') else result
    texts, scores = data.get('rec_texts', []), data.get('rec_scores', [])
    if len(texts) != len(scores):
        return []
    polygons = data.get('rec_polys', [])
    observed = []
    for index, (text, score) in enumerate(zip(texts, scores)):
        if (isinstance(text, str) and isinstance(score, Real) and not isinstance(score, bool)
                and math.isfinite(score) and 0 <= score <= 1):
            observed.append((text, float(score)))
            if boxes is not None:
                boxes.append(polygons[index] if index < len(polygons) else None)
    return observed


def name_line_indices(boxes):
    """Select the large name line, not smaller chat lines above/below it.

    Keep every fragment on that row. Without box geometry, preserve the original
    observations rather than guessing which token is the name.
    """
    if not boxes or any(box is None for box in boxes):
        return list(range(len(boxes)))
    spans = [(min(point[1] for point in box), max(point[1] for point in box)) for box in boxes]
    top, bottom = max(spans, key=lambda span: span[1] - span[0])
    center = (top + bottom) / 2
    return [index for index, (top, bottom) in enumerate(spans) if top <= center <= bottom]


class NameReader:
    def __init__(self, reader, threshold=.5):
        self.reader, self.threshold = reader, threshold

    def read(self, frame, location):
        result = {'username': None, 'confidence': None, 'name_state': location.get('name_state', 'unreadable'),
                  'raw_text': '', 'method': 'native-english-ocr'}
        region = location.get('name_region')
        if (not isinstance(region, (list, tuple)) or len(region) != 4
                or not all(type(v) is int for v in region)):
            return result
        x, y, w, h = region
        H, W = frame.shape[:2]
        if not (0 <= x < W and 0 <= y < H and 0 < w <= W-x and 0 < h <= H-y):
            return result
        crop = frame[y:y+h, x:x+w]
        # Collect observations, including fragments. The configured threshold
        # labels uncertainty below; it must not filter text inside PaddleOCR.
        boxes = []
        ordinary = tokens(self.reader, crop, boxes=boxes, text_rec_score_thresh=0.)
        selected = name_line_indices(boxes) if boxes else list(range(len(ordinary)))
        # This branch is *only* for masks; normal names keep native preprocessing.
        # The edge template includes bottom plaque ornament. Mask-only text strip:
        # retain the upper glyph margin, inset the two border caps, exclude the
        # bottom 21%. Never feed this special strip to ordinary identity OCR.
        pad_top, inset, trim = round(h*.09), round(w*.10), round(h*.21)
        mask_y = max(0, y-pad_top)
        mask_region = [x+inset, mask_y, w-2*inset, y+h-trim-mask_y]
        mx, my, mw, mh = mask_region
        mask_crop = frame[my:my+mh, mx:mx+mw]
        # Evidence must cover *both* actual inputs, including the mask branch's
        # small upper context extension, in original full-frame coordinates.
        result['region'] = list(region)
        result['ocr_regions'] = {'native': list(region)}
        mask = []
        if mask_crop.size:
            enlarged = cv2.resize(mask_crop, None, fx=4, fy=4, interpolation=cv2.INTER_LINEAR)
            gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)
            binary = cv2.threshold(gray, 65, 255, cv2.THRESH_BINARY)[1]
            mask = tokens(self.reader, cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR), text_rec_score_thresh=0.)
            result['region'] = [x, mask_y, w, y+h-mask_y]
            result['ocr_regions']['mask'] = mask_region
        result['raw_text'] = json.dumps({'native': ordinary, 'mask': mask,
                                         'name_line_indices': selected,
                                         'regions': result['ocr_regions']}, ensure_ascii=False)
        if len(mask) == 1 and mask[0][0].strip() == '******' and mask[0][1] >= .90:
            result.update(name_state='masked', confidence=mask[0][1],
                          method='mask-binary65-linear4x-english-ocr')
            return result
        observed = [(text, confidence) for index, (text, confidence) in enumerate(ordinary)
                    if index in selected and text.strip()]
        uncertain = (not location.get('complete')
                     or location.get('name_state') in ('partial', 'obstructed')
                     or any('*' in text for text, _ in ordinary + mask))
        if not observed:
            result['name_state'] = 'obstructed' if uncertain else 'unreadable'
            return result
        # Newlines delimit OCR boxes, not inferred spaces or hidden letters.
        # Preserve case, punctuation, Unicode and the complete observed tokens.
        text = '\n'.join(text for text, _ in observed)
        confidence = min(confidence for _, confidence in observed)
        uncertain = uncertain or len(observed) != 1 or len(text.split()) != 1 or confidence < self.threshold
        result.update(username=text if text.strip('* \t\r\n') else None,
                      confidence=confidence, name_state='obstructed' if uncertain else 'complete')
        return result
