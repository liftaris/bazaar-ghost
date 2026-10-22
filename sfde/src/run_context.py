"""Conservative, per-decode run continuity; never a Session/streamer cache."""
from collections import deque
import cv2
import numpy as np


class PlayerState:
    """Texture only: fixed default-layout inventory/skill patches, no item IDs.

    Clock registration establishes placement. Native patch interiors exclude the
    webcam, portrait, clock, frame ornaments and card borders. A few repeated UI
    corners cannot satisfy the distributed board/skill support requirements.
    """
    @staticmethod
    def layout(frame, clock):
        h,w = frame.shape[:2]
        region = clock.get('clock_region') if clock.get('visible') is True else None
        if (h < 360 or abs(w/h-16/9) > .025 or not isinstance(region,(list,tuple))
                or len(region)!=4 or not all(type(v) is int for v in region)):
            return None
        x,y,cw,ch = region
        if not (.08 <= x/w <= .12 and .35 <= y/h <= .42
                and .09 <= cw/w <= .125 and .23 <= ch/h <= .28):
            return None
        # Reviewed inventory interior: approximately x=.25..79,y=.535..705.
        bx,by,bw,bh = x+1.43*cw,y+.60*ch,5*cw,.66*ch
        board = []
        for row in range(2):
            for col in range(6):
                board.append([round(bx+(col+.15)*bw/6),round(by+(row+.15)*bh/2),
                              round(.70*bw/6),round(.70*bh/2)])
        # Actual skill interiors on both sides of the central portrait; left
        # lower row adds vertical distribution. Empty sockets fail texture gates.
        centers = [(2.22,1.68),(2.66,1.68),(3.05,1.68),(2.22,1.98),(2.66,1.98),
                   (4.41,1.68),(4.85,1.68),(5.27,1.68)]
        size = round(.15*ch)
        hud = [[round(x+dx*cw-size/2),round(y+dy*ch-size/2),size,size] for dx,dy in centers]
        if any(px<0 or py<0 or px+pw>w or py+ph>h for px,py,pw,ph in board+hud):
            return None
        return {'frame_size':[w,h],'clock_region':list(region),
                'board':board,'hud':hud,'board_region':[round(bx),round(by),round(bw),round(bh)]}

    @staticmethod
    def describe(frame, layout):
        if layout is None or [frame.shape[1],frame.shape[0]] != layout['frame_size']:
            return None
        result = {}
        for group in ('board','hud'):
            patches = []
            for x,y,w,h in layout[group]:
                gray = cv2.cvtColor(frame[y:y+h,x:x+w],cv2.COLOR_BGR2GRAY).astype(np.float32)
                if gray.std() < 8 or float((gray<12).mean()) > .50:
                    patches.append(None)
                    continue
                scale = min(1.,32/max(gray.shape))
                if scale < 1:
                    gray = cv2.resize(gray,(round(w*scale),round(h*scale)),interpolation=cv2.INTER_AREA)
                gray = cv2.GaussianBlur(gray,(3,3),0)
                edges = np.stack([cv2.Sobel(gray,cv2.CV_32F,1,0),cv2.Sobel(gray,cv2.CV_32F,0,1)])
                if float(np.sqrt(np.mean(edges*edges))) < 12:
                    patches.append(None)
                    continue
                centered = (gray-gray.mean()).ravel()
                edge = edges.ravel()
                patches.append((centered/max(1,np.linalg.norm(centered)),edge/max(1,np.linalg.norm(edge))))
            result[group] = patches
        return result

    @staticmethod
    def distributed(group, indices):
        if group=='board':
            return len(indices)>=6 and len({i%6 for i in indices})>=4 and len({i//6 for i in indices})==2
        return (len(indices)>=4 and any(i>=5 for i in indices) and any(i in (3,4) for i in indices)
                and len({i for i in indices if i in (0,1,2,5,6,7)})>=2)

    @classmethod
    def qualified(cls, state, group):
        return state is not None and cls.distributed(group,[i for i,p in enumerate(state[group]) if p is not None])

    @classmethod
    def compare(cls, previous, current, group):
        scores,matched = [],[]
        if previous is not None and current is not None:
            for i,(a,b) in enumerate(zip(previous[group],current[group])):
                if a is None or b is None or a[0].shape!=b[0].shape:
                    continue
                structure,edge = float(a[0]@b[0]),float(a[1]@b[1])
                scores.append({'patch':i,'structure':structure,'edge':edge})
                if structure>=.80 and edge>=.70:
                    matched.append(i)
        return {'supported':cls.distributed(group,matched),'matched':matched,'scores':scores}


class ObservedRun:
    """Sampled player-state continuity, not a guarantee against hidden edits.

    Board OR distributed dynamic skills may carry the run. Brief hidden states
    require matching endpoints, not trusted intermediate pixels or age alone.
    Registered layout, sampling, day/reset/end and blackout guards still apply.
    The full-scene helpers below are phase-only; unchanged hero art is no proof.
    """
    def __init__(self):
        self.epoch = 0
        self.last_ms = self.interval = self.last_day = None
        self.last_wins = None
        self.anchor = None
        self.layout = None
        self.board = self.hud = None
        self.intro_supported = False
        self.last_match = None
        self.pending = deque(maxlen=3)
        self.pending_day = None
        self.recent = deque(maxlen=5)
        self.reason = 'first_observation'
        self.bridge = None

    @staticmethod
    def signature(frame):
        return cv2.resize(frame, (96, 54), interpolation=cv2.INTER_AREA).astype(np.float32)

    @staticmethod
    def shared(a, b):
        good, eligible = [], 0
        for row in range(4):
            for col in range(6):
                if row == 3 and col < 2:  # Never use the common webcam corner.
                    continue
                y1,y2,x1,x2 = row*54//4,(row+1)*54//4,col*16,(col+1)*16
                left,right = a[y1:y2,x1:x2],b[y1:y2,x1:x2]
                if left.std() < 6 or right.std() < 6:
                    continue
                eligible += 1
                l,r = left-left.mean(),right-right.mean()
                correlation = float((l*r).sum()/max(1,np.linalg.norm(l)*np.linalg.norm(r)))
                if np.abs(left-right).mean() <= 18 or correlation >= .93:
                    good.append((row,col))
        return (eligible >= 8 and len(good)/eligible >= .45
                and len({c for _,c in good}) >= 3 and len({r for r,_ in good}) >= 2)

    @classmethod
    def bridge_proof(cls, a, samples, b):
        chain = [a]+samples+[b]
        if all(cls.shared(left,right) for left,right in zip(chain,chain[1:])):
            return {'method':'adjacent_spatial_persistence'}
        # Require a genuine two-sided convex fade, not samples matching only the
        # old scene followed by an unexplained jump to an unrelated new scene.
        delta = b-a
        denominator = float((delta*delta).sum())
        if denominator <= 1:
            return None
        fits = []
        for middle in samples:
            alpha = float(((middle-a)*delta).sum()/denominator)
            residual = float(np.sqrt(np.mean((middle-(a+alpha*delta))**2)))
            if not -.02 <= alpha <= 1.02 or residual > 12:
                return None
            fits.append({'alpha':alpha,'rmse':residual})
        if (not any(.05 <= fit['alpha'] <= .95 for fit in fits)
                or any(right['alpha'] < left['alpha'] for left,right in zip(fits,fits[1:]))):
            return None
        return {'method':'two_sided_convex_crossfade','fits':fits}

    def split(self, reason):
        self.epoch += 1
        self.anchor = None
        self.board = self.hud = None
        self.intro_supported = False
        self.pending.clear()
        self.pending_day = None
        self.recent.clear()
        self.bridge = None
        self.reason = reason

    def needs_scene_read(self, frame):
        if self.anchor is None or self.last_day is None or self.layout is None:
            return False
        state = PlayerState.describe(frame,self.layout)
        return not any(PlayerState.compare(ref[1] if ref else None,state,group)['supported']
                       for group,ref in (('board',self.board),('hud',self.hud)))

    def phase_bridge(self, source_ms, intro_ms):
        rows = [(t,s) for t,s in self.recent if source_ms <= t <= intro_ms]
        if not rows or rows[0][0] != source_ms or rows[-1][0] != intro_ms:
            return None
        if len(rows) == 2:
            return {'method':'adjacent_registered_clock_and_verified_intro',
                    'from_ms':source_ms,'samples':[],'to_ms':intro_ms}
        proof = self.bridge_proof(rows[0][1],[s for _,s in rows[1:-1]],rows[-1][1])
        return ({**proof,'from_ms':source_ms,'samples':[t for t,_ in rows[1:-1]],'to_ms':intro_ms}
                if proof else None)

    def observe(self, at_ms, frame, *, intro, clock, scene=None):
        sig = self.signature(frame)
        self.bridge = None
        self.last_match = None
        self.intro_supported = False
        if self.last_ms is not None:
            delta = at_ms-self.last_ms
            if delta > 4000 or (self.interval is not None and delta > self.interval*1.5):
                self.split('sampling_gap')
            elif self.interval is None:
                self.interval = delta
        self.last_ms = at_ms
        prior_day = self.last_day
        day = clock.get('igd') if clock.get('visible') is True else None
        if type(day) is int and 1 <= day <= 20:
            if self.last_day is not None and (day < self.last_day or day > self.last_day+1):
                self.split('day_reset_or_jump')
            self.last_day = day
        signal = clock.get('continuity_signal') or clock.get('phase')
        wins = clock.get('wins_remaining') if clock.get('visible') is True else None
        ended = type(wins) is int and wins == 0 and self.last_wins is not None and self.last_wins > 0
        if type(wins) is int:
            self.last_wins = wins
        if signal in ('run_end','menu','loading') or ended:
            self.split(signal or 'ten_wins_run_end')
        # Flat/black game pixels cannot be explained by an ordinary card change.
        game = sig[:40]
        blackout = float((game.max(axis=2) < 12).mean()) > .75
        if blackout:
            self.split('blackout_or_loading')
        if signal in ('run_end','menu','loading') or ended or blackout:
            self.recent.append((at_ms,sig))
            return self.epoch
        if clock.get('visible') is True:
            registered = PlayerState.layout(frame,clock)
            if registered is None:
                if self.layout is not None:
                    self.split('unsupported_layout')
                self.layout = None
            elif self.layout is None:
                self.layout = registered
            elif (registered['frame_size'] != self.layout['frame_size']
                  or max(abs(a-b) for a,b in zip(registered['clock_region'],self.layout['clock_region']))>frame.shape[0]*.015):
                self.split('changed_layout')
                self.layout = registered
        if self.layout is not None and self.layout['frame_size'] != [frame.shape[1],frame.shape[0]]:
            self.split('changed_frame_geometry')
            self.layout = None
        state = PlayerState.describe(frame,self.layout)
        board = PlayerState.compare(self.board[1] if self.board else None,state,'board')
        hud = PlayerState.compare(self.hud[1] if self.hud else None,state,'hud')
        board_changed = (self.board is not None and PlayerState.qualified(state,'board')
                         and not board['supported'])
        same = board['supported'] or hud['supported']
        support = ('distributed_board_and_hud_match' if board['supported'] and hud['supported'] else
                   'distributed_board_match' if board['supported'] else
                   'distributed_hud_match_despite_board_change' if hud['supported'] and board_changed else
                   'distributed_hud_match' if hud['supported'] else 'unknown_player_state')
        self.last_match = {'board':board,'hud':hud,'board_changed':board_changed,
                           'continuity_support':support,'reference_updates':{},
                           'board_source_ms':self.board[0] if self.board else None,
                           'hud_source_ms':self.hud[0] if self.hud else None}
        if intro:
            self.intro_supported = bool(self.anchor is not None and self.layout is not None
                                        and all(p['kind']=='intro' for p in self.pending))
            same = False  # Hero artwork can never match/replace player state.
        resolved = False
        if self.anchor is not None and same and self.pending:
            cards = [p for p in self.pending if p['kind']=='day_transition']
            if cards:
                resolved = (board['supported'] and type(self.pending_day) is int
                            and day==self.pending_day+1 and all(p['day']==day for p in cards)
                            and clock.get('visible') is True)
                method = 'day_interstitial_then_same_player_board_and_registered_next_day'
            else:
                # Parent-approved endpoint corroboration: hidden pixels are not
                # trusted. An actual distributed state match must return within
                # the bounded, uninterrupted interval; mere elapsed age cannot
                # resolve it. This cannot detect an unobserved matching edit.
                resolved = True
                method = 'bounded_endpoint_corroboration_then_same_player_state'
            resolved = resolved and at_ms-self.anchor <= 8000
            if resolved:
                self.bridge = {'method':method,'from_ms':self.anchor,'to_ms':at_ms,
                               'samples':[p['at_ms'] for p in self.pending],'observations':list(self.pending),
                               'return_support':support,'intermediate_pixels_trusted':False}
                self.pending.clear()
                self.pending_day = None
            else:
                self.split('unproven_player_state_transition')
        reference_support = support
        if self.anchor is None:
            reference_support = 'registered_layout_initial_state'
            if not intro and clock.get('visible') is True and self.layout is not None:
                if PlayerState.qualified(state,'board') or PlayerState.qualified(state,'hud'):
                    self.anchor = at_ms
        elif same and not self.pending:
            self.anchor = at_ms
        else:
            if at_ms-self.anchor <= 8000 and len(self.pending)<3:
                if not self.pending:
                    self.pending_day = prior_day
                self.pending.append({'at_ms':at_ms,'kind':'intro' if intro else
                                     scene['kind'] if scene else 'opaque_or_unmatched_player_state',
                                     'day':scene.get('day') if scene else None,
                                     'scene':scene})
            else:
                self.split('unresolved_player_state_gap')
        if self.anchor==at_ms and not intro:
            # References keep independent source times. HUD-supported purchases
            # can refresh the board, and board-supported new skills can refresh
            # the HUD, without claiming that the refreshed component matched.
            for group in ('board','hud'):
                if PlayerState.qualified(state,group):
                    previous = getattr(self,group)
                    self.last_match['reference_updates'][group] = {
                        'at_ms':at_ms,'previous_ms':previous[0] if previous else None,
                        'supported_by':reference_support}
                    setattr(self,group,(at_ms,state))
        self.recent.append((at_ms,sig))
        return self.epoch
