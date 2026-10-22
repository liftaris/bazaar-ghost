"""Frozen BG-117 opponent locator. Coordinates returned here are source xywh.

Template similarities are not probabilities. A missing plate edge is unknown
geometry, not evidence of obstruction. No OCR or network work happens here.
"""
from pathlib import Path
import cv2
import numpy as np


class UILocator:
    def __init__(self, templates_dir=None, profile=None):
        self.profile = profile or {}
        root = Path(templates_dir or Path(__file__).resolve().parent.parent / 'templates')
        self.bank = []
        for old in (False, True):
            for rank in ('bronze', 'silver', 'gold', 'diamond', 'legend'):
                raw = cv2.imread(str(root / f'{"_" if old else ""}{rank}_480p.png'), -1)
                if raw is None or raw.ndim != 3 or raw.shape[2] != 4:
                    raise ValueError('Missing RGBA rank template')
                for scale in (.85, 1., 1.15):
                    im = cv2.resize(raw, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                    self.bank.append((rank, im[:, :, :3], (im[:, :, 3] > 0).astype('uint8'),
                                      f'{"_" if old else ""}{rank}_480p.png', scale))
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
        # Only the frozen full-game 16:9 geometry is supported automatically.
        if abs(W / H - 16 / 9) > .025:
            return None
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
        if edge[0] >= .65:
            region = source([left, edge[2], edge[1] - left, edge[3]])
            complete, method = True, method + '+verified-right-edge'
        # Explicit reviewed fallback only; arbitrary profile presence isn't review.
        elif self.profile.get('next_reviewed_name_region'):
            values = self.profile['next_reviewed_name_region']
            if (isinstance(values, list) and len(values) == 4
                    and all(type(v) in (int, float) and np.isfinite(v) for v in values)):
                a, b, c, d = values
                if 0 <= a < 1 and 0 <= b < 1 and 0 < c <= 1-a and 0 < d <= 1-b:
                    region = [round(a*W), round(b*H), round(c*W), round(d*H)]
                    state = 'obstructed' if self.profile.get('opaque_edge') else 'partial'
                    complete = self.profile.get('next_reviewed_name_complete') is True and state != 'obstructed'
                    method += '+reviewed-profile'
        return {'rank': rank, 'rank_region': source([x, y, w, h]), 'score': score,
                'name_region': region, 'complete': complete, 'name_state': state,
                'method': method, 'edge_score': edge[0], 'template': filename, 'template_scale': scale}
