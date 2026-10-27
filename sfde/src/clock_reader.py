"""Single-frame clock observations using the caller's shared PaddleOCR reader.

No model construction, network calls, timestamps, writes, or temporal state.
Template scores are quality diagnostics, not calibrated probabilities. Unsupported
layouts/animation/visibility return independently unknown fields.
"""
from functools import lru_cache
import math
from numbers import Real
from pathlib import Path
import re

import cv2
import numpy as np


ASSET_DIR = Path(__file__).resolve().parent.parent / 'assets' / 'clock'
_SCALES = (0.42, 4 / 9, 0.46, 0.48, 0.6, 0.8, 1.0, 1.2)
_CROWN = (34, 214, 63, 242)
_WINS = (66, 20, 176, 60)
_ROW_OFFSETS = tuple((dx, dy) for dy in range(-2, 3) for dx in range(-2, 3))


def _correlation(a, b):
    a = a.astype(np.float32).ravel()
    b = b.astype(np.float32).ravel()
    a, b = a - a.mean(), b - b.mean()
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b / denominator) if denominator else 0.0


def _colour(image, kind):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    if kind == 'orange':
        return cv2.inRange(hsv, (5, 110, 90), (35, 255, 255)) > 0
    return cv2.inRange(hsv, (0, 0, 80), (179, 90, 255)) > 0


def _register(image, anchor, mask, scales):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    best = None
    for scale in scales:
        size = (round(anchor.shape[1] * scale), round(anchor.shape[0] * scale))
        if min(size) < 8 or size[0] > gray.shape[1] or size[1] > gray.shape[0]:
            continue
        template = cv2.resize(anchor, size)
        support = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST)
        scores = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED, mask=support)
        scores[~np.isfinite(scores)] = -1
        _, score, _, position = cv2.minMaxLoc(scores)
        if best is None or score > best['score']:
            best = {'x': position[0] - 18 * scale, 'y': position[1] - 58 * scale,
                    'scale': scale, 'score': float(score)}
    return best


def _canonical(image, location):
    scale, x, y = location['scale'], location['x'], location['y']
    transform = np.array([[1 / scale, 0, -x / scale],
                          [0, 1 / scale, -y / scale]], dtype=np.float32)
    return cv2.warpAffine(image, transform, (205, 275), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0)


@lru_cache(maxsize=1)
def _assets():
    geometry = cv2.imread(str(ASSET_DIR / 'geometry.png'))
    if geometry is None or geometry.shape != (275, 205, 3):
        raise ValueError('Clock geometry asset missing or malformed')
    gray = cv2.cvtColor(geometry, cv2.COLOR_BGR2GRAY)
    mask = np.zeros_like(gray)
    cv2.ellipse(mask, (108, 140), (90, 86), 0, 0, 360, 255, -1)
    cv2.ellipse(mask, (108, 140), (69, 66), 0, 0, 360, 0, -1)
    mask[:110, 82:136] = 0
    # Cards/tooltips can overlap the lower-right clock rim while all three
    # targets remain visible. Register on the other fixed annulus sectors.
    mask[160:, 150:] = 0
    anchor, support = gray[58:227, 18:199], mask[58:227, 18:199]
    dark = cv2.inRange(cv2.cvtColor(geometry, cv2.COLOR_BGR2HSV),
                       (90, 65, 10), (130, 255, 100))
    window = np.zeros_like(dark)
    window[15:65, 60:185] = 255
    count, components, stats, _ = cv2.connectedComponentsWithStats(dark & window)
    ids = sorted((i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] > 30),
                 key=lambda i: stats[i, cv2.CC_STAT_LEFT])
    if len(ids) != 10:
        raise ValueError('Clock asset must expose ten separate slot interiors')
    slots = []
    for component in ids:
        # Remove antialiased gold borders before projecting tiny native480 cells.
        core = cv2.erode((components == component).astype(np.uint8),
                         np.ones((3, 3), dtype=np.uint8)) > 0
        slots.append(core if core.sum() >= 8 else components == component)
    crowns = {}
    for name, file in [('whole', 'safe.png'), ('cracked', 'cracked.png')]:
        image = cv2.imread(str(ASSET_DIR / file))
        if image is None:
            raise ValueError('Clock crown asset missing: ' + file)
        location = _register(image, anchor, support, _SCALES)
        if location is None or location['score'] < 0.72:
            raise ValueError('Clock development template registration failed')
        registered = _canonical(image, location)
        x1, y1, x2, y2 = _CROWN
        patch = registered[y1:y2, x1:x2]
        crowns[name] = (cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY),
                        _colour(patch, 'orange' if name == 'whole' else 'grey'))
    return anchor, support, tuple(slots), crowns


@lru_cache(maxsize=1)
def _box_geometry():
    """Local neighborhoods from the original ten template components."""
    geometry = cv2.imread(str(ASSET_DIR / 'geometry.png'))
    dark = cv2.inRange(cv2.cvtColor(geometry, cv2.COLOR_BGR2HSV),
                       (90, 65, 10), (130, 255, 100))
    window = np.zeros_like(dark)
    window[15:65, 60:185] = 255
    count, components, stats, _ = cv2.connectedComponentsWithStats(dark & window)
    ids = sorted((i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] > 30),
                 key=lambda i: stats[i, cv2.CC_STAT_LEFT])
    if len(ids) != 10:
        raise ValueError('Ten actual box components required')
    gold = (geometry[:, :, 2].astype(np.float32) + geometry[:, :, 1]
            - 2 * geometry[:, :, 0].astype(np.float32))
    grid_x = np.indices(dark.shape)[1]
    boxes = []
    for component in ids:
        full = (components == component).astype(np.uint8)
        inside = cv2.erode(full, np.ones((3, 3), np.uint8))
        rim = cv2.dilate(full, np.ones((5, 5), np.uint8)) - full
        support = cv2.dilate(full, np.ones((7, 7), np.uint8)) - inside
        y, x = np.nonzero(support)
        centre = float(np.nonzero(full)[1].mean())
        boxes.append({
            'bounds': (int(x.min()), int(y.min()), int(x.max()+1), int(y.max()+1)),
            'rim': rim.astype(np.float32), 'inside': inside.astype(np.float32),
            'left': (rim * (grid_x < centre)).astype(np.float32),
            'right': (rim * (grid_x >= centre)).astype(np.float32),
            'support': support.astype(np.float32), 'gold': gold,
        })
    return tuple(boxes)


@lru_cache(maxsize=8)
def _native_box_geometry(scale):
    # Only EXPECTED masks are prefiltered. Source texture is never sharpened or
    # upscaled for collective row quality. A box score is not physical visibility.
    sigma = max(.01, .5 / scale)
    return tuple({key: (value if key == 'bounds' else cv2.GaussianBlur(value, (0, 0), sigma))
                  for key, value in box.items()} for box in _box_geometry())


class ClockReader:
    """Read one full processed BGR frame; caller owns OCR, phase and consensus.

    ``profile`` accepts the existing normalized ``igd_crop_region``. Its exact
    floor/ceil pixel crop is an OCR fallback only when it overlaps the actually
    detected day glyph in an accepted clock layout. It cannot force visibility.
    ``locate(frame)`` is an OCR-free convenience returning source xywh or None.
    """

    def __init__(self, reader, profile=None, text_reader=None):
        self.reader = reader
        self.text_reader = text_reader
        self.profile = dict(profile) if isinstance(profile, dict) else {}
        self._anchor, self._mask, self._slots, self._crowns = _assets()
        self._slot_pixels = tuple(np.nonzero(slot) for slot in self._slots)
        self._boxes = _box_geometry()

    @staticmethod
    def _valid(frame):
        return (isinstance(frame, np.ndarray) and frame.dtype == np.uint8
                and frame.ndim == 3 and frame.shape[2] == 3
                and min(frame.shape[:2]) >= 8)

    def _location(self, frame):
        if not self._valid(frame):
            return None
        # Full processed-frame coordinates, never a per-frame lookup table.
        search = frame[:, :max(1, frame.shape[1] // 3)]
        ratio = frame.shape[0] / 1080
        scales = sorted({ratio * offset for offset in (0.94, 0.97, 1, 1.03, 1.06)})
        location = _register(search, self._anchor, self._mask, scales)
        return location if location is not None and location['score'] >= 0.72 else None

    @staticmethod
    def _region(frame, location, box):
        x1, y1, x2, y2 = box
        scale = location['scale']
        left = math.floor(location['x'] + x1 * scale)
        top = math.floor(location['y'] + y1 * scale)
        right = math.ceil(location['x'] + x2 * scale)
        bottom = math.ceil(location['y'] + y2 * scale)
        h, w = frame.shape[:2]
        complete = 0 <= left < right <= w and 0 <= top < bottom <= h
        left, top = max(0, min(w, left)), max(0, min(h, top))
        right, bottom = max(left, min(w, right)), max(top, min(h, bottom))
        return [left, top, right - left, bottom - top], complete

    def locate(self, frame):
        location = self._location(frame)
        if location is None:
            return None
        return self._region(frame, location, (0, 0, 205, 275))[0]

    @staticmethod
    def _source_box(location, box, offset=(0, 0)):
        """Unclipped integer source slice, including its exclusive right/bottom."""
        x1, y1, x2, y2 = box
        dx, dy = offset
        scale = location['scale']
        left = math.floor(location['x'] + (x1+dx)*scale)
        top = math.floor(location['y'] + (y1+dy)*scale)
        right = math.ceil(location['x'] + (x2+dx)*scale)
        bottom = math.ceil(location['y'] + (y2+dy)*scale)
        return left, top, right, bottom

    def _wins_evidence_region(self, frame, location):
        """Bound ALL row support, not just the selected alignment's interiors.

        Native quality and structural slices are exact source slices. Canonical
        color samples additionally need bilinear source taps and a conservative
        one-pixel rounding margin. Missing any required source support abstains.
        Template interpolation does not read extra source pixels.
        """
        regions = [self._source_box(location, _WINS)]
        x1 = min(int(x.min()) for y, x in self._slot_pixels)
        y1 = min(int(y.min()) for y, x in self._slot_pixels)
        x2 = max(int(x.max()) for y, x in self._slot_pixels)
        y2 = max(int(y.max()) for y, x in self._slot_pixels)
        for offset in _ROW_OFFSETS:
            regions.extend(self._source_box(location, box['bounds'], offset)
                           for box in self._boxes)
            left, top, right, bottom = self._source_box(location, (x1, y1, x2, y2), offset)
            regions.append((left-1, top-1, right+2, bottom+2))
        left = min(r[0] for r in regions)
        top = min(r[1] for r in regions)
        right = max(r[2] for r in regions)
        bottom = max(r[3] for r in regions)
        h, w = frame.shape[:2]
        complete = 0 <= left < right <= w and 0 <= top < bottom <= h
        left, top = max(0, min(w, left)), max(0, min(h, top))
        right, bottom = max(left, min(w, right)), max(top, min(h, bottom))
        return [left, top, right-left, bottom-top], complete

    def observe(self, frame):
        output = {'visible': False, 'igd': None, 'wins_remaining': None,
                  'lethal': None, 'game_mode': None, 'tournament_wins': None,
                  'tournament_losses': None, 'evidence': {}, 'clock_region': None}
        location = self._location(frame)
        if location is None:
            return output
        output['visible'] = True
        output['clock_region'] = self._region(frame, location, (0, 0, 205, 275))[0]
        crown_region, crown_complete = self._region(frame, location, _CROWN)
        x, y, w, h = crown_region
        crown_readable = crown_complete and self._crown_quality(frame[y:y+h, x:x+w])
        quality_region, quality_complete = self._region(frame, location, _WINS)
        x, y, w, h = quality_region
        wins_region, wins_complete = self._wins_evidence_region(frame, location)
        wins_readable = (wins_complete and quality_complete
                         and self._wins_quality(frame[y:y+h, x:x+w]))
        # Gate on original source pixels before creating any enlarged view.
        registered = _canonical(frame, location)
        for field, box in [('wins_remaining', _WINS), ('lethal', _CROWN)]:
            region, complete = self._region(frame, location, box)
            if field == 'wins_remaining':
                region, complete = wins_region, wins_complete
            value, confidence = (None, None)
            if complete:
                if field == 'wins_remaining' and wins_readable:
                    value, confidence = self._wins(registered, frame, location)
                elif field == 'lethal' and crown_readable:
                    value, confidence = self._crown(registered)
            output[field] = value
            output['evidence'][field] = {
                'region': region, 'confidence': confidence,
                'method': ('clock_cells_native_row_structure' if field == 'wins_remaining'
                           else 'clock_crown_shape_native_quality') + ('_unknown' if value is None else '')}
        region, complete = self._region(frame, location, (82, 63, 136, 115))
        value, confidence = self._color_day(frame, region) if complete else (None, None)
        method = 'paddle_day_medallion'
        glyph = self._day_region(frame, location)
        if value is None and glyph is not None:
            region = glyph
            x, y, w, h = region
            value, confidence = self._ocr(frame[y:y+h, x:x+w])
            method = 'paddle_day_glyph'
            # Preserve the proven profile preprocessing/crop without allowing an
            # arbitrary configured text box to masquerade as a visible clock.
            fallback = self._profile_region(frame, region)
            if value is None and fallback is not None:
                x, y, w, h = fallback
                value, confidence = self._ocr(frame[y:y+h, x:x+w])
                region, method = fallback, 'paddle_profile_day_crop'
        output['igd'] = value
        output['evidence']['igd'] = {'region': region, 'confidence': confidence,
                                     'method': method + ('_unknown' if value is None else '')}
        score_region, complete = self._region(frame, location, (64, 24, 146, 59))
        score = self._tournament_score(frame, score_region) if complete else None
        if score is not None:
            output.update(game_mode='tournament', tournament_wins=score[0], tournament_losses=score[1],
                          wins_remaining=None, lethal=None)
            for field in ('wins_remaining', 'lethal'):
                output['evidence'].pop(field, None)
            for field in ('game_mode', 'tournament_wins', 'tournament_losses'):
                output['evidence'][field] = {'region': score_region, 'confidence': score[2],
                                             'method': 'paddle_tournament_score'}
        elif output['wins_remaining'] is not None:
            output['game_mode'] = 'normal'
            output['evidence']['game_mode'] = output['evidence']['wins_remaining'].copy()
        return output

    def _color_day(self, frame, region):
        if self.reader is None:
            return None, None
        x, y, w, h = region
        image = cv2.resize(frame[y:y+h, x:x+w], (w*8, h*8), interpolation=cv2.INTER_LINEAR)
        try:
            result = list(self.reader.predict(image, text_det_thresh=.1, text_det_box_thresh=.1))
            if len(result) != 1:
                return None, None
            texts, scores = result[0].get('rec_texts', []), result[0].get('rec_scores', [])
            if len(texts) == len(scores) == 1 and re.fullmatch(r'(?:[1-9]|1[0-9]|20)', texts[0].strip()):
                score = scores[0]
                if isinstance(score, Real) and not isinstance(score, bool) and .9 <= score <= 1:
                    return int(texts[0]), float(score)
        except Exception:
            pass
        return None, None

    def _tournament_score(self, frame, region):
        if self.text_reader is None:
            return None
        x, y, w, h = region
        image = cv2.resize(frame[y:y+h, x:x+w], (w*8, h*8), interpolation=cv2.INTER_LINEAR)
        try:
            results = list(self.text_reader.predict(image))
            if len(results) != 1:
                return None
            text, confidence = results[0].get('rec_text', ''), results[0].get('rec_score', 0)
            match = re.fullmatch(r'(0|[1-9][0-9]*)\s*-\s*(0|[1-9][0-9]*)', text.strip())
            if match and isinstance(confidence, Real) and not isinstance(confidence, bool) and .9 <= confidence <= 1:
                return int(match[1]), int(match[2]), float(confidence)
        except Exception:
            pass
        return None

    @staticmethod
    def _wins_quality(native):
        """Measure actual source texture, never sharpened/upscaled cell edges."""
        if min(native.shape[:2]) < 8:
            return False
        gray = cv2.cvtColor(native, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_32F).var()) >= 250

    @staticmethod
    def _native_gold(native):
        return (native[:, :, 2].astype(np.float32) + native[:, :, 1]
                - 2 * native[:, :, 0].astype(np.float32))

    def _box_row_structure(self, gold, location, offset):
        """Contributions to a COLLECTIVE ten-cell/shared-separator quality gate.

        Scores are not independent physical box-visibility proofs: a covered box
        can score positively while its shared neighbor supplies negative evidence.
        No general obstruction recognition or reconstruction is claimed.
        """
        scale = location['scale']
        dx, dy = offset
        records = []
        for box in _native_box_geometry(scale):
            left, top, right, bottom = self._source_box(location, box['bounds'], offset)
            record = {'region': [left, top, right-left, bottom-top],
                      'structure_supported': False}
            if not (0 <= left < right <= gold.shape[1] and 0 <= top < bottom <= gold.shape[0]):
                record['reason'] = 'clipped'
                records.append(record)
                continue
            transform = np.array([[scale, 0, location['x']+dx*scale-left],
                                  [0, scale, location['y']+dy*scale-top]], np.float32)
            # Resample expected geometry only, never source quality evidence.
            projected = {}
            for key in ['rim', 'inside', 'left', 'right', 'support', 'gold']:
                projected[key] = cv2.warpAffine(box[key], transform, (right-left, bottom-top),
                                                flags=cv2.INTER_LINEAR)
            signal = gold[top:bottom, left:right]
            weight = projected['support']

            def mean(values, weights):
                return float((values*weights).sum() / max(1e-9, float(weights.sum())))

            def effective(weights):
                return float(weights.sum()**2 / max(1e-9, float((weights**2).sum())))

            a = signal - mean(signal, weight)
            b = projected['gold'] - mean(projected['gold'], weight)
            denominator = float(np.sqrt((weight*a*a).sum() * (weight*b*b).sum()))
            correlation = float((weight*a*b).sum()/denominator) if denominator > 1e-9 else 0.0
            inside = mean(signal, projected['inside'])
            contrast = mean(signal, projected['rim']) - inside
            halves = [mean(signal, projected[side])-inside for side in ['left', 'right']]
            support_pixels = effective(weight)
            half_pixels = [effective(projected[side]) for side in ['left', 'right']]
            supported = (support_pixels >= 6 and min(half_pixels) >= 1.5 and correlation >= .35
                         and contrast >= 8 and min(halves) >= 4)
            record.update({'structure_supported': bool(supported), 'correlation': correlation,
                           'rim_contrast': contrast, 'half_contrasts': halves,
                           'effective_source_pixels': support_pixels,
                           'effective_half_pixels': half_pixels,
                           'reason': 'supported' if supported else 'row_structure_not_supported'})
            records.append(record)
        return records

    def _win_details(self, image, native=None, location=None):
        """Bounded shared row alignment; diagnostic scores are not probabilities.

        Native480 pre-intro fills are muted teal, not the saturated combat blue.
        Keep chromatic evidence (never brightness alone), sample the same ten
        separate interiors, and reject disagreeing plausible row alignments.
        """
        b, g, r = (image[:, :, i].astype(np.int16) for i in range(3))
        blue = (b+g-2*r > 12) & (b >= .8*g) & (np.minimum(b,g) >= 80)
        value = image.max(axis=2)
        # Restore the frozen candidate's interior classifier; near-neutral dark
        # cells can be read only alongside the collective row-structure gate.
        dark = (value >= 12) & (value < 90) & ~blue
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        glare = (hsv[:, :, 1] < 55) & (hsv[:, :, 2] > 220)
        neutral = value-image.min(axis=2) <= 1
        # Do not translate masks away from an animated/glared original target.
        obscured = any(float(glare[y,x].mean()) > .15 for y,x in self._slot_pixels)
        has_native = native is not None and location is not None
        source_complete = has_native and self._wins_evidence_region(native, location)[1]
        # Same float32 expression as the frozen candidate, computed ONCE rather
        # than once per offset. No other numerical/threshold optimization.
        gold = self._native_gold(native) if has_native else None
        alignments = []
        for dx, dy in _ROW_OFFSETS:
            cells = []
            for index, (y,x) in enumerate(self._slot_pixels):
                filled = float(blue[y+dy,x+dx].mean())
                empty = float(dark[y+dy,x+dx].mean())
                white = float(glare[y+dy,x+dx].mean())
                grey = float(neutral[y+dy,x+dx].mean())
                state = ('B' if filled >= .65 else 'D' if empty >= .65 else '?') if white <= .15 and grey <= .65 else '?'
                cells.append({'cell': index+1, 'blue': filled, 'dark': empty,
                              'glare': white, 'neutral': grey, 'state': state})
            states = [cell['state'] for cell in cells]
            valid = '?' not in states and states == sorted(states)
            borders = self._box_row_structure(gold, location, [dx, dy]) if has_native else []
            structure = len(borders) == 10 and all(box['structure_supported'] for box in borders)
            alignments.append({'offset': [dx,dy], 'cells': cells,
                'support': min(max(c['blue'],c['dark']) for c in cells),
                'colour_remaining': states.count('D') if valid else None,
                'borders': borders, 'structure': structure,
                'remaining': states.count('D') if valid and structure else None})
        accepted = [a for a in alignments if a['remaining'] is not None]
        counts = sorted({a['remaining'] for a in accepted})
        best = max(accepted or alignments, key=lambda a: (a['support'], -sum(abs(v) for v in a['offset'])))
        reason = ('native_source_incomplete' if not source_complete else
                  'white_glare' if obscured else 'alignment_ambiguous' if len(counts)>1
                  else 'insufficient_cell_support' if len(accepted)<2 else 'supported')
        return {'wins_remaining': counts[0] if reason == 'supported' else None,
                'confidence': best['support'] if reason == 'supported' else None,
                'offset': best['offset'], 'cells': best['cells'], 'reason': reason,
                'valid_alignments': len(accepted), 'candidate_counts': counts,
                'borders': best['borders'], 'alignments': alignments}

    def _wins(self, image, native=None, location=None):
        details = self._win_details(image, native, location)
        return details['wins_remaining'], details['confidence']

    @staticmethod
    def _crown_quality(native):
        # BEFORE any upscaling: require actual native-pixel texture/contrast and
        # reject missing pixels. Sharpened/upscaled blur is not new evidence.
        if min(native.shape[:2]) < 8:
            return False
        gray = cv2.cvtColor(native, cv2.COLOR_BGR2GRAY)
        if (float(cv2.Laplacian(gray, cv2.CV_32F).var()) < 250
                or float(gray.std()) < 15
                or float((native.max(axis=2) < 8).mean()) > 0.12):
            return False
        return True

    def _crown(self, image):
        x1, y1, x2, y2 = _CROWN
        candidates = {}
        for name, (template, shape) in self._crowns.items():
            best = (-1.0, 0.0, 0.0)
            for dy in range(-3, 4):
                for dx in range(-3, 4):
                    patch = image[y1+dy:y2+dy, x1+dx:x2+dx]
                    score = _correlation(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), template)
                    if score > best[0]:
                        pixels = _colour(patch, 'orange' if name == 'whole' else 'grey')
                        dice = float(2 * (pixels & shape).sum() / max(1, pixels.sum() + shape.sum()))
                        best = (score, dice, float(pixels.mean()))
            candidates[name] = best
        whole, cracked = candidates['whole'], candidates['cracked']
        if (whole[0] >= 0.65 and whole[0] - cracked[0] >= 0.05
                and whole[1] >= 0.55 and whole[2] >= 0.15):
            return False, min(whole[:2])
        # Grey alone is NEVER lethal. The colour-independent cracked template
        # must beat the whole-crown template on the same actual pixel shape.
        if (cracked[0] >= 0.70 and cracked[0] - whole[0] >= 0.12
                and cracked[1] >= 0.55 and cracked[2] >= 0.12):
            return True, min(cracked[:2])
        return None, None

    def _day_region(self, frame, location):
        region, complete = self._region(frame, location, (82, 63, 136, 115))
        if not complete:
            return None
        x, y, w, h = region
        patch = frame[y:y+h, x:x+w]
        hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
        white = cv2.inRange(hsv, (0, 0, 105), (179, 115, 255))
        contours, hierarchy = cv2.findContours(white, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            return None
        center = (location['x'] + 108 * location['scale'] - x,
                  location['y'] + 91 * location['scale'] - y)
        glyphs = []
        for i, contour in enumerate(contours):
            if hierarchy[0, i, 3] < 0:
                continue
            gx, gy, gw, gh = cv2.boundingRect(contour)
            # Tiny shadow pinholes in the printed medallion are not glyphs;
            # merging them into a 1's box adds the rim and clips OCR context.
            if (gh >= max(4, 14 * location['scale'])
                    and abs(gx + gw / 2 - center[0]) <= 16 * location['scale']
                    and abs(gy + gh / 2 - center[1]) <= 12 * location['scale']):
                glyphs.append((gx, gy, gx+gw, gy+gh))
        if not glyphs:
            return None
        # Bound the actual dark glyph holes inside the white medallion, not a
        # hardcoded narrow geometry window that clips 1/11 on another layout.
        left, top = min(g[0] for g in glyphs), min(g[1] for g in glyphs)
        right, bottom = max(g[2] for g in glyphs), max(g[3] for g in glyphs)
        margin = max(1, round(2 * location['scale']))
        left, top = left-margin, top-margin
        right, bottom = right+margin, bottom+margin
        # A printed 1 is much narrower than its white medallion. Keep genuine
        # source-pixel side context for Paddle's text detector rather than
        # stretching a 2px stroke or clipping it with the former fixed window.
        if right-left < bottom-top:
            extra = bottom-top-(right-left)
            left -= extra // 2
            right += extra-extra // 2
        if left < 0 or top < 0 or right > w or bottom > h:
            return None
        return [x+left, y+top, right-left, bottom-top]

    def _profile_region(self, frame, glyph):
        values = self.profile.get('igd_crop_region')
        if not isinstance(values, (list, tuple)) or len(values) != 4:
            return None
        if any(not isinstance(v, Real) or isinstance(v, bool) or not math.isfinite(v) for v in values):
            return None
        x, y, w, h = values
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1-x and 0 < h <= 1-y):
            return None
        fh, fw = frame.shape[:2]
        result = [math.floor(x*fw), math.floor(y*fh), math.ceil(w*fw), math.ceil(h*fh)]
        rx, ry, rw, rh = result
        gx, gy, gw, gh = glyph
        overlap = max(0, min(rx+rw, gx+gw)-max(rx, gx)) * max(0, min(ry+rh, gy+gh)-max(ry, gy))
        if (rx+rw > fw or ry+rh > fh
                or rw > 3*gw or rh > 3*gh or overlap < 0.75*gw*gh):
            return None
        return result

    def _ocr(self, patch):
        if self.reader is None or patch.size == 0:
            return None, None
        h, w = patch.shape[:2]
        scale = max(200/h, 200/w, 4.0)
        image = cv2.resize(patch, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_LINEAR)
        _, binary = cv2.threshold(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), 65, 255, cv2.THRESH_BINARY)
        image = cv2.copyMakeBorder(cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR),
                                   50, 50, 50, 50, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        try:
            results = list(self.reader.predict(image, text_det_thresh=0.1, text_det_box_thresh=0.1))
            if len(results) != 1:
                return None, None
            texts, scores = results[0].get('rec_texts', []), results[0].get('rec_scores', [])
            if len(texts) != len(scores):
                return None, None
            accepted = []
            for text, score in zip(texts, scores):
                if (not isinstance(text, str) or not isinstance(score, Real)
                        or isinstance(score, bool) or not math.isfinite(score)
                        or not 0 <= score <= 1):
                    return None, None
                if score >= 0.9:
                    accepted.append((text.strip(), float(score)))
            if len(accepted) != 1 or not re.fullmatch(r'(?:[1-9]|1[0-9]|20)', accepted[0][0]):
                return None, None
            return int(accepted[0][0]), accepted[0][1]
        except Exception:
            return None, None
