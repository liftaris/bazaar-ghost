"""Name display state, preserving raw OCR before any identity cleanup."""
import math
import json
from numbers import Real

# PaddleOCR's default box padding (1.5) clips underscores below the baseline,
# turning `Black_Hamster` into `Black Hamster`; 2.5 also keeps lower `THE_H4CK`.
NAME_UNCLIP_RATIO = 2.5
# Measured on the October 30 parity sample, relative to the tallest box: same-row
# chat was at most .66 as tall; donation overlays' centres sat .21-.25 of its
# height lower, while pieces of one split name were within .04.
NAME_HEIGHT_FRACTION = .75
NAME_CENTER_OFFSET = .15


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
    """Select the username's boxes, not chat or stream overlays around it.

    The tallest box sets the name's glyph height. Keep boxes at least
    NAME_HEIGHT_FRACTION as tall whose vertical centres align with it: chat is
    smaller, and same-size donation overlays sit lower than the name's line.
    Without box geometry, preserve the original observations rather than
    guessing which token is the name.
    """
    if not boxes or any(box is None for box in boxes):
        return list(range(len(boxes)))
    spans = [(min(point[1] for point in box), max(point[1] for point in box)) for box in boxes]
    top, bottom = max(spans, key=lambda span: span[1] - span[0])
    height, center = bottom - top, (top + bottom) / 2
    selected = [index for index, (t, b) in enumerate(spans)
                if b - t >= NAME_HEIGHT_FRACTION * height
                and abs((t + b) / 2 - center) <= NAME_CENTER_OFFSET * height]
    return sorted(selected, key=lambda index: min(point[0] for point in boxes[index]))


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
        ordinary = tokens(self.reader, crop, boxes=boxes, text_rec_score_thresh=0.,
                          text_det_unclip_ratio=NAME_UNCLIP_RATIO)
        selected = name_line_indices(boxes) if boxes else list(range(len(ordinary)))
        result['region'] = list(region)
        result['ocr_regions'] = {'native': list(region)}
        result['raw_text'] = json.dumps({'native': ordinary, 'name_line_indices': selected,
                                         'regions': result['ocr_regions']}, ensure_ascii=False)
        observed = [ordinary[index] for index in selected if ordinary[index][0].strip()]
        uncertain = not location.get('complete') or location.get('name_state') in ('partial', 'obstructed')
        if not observed:
            result['name_state'] = 'obstructed' if uncertain else 'unreadable'
            return result
        # Detection can split one name into adjacent boxes, e.g. `evil` + `_neuro`.
        text = ''.join(text for text, _ in observed)
        confidence = min(confidence for _, confidence in observed)
        # A masked name is drawn as asterisks, which usernames cannot contain. OCR
        # varies their count and can misread one, e.g. `k*******`.
        visible = ''.join(text.split())
        if visible.count('*') * 2 > len(visible) and confidence >= self.threshold:
            result.update(name_state='masked', confidence=confidence)
            return result
        uncertain = (uncertain or '*' in text or len(observed) != 1 or len(text.split()) != 1
                     or confidence < self.threshold)
        text = text.split()[0]
        result.update(username=text if text.strip('* \t\r\n') else None,
                      confidence=confidence, name_state='obstructed' if uncertain else 'complete')
        return result
