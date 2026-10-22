"""Name display state, preserving raw OCR before any identity cleanup."""
import math
import re
import json
from numbers import Real
import cv2


def tokens(reader, image):
    results = reader.predict(image)
    if not results or len(results) != 1:
        return []
    result = results[0]
    data = result.json.get('res', {}) if hasattr(result, 'json') else result
    texts, scores = data.get('rec_texts', []), data.get('rec_scores', [])
    if len(texts) != len(scores):
        return []
    return [(text[:256], float(score)) for text, score in zip(texts, scores)
            if isinstance(text, str) and isinstance(score, Real) and not isinstance(score, bool)
            and math.isfinite(score) and 0 <= score <= 1][:16]


class NameReader:
    def __init__(self, reader, threshold=.5):
        self.reader, self.threshold = reader, threshold

    def read(self, frame, location):
        result = {'username': None, 'confidence': None, 'name_state': location.get('name_state', 'unreadable'),
                  'raw_text': '', 'method': 'native-english-ocr'}
        region = location.get('name_region')
        if not region:
            return result
        x, y, w, h = region
        crop = frame[y:y+h, x:x+w]
        # An incomplete crop must never turn a hallucinated fragment into identity.
        if not location.get('complete') or crop.size == 0:
            return result
        ordinary = tokens(self.reader, crop)
        result['raw_text'] = '\n'.join(t for t, _ in ordinary)[:512]
        # This branch is *only* for masks; normal names keep native preprocessing.
        # The edge template includes bottom plaque ornament. Mask-only text strip:
        # retain the upper glyph margin, inset the two border caps, exclude the
        # bottom 21%. Never feed this special strip to ordinary identity OCR.
        pad_top, inset, trim = round(h*.09), round(w*.10), round(h*.21)
        mask_crop = frame[max(0, y-pad_top):y+h-trim, x+inset:x+w-inset]
        # Evidence must cover *both* actual inputs, including the mask branch's
        # small upper context extension, in original full-frame coordinates.
        result['region'] = [x, max(0,y-pad_top), w, h+min(y,pad_top)]
        enlarged = cv2.resize(mask_crop, None, fx=4, fy=4, interpolation=cv2.INTER_LINEAR)
        gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)
        binary = cv2.threshold(gray, 65, 255, cv2.THRESH_BINARY)[1]
        mask = tokens(self.reader, cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR))
        result['raw_text'] = json.dumps({'native': ordinary, 'mask': mask}, ensure_ascii=False)[:2048]
        if len(mask) == 1 and mask[0][0].strip() == '******' and mask[0][1] >= .90:
            result.update(name_state='masked', confidence=mask[0][1],
                          method='mask-binary65-linear4x-english-ocr')
            return result
        if any('*' in t for t, _ in ordinary + mask):
            result.update(name_state='partial')
            return result
        if len(ordinary) != 1:
            result['name_state'] = 'partial' if ordinary else 'unreadable'
            return result
        text, confidence = ordinary[0]
        # Whole-token allowlist: do not strip hidden glyphs or punctuation into a name.
        if confidence >= max(.90, self.threshold) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{1,12}', text):
            result.update(username=text, confidence=confidence, name_state='complete')
        else:
            result['name_state'] = 'unreadable'
        return result
