"""Frozen BG-117 opponent locator. Coordinates returned here are source xywh.

Template similarities are not probabilities. A missing plate edge marks an
uncertain/obstructed observation, not proof of a webcam. No OCR happens here.
"""
from pathlib import Path
import cv2
import numpy as np


class UILocator:
    def __init__(self, templates_dir=None, *, old_templates=False):
        root = Path(templates_dir or Path(__file__).resolve().parent.parent / 'templates')
        self.bank = []
        # Frames are normalized by height once. The recording's template era is
        # already known; searching both eras and three extra sizes was redundant.
        for rank in ('bronze', 'silver', 'gold', 'diamond', 'legend'):
            filename = f'{"_" if old_templates else ""}{rank}_480p.png'
            raw = cv2.imread(str(root / filename), -1)
            if raw is None or raw.ndim != 3 or raw.shape[2] != 4:
                raise ValueError('Missing RGBA rank template')
            self.bank.append((rank, raw[:, :, :3], (raw[:, :, 3] > 0).astype('uint8'), filename, 1.))
        raw = cv2.imread(str(root / 'right_edge_480p.png'), -1)
        if raw is None:
            raise ValueError('Missing right-edge template')
        self.edges = []
        for scale in (.85, 1., 1.15):
            im = cv2.resize(raw, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            self.edges.append((im[:, :, :3], (im[:, :, 3] > 0).astype('uint8')))

    @staticmethod
    def _match(crop, image, mask):
        h, w = image.shape[:2]
        if crop.shape[0] < h or crop.shape[1] < w:
            return -1., (0, 0)
        response = cv2.matchTemplate(crop, image, cv2.TM_CCOEFF_NORMED, mask=mask)
        response[~np.isfinite(response)] = -1
        _, score, _, location = cv2.minMaxLoc(response)
        return float(score), location

    def locate(self, frame):
        H, W = frame.shape[:2]
        # Preserve native aspect and source coordinates, including 896x480 VODs.
        factor = 480 / H
        small = cv2.resize(frame, (round(W * factor), 480), interpolation=cv2.INTER_AREA)
        width = small.shape[1]
        x0, y0, x2, y2 = round(width * .50), round(480 * .57), round(width * .94), round(480 * .92)
        crop = small[y0:y2, x0:x2]
        best = None
        for rank, image, mask, filename, scale in self.bank:
            score, (x, y) = self._match(crop, image, mask)
            if best is None or score > best[0]:
                h, w = image.shape[:2]
                best = score, rank, [x + x0, y + y0, w, h], filename, scale
        score, rank, (x, y, w, h), filename, scale = best
        if score < .70:
            return None
        left = x + w - round(h * .15)
        start, end = max(left + 15, x + w), min(width, x + w + round(width * .27))
        top, bottom = max(0, y + round(h * .15)), min(480, y + round(h * .95))
        edge = (-1., 0, 0, 0)
        for image, mask in self.edges:
            s, (ex, ey) = self._match(small[top:bottom, start:end], image, mask)
            th, tw = image.shape[:2]
            candidate = (s, start + ex + tw, top + ey, th)
            if candidate > edge:
                edge = candidate

        def source(box):
            a, b, c, d = [round(v / factor) for v in box]
            return [max(0, a), max(0, b), min(W - max(0, a), c), min(H - max(0, b), d)]

        region, complete, state = None, False, 'unreadable'
        method = 'spatial-masked-rank-480'
        # Edge matching supplies the right boundary, not the glyph baseline:
        # smaller edge matches can sit too low and clip the tops of letters.
        if edge[0] >= .65:
            strip_top = min(edge[2], y + round(h * .24))
            strip_height = edge[2] + edge[3] - strip_top
            region = source([left, strip_top, edge[1] - left, strip_height])
            complete, method = True, method + '+verified-right-edge'
        else:
            # Same fixed layout and verified emblem, but unknown right boundary.
            # Search only the nameplate-height strip beside that emblem, bounded
            # by the existing edge search width and opponent UI search extent.
            # This collects visible fragments, never reconstructs hidden text or
            # interprets a matcher miss as evidence of an actual webcam.
            strip_top = y + round(h * .23)
            strip_height = round(h * .62)
            strip_width = min(end, x2) - left
            if strip_width >= h and strip_top + strip_height <= 480:
                region = source([left, strip_top, strip_width, strip_height])
                state, method = 'obstructed', method + '+bounded-rank-relative-strip'
        return {'rank': rank, 'rank_region': source([x, y, w, h]), 'score': score,
                'name_region': region, 'complete': complete, 'name_state': state,
                'method': method, 'edge_score': edge[0], 'template': filename, 'template_scale': scale}
