"""Bounded streaming encounter selection and serial optional enrichment.

Decode/CV never calls the backend. Only JPEGs for selected source evidence cross
the bounded result queue. Field selection is independent of name selection.
"""
import base64
from collections import deque
import hashlib
import json
import logging
import math
import re
import time
from uuid import NAMESPACE_URL, uuid5
from run_context import ObservedRun
from name_reader import tokens
import cv2
import numpy as np

MAX_JPEG_BYTES = 2 * 1024 * 1024
HEROES = {'vanessa', 'pygmalien', 'dooley', 'mak', 'jules', 'stelle', 'karnok', 'the_dragons'}
FIELDS = ('igd', 'wins_remaining', 'lethal')


def detection_id(recording, anchor_ms):
    return str(uuid5(NAMESPACE_URL, f'bazaarghost:encounter:{recording}:{anchor_ms}'))


def bounded_name_evidence(raw):
    """Keep the wire's 1024 UTF-16-unit limit without emitting broken JSON.

    The complete observation is retained in the native result artifact. A wire
    excerpt explicitly identifies omission and hashes the original UTF-8 text.
    """
    if len(raw.encode('utf-16-le')) // 2 <= 1024:
        return raw
    return json.dumps({'truncated': True, 'sha256': hashlib.sha256(raw.encode()).hexdigest(),
                       'characters': len(raw), 'preview': raw[:48]}, ensure_ascii=True)


def valid_field(field, value):
    if field == 'lethal':
        return type(value) is bool
    limit = (1, 20) if field == 'igd' else (0, 10)
    return type(value) is int and limit[0] <= value <= limit[1]


class EncounterPipeline:
    def __init__(self, processor, *, recording, vod_id, chunk_id, start_ms, end_ms, clock=None):
        self.processor, self.clock = processor, clock
        self.recording, self.vod_id, self.chunk_id = recording, vod_id, chunk_id
        self.start_ms, self.end_ms = start_ms, end_ms
        self.active = None
        self.intro_present = False
        self.misses = 0
        self.last_ms = None
        self.continuity_epoch = 0
        self.pre_clock = deque(maxlen=3)
        self.pre_scene = deque(maxlen=5)
        self.run_observation = ObservedRun()
        self._scene_attempts = 0
        self.logger = logging.getLogger('sfde.encounters')

    @staticmethod
    def _source(jpeg, at_ms, frame, kind):
        H, W = frame.shape[:2]
        return {'at_ms': at_ms, 'jpeg': jpeg, 'frame_sha256': hashlib.sha256(jpeg).hexdigest(),
                'source_width': W, 'source_height': H, 'kind': kind}

    @staticmethod
    def _evidence(source, region, method, phase, reason, confidence=None, **extra):
        return {key: source[key] for key in ('at_ms', 'frame_sha256', 'source_width', 'source_height')} | {
            'region': list(region), 'method': method, 'confidence': confidence, 'phase': phase,
            'selection_reason': reason, **extra}

    def _remember(self, source):
        self.active['_images'][source['at_ms']] = source

    def _prune(self):
        event = self.active
        references = {e['at_ms'] for e in event['field_evidence'].values()}
        references.add(event['_intro_ms'])
        if event.get('_hero_previous') is not None:
            references.add(event['_hero_previous'][0])
        if event.get('_hero_ms') is not None:
            references.add(event['_hero_ms'])
            if event.get('_hero_previous_ms') is not None:
                references.add(event['_hero_previous_ms'])
        if event.get('_clock_fallback_ms') is not None:
            references.add(event['_clock_fallback_ms'])
            references.update(s['at_ms'] for s in event.get('_clock_fallback_samples', []))
        for readings in event['_clock_reads'].values():
            references.update(row[1]['at_ms'] for row in readings)
        references.update(s['at_ms'] for s in event['_visible_clock_reads'])
        for e in event['field_evidence'].values():
            references.update(s['at_ms'] for s in e.get('samples', []))
        event['_images'] = {t: s for t, s in event['_images'].items() if t in references}
        # Up to 6 independent intro/hero sources, 9 field reads, and registered
        # phase/fallback samples. Release redundant clock working sets below.
        if len(event['_images']) > 15:
            raise RuntimeError('Encounter evidence buffer exceeded its bound')

    def _new(self, source, location):
        at_ms = source['at_ms']
        if not self.start_ms <= at_ms < self.end_ms:
            return  # Preroll observes ownership without publishing outside anchors.
        anchor = at_ms // 1000
        self.active = {
            'schema_version': 2, 'id': detection_id(self.recording, at_ms),
            'recording_identity': self.recording, 'anchor_ms': at_ms, 'timestamp': anchor,
            'vod_id': self.vod_id, 'chunk_id': self.chunk_id, 'is_matchup': True,
            'username': None, 'confidence': None, 'name_state': 'unreadable',
            # This is detector similarity, not a calibrated probability. Per-field
            # confidence stays null for template methods, as the wire requires.
            'encounter_confidence': max(0., min(1., location['score'])), 'detected_rank': None,
            'igd': None, 'wins_remaining': None, 'lethal': None,
            'ghost_hero': None, 'streamer_hero': None, 'field_evidence': {},
            '_images': {}, '_intro_ms': at_ms, '_intro_reads': 0, '_last_intro_ms': at_ms,
            '_hero_ms': None, '_hero_previous': None, '_hero_quality': None, '_hero_seen': 0,
            '_name_quality': (-1, -1.), '_rank_score': -1.,
            '_clock_reads': {f: deque(maxlen=3) for f in FIELDS},
            '_visible_clock_reads': deque(maxlen=3),
            '_clock_initial_values': {}, '_first_clock_ms': None,
            '_clock_started': False, '_clock_closed': False, '_epoch': self.continuity_epoch,
            '_continuity_ambiguous': not self.run_observation.intro_supported,
        }
        self._remember(source)
        self.active['field_evidence']['encounter'] = self._evidence(
            source, location['rank_region'], 'spatial-masked-rank-480', 'intro',
            'first_owned_rank_candidate_immutable_anchor')
        self._prefight_context(at_ms)

    def _prefight_context(self, intro_ms):
        """Prove phase from OWNED observations preceding this introduction.

        Clock visibility alone after the intro cannot distinguish combat/result.
        A registered field immediately preceding a verified introduction can be
        phase-supported independently of other clock fields. One high-quality
        read is sufficient; weaker CV readings need repeated agreement. Any
        transition gap additionally needs observed two-sided visual continuity.
        """
        event = self.active
        while self.pre_clock and intro_ms-self.pre_clock[0][0]['at_ms'] > 8000:
            self.pre_clock.popleft()
        if not self.pre_clock or intro_ms-self.pre_clock[-1][0]['at_ms'] > 8000:
            return
        if self.pre_clock[-1][0]['at_ms']-self.pre_clock[0][0]['at_ms'] > 6000:
            return
        phase_bridge = self.run_observation.phase_bridge(self.pre_clock[-1][0]['at_ms'],intro_ms)
        if not phase_bridge:
            return
        source, observation = self.pre_clock[-1]
        region = observation.get('clock_region')
        if not self._valid_clock_region(region, source):
            return
        if any(not self._valid_clock_region(o.get('clock_region'), s)
               or max(abs(a-b) for a,b in zip(o['clock_region'],region)) > source['source_height']*.03
               for s,o in self.pre_clock):
            return
        event['_prefight_proven'] = True
        event['_phase_anchor_ms'] = intro_ms
        event['_phase_bridge'] = phase_bridge
        bridge_times = phase_bridge['samples']
        phase_samples = [{'at_ms':t} for t in bridge_times]+[{'at_ms':intro_ms}]
        for saved in self.pre_scene:
            if saved['at_ms'] in bridge_times:
                self._remember(saved)
        for saved, _ in self.pre_clock:
            self._remember(saved)
        for field in FIELDS:
            supported = [(s,o) for s,o in self.pre_clock if valid_field(field,o.get(field))]
            if not supported or len({o[field] for _,o in supported}) != 1:
                continue
            # Only use a field actually read in the selected source, never move
            # an older value onto the latest picture where that field is null.
            selected,obs = supported[-1]
            infos = obs.get('evidence',{})
            info = infos.get(field,{}) if isinstance(infos,dict) else {}
            if not isinstance(info,dict) or not self._valid_region(info.get('region'),selected):
                continue
            quality = self._confidence(info.get('confidence'))
            if len(supported) == 1 and (quality is None or quality < .90):
                continue
            event[field] = obs[field]
            event['_clock_initial_values'][field] = obs[field]
            method = str(info.get('method','local-clock'))[:128]
            event['field_evidence'][field] = self._evidence(selected,info['region'],method,'pre_fight',
                'owned_pre_intro_field;verified_intro_phase_anchor;'+('repeated_agreement' if len(supported)>1 else 'single_quality_ge_090'),
                self._confidence(info.get('confidence')) if method.startswith('paddle') else None,
                samples=[{'at_ms':s['at_ms']} for s,_ in supported]+phase_samples)
        if event['igd'] is None:
            event['_clock_fallback_ms'],event['_clock_region'] = source['at_ms'],region
            event['_clock_fallback_samples'] = [{'at_ms':s['at_ms']} for s,_ in self.pre_clock]+phase_samples

    def _hero_candidate(self, source, frame, location):
        event = self.active
        if event['_hero_seen'] >= 4 or source['at_ms']-event['anchor_ms'] > 8000:
            return
        event['_hero_seen'] += 1
        # Compare artwork, not OCR or the nameplate. Full-height pixels are still
        # passed to the model; only this quality measurement excludes lower text.
        art = cv2.resize(frame,(96,54),interpolation=cv2.INTER_AREA)[:36].astype(np.float32)
        previous = event['_hero_previous']
        event['_hero_previous'] = (source['at_ms'],art,source)
        self._remember(source)
        if previous is None or source['at_ms']-previous[0] > 4000:
            return
        change = float(np.abs(art-previous[1]).mean())
        upper = frame[:frame.shape[0]*2//3]
        sharpness = float(cv2.Laplacian(cv2.cvtColor(upper,cv2.COLOR_BGR2GRAY),cv2.CV_32F).var())
        if change > 18 or art.std() < 15 or sharpness < 20:
            return
        quality = (-change,sharpness)
        if event['_hero_quality'] is None or quality > event['_hero_quality']:
            event['_hero_quality'],event['_hero_ms'] = quality,source['at_ms']
            event['_hero_previous_ms'] = previous[0]
            event['_hero_selection'] = {'method':'two_adjacent_stable_intro_art_frames',
                'previous_ms':previous[0],'change_mad':change,'laplacian_variance':sharpness}
            self._remember(source)
            self._remember(previous[2])

    def _intro(self, source, frame, location):
        event = self.active
        event['_last_intro_ms'] = source['at_ms']
        if len(event['_images']) >= 15 and source['at_ms'] not in event['_images']:
            event['_evidence_budget_abstentions'] = event.get('_evidence_budget_abstentions',0)+1
            return
        self._hero_candidate(source,frame,location)
        if location['score'] > event['_rank_score']:
            event['_rank_score'] = location['score']
            event['detected_rank'] = location['rank']
            self._remember(source)
            event['field_evidence']['rank'] = self._evidence(
                source, location['rank_region'], 'spatial-masked-rank-480', 'intro', 'strongest_rank_template',
                raw_text=json.dumps({k: location.get(k) for k in ('template', 'template_scale', 'score')})[:1024])
        if event['_intro_reads'] >= 4 or source['at_ms'] - event['anchor_ms'] > 8000:
            return
        event['_intro_reads'] += 1
        try:
            read = self.processor.read_full_name(frame, location)
        except Exception:
            self.logger.warning('Optional name extraction failed', exc_info=True)
            read = {'username': None, 'confidence': None, 'name_state': 'unreadable', 'raw_text': '',
                    'method': 'native-english-ocr-failed'}
        state = read['name_state']
        # A verified mask dominates contradictory ordinary OCR, not a first-read lock.
        # Prefer actual observed text over empty uncertainty, irrespective of
        # its OCR score. A verified mask remains authoritative for this intro.
        quality = (5 if state == 'masked' else 4 if state == 'complete' and read.get('username')
                   else 2 if read.get('username') else 1 if state in ('partial', 'obstructed') else 0,
                   read.get('confidence') or 0.)
        if quality > event['_name_quality']:
            event['_name_quality'] = quality
            event.update({key: read[key] for key in ('username', 'confidence', 'name_state')})
            # Extraction retains observed fragments. Search policy belongs to
            # the backend; only an actual mask or absent text has no name.
            if state == 'masked' or not event['username']:
                event['username'], event['confidence'] = None, None
            elif len(event['username'].encode('utf-16-le')) // 2 > 128:
                # Preserve a bounded observed prefix, never drop the encounter
                # because noisy OCR exceeded the publisher's text limit.
                event['username'] = event['username'].encode('utf-16-le')[:256].decode('utf-16-le', errors='ignore')
                event['name_state'] = 'obstructed'
            raw = read.get('raw_text', '')
            event['_name_observation'] = {'username': read.get('username'), 'raw_text': raw,
                                          'ocr_regions': read.get('ocr_regions'),
                                          'at_ms': source['at_ms']}
            event['_intro_ms'] = source['at_ms']
            self._remember(source)
            event['field_evidence']['encounter'] = self._evidence(
                source, location['rank_region'], 'spatial-masked-rank-480', 'intro',
                f'selected_full_intro;immutable_first_owned_anchor_ms={event["anchor_ms"]}')
            region = read.get('region') or location.get('name_region') or location['rank_region']
            event['field_evidence']['username'] = self._evidence(
                source, region, read['method'], 'intro', 'best_of_bounded_intro_window',
                read.get('confidence'), raw_text=bounded_name_evidence(raw))

    def _clock(self, source, observation):
        event = self.active
        if event['_clock_closed'] or source['at_ms'] - event['anchor_ms'] > 30000:
            return
        visible = observation.get('visible') is True
        # Never reopen after a visibility break or explicit result/menu phase.
        if observation.get('phase') in ('post_fight', 'menu', 'loading'):
            event['_clock_closed'] = True
            return
        if not visible:
            for readings in event['_clock_reads'].values():
                readings.clear()
            event['_visible_clock_reads'].clear()
            if event['_clock_started']:
                event['_clock_closed'] = True
            return
        if (not event['_clock_started']
                and source['at_ms'] - event['_last_intro_ms'] > 8000):
            event['_clock_closed'] = True
            return
        event['_clock_started'] = True
        if event['_first_clock_ms'] is None:
            event['_first_clock_ms'] = source['at_ms']
        elif source['at_ms'] - event['_first_clock_ms'] > 8000:
            event['_clock_closed'] = True
            return
        region = observation.get('clock_region')
        if not self._valid_clock_region(region, source):
            return
        if len(event['_images']) >= 15 and source['at_ms'] not in event['_images']:
            return  # Bound optional evidence retention, never discard an encounter.
        if observation.get('phase') != 'pre_fight':
            # The single-frame reader deliberately does not claim phase. Do not
            # turn a stable *post-result* clock into fresh pre-fight observations.
            # A preceding pre-intro proof already carries any accepted values.
            if not event.get('_prefight_proven'):
                infos = observation.get('evidence', {})
                infos = infos if isinstance(infos,dict) else {}
                for field in FIELDS:
                    if valid_field(field,event[field]):
                        continue
                    info = infos.get(field,{})
                    if isinstance(info,dict) and self._valid_region(info.get('region'),source):
                        self._remember(source)
                        event['field_evidence'][field] = self._evidence(source,info['region'],
                            'local-clock-phase-unknown','unknown','visible_clock_without_prefight_phase_proof',
                            raw_text=json.dumps({'observed_value':observation.get(field)},default=str)[:1024])
                self._prune()
            return
        # A changed accepted counter indicates a later state, not missing intro
        # evidence. Never fill another field from this post-fight transition.
        for field in FIELDS:
            value = observation.get(field)
            if not valid_field(field, value):
                continue
            if field in event['_clock_initial_values'] and value != event['_clock_initial_values'][field]:
                # Even a change *before* consensus may be a battle result. Do
                # not restart consensus on a newly increased win/day counter.
                event['_clock_closed'] = True
                return
            event['_clock_initial_values'].setdefault(field, value)
        visible_reads = event['_visible_clock_reads']
        if visible_reads and (source['at_ms'] - visible_reads[-1]['at_ms'] > 4000
                or max(abs(a-b) for a, b in zip(visible_reads[-1]['region'], region)) > source['source_height']*.03):
            visible_reads.clear()
        visible_reads.append({'at_ms': source['at_ms'], 'region': region})
        # Fallback requires repeated registered visibility, not a single OCR miss.
        if len(visible_reads) == 3 and event['igd'] is None:
            event['_clock_fallback_ms'] = source['at_ms']
            event['_clock_region'] = region
            event['_clock_fallback_samples'] = [{'at_ms': r['at_ms']} for r in visible_reads]
        self._remember(source)
        field_info = observation.get('evidence', {})
        if not isinstance(field_info, dict):
            field_info = {}
        for field in FIELDS:
            if valid_field(field,event[field]):
                continue
            value = observation.get(field)
            info = field_info.get(field, {})
            if not isinstance(info, dict):
                info = {}
            readings = event['_clock_reads'][field]
            if not valid_field(field, value) or not self._valid_region(info.get('region'), source):
                readings.clear()
                continue
            if readings and (readings[-1][0] != value or source['at_ms'] - readings[-1][1]['at_ms'] > 4000):
                readings.clear()
            method = str(info.get('method', 'local-clock'))[:128]
            evidence = self._evidence(source, info['region'], method,
                                      'pre_fight', 'three_agreeing_visible_reads_after_intro',
                                      self._confidence(info.get('confidence')) if method.startswith('paddle') else None)
            readings.append((value, evidence))
            if len(readings) == 3 and not valid_field(field,event[field]):
                event[field] = value
                evidence['samples'] = [{'at_ms': e['at_ms']} for _, e in readings]
                event['field_evidence'][field] = evidence
                readings.clear()
        if event['igd'] is not None:
            event.pop('_clock_fallback_ms', None)
            event.pop('_clock_fallback_samples', None)
            visible_reads.clear()
        self._prune()

    @staticmethod
    def _confidence(value):
        return float(value) if type(value) in (float, int) and math.isfinite(value) and 0 <= value <= 1 else None

    @staticmethod
    def _valid_region(region, source):
        if not isinstance(region, (list, tuple)) or len(region) != 4 or not all(type(x) is int for x in region):
            return False
        x, y, w, h = region
        return 0 <= x < source['source_width'] and 0 <= y < source['source_height'] and 0 < w <= source['source_width']-x and 0 < h <= source['source_height']-y

    @classmethod
    def _valid_clock_region(cls, region, source):
        # ClockReader projects the canonical 205x275 context. Reject obviously
        # clipped/tight-day/broad-left-third boxes before optional paid fallback.
        return cls._valid_region(region,source) and abs(region[2]/region[3]-205/275) <= .06

    def consume(self, jpeg, at_ms):
        if type(at_ms) is not int or at_ms < 0 or len(jpeg) > MAX_JPEG_BYTES:
            raise ValueError('Sample exceeds timestamp/JPEG bounds')
        if self.last_ms is not None and at_ms <= self.last_ms:
            raise ValueError('Sample timestamps must strictly advance')
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError('Could not decode full-context JPEG')
        H, W = frame.shape[:2]
        if W > 3840 or H > 2160:
            raise ValueError('Full-context source exceeds supported dimensions')
        location = self.processor.locate_full_frame(frame)
        return self._analyze(jpeg, at_ms, frame, location)

    def _analyze(self, jpeg, at_ms, frame, location):
        H, W = frame.shape[:2]
        observation = {}
        if self.clock is not None:
            try:
                observation = self.clock.observe(frame) or {}
                if not isinstance(observation, dict):
                    observation = {}
            except Exception:
                self.logger.warning('Optional clock extraction failed', exc_info=True)
        visible = observation.get('visible') is True
        scene = None
        if (not visible and location is None and self._scene_attempts < 64
                and self.run_observation.needs_scene_read(frame) and getattr(self.processor,'reader',None) is not None):
            # A native English "Day N" interstitial may bridge a normal day
            # animation, but NEVER supplies/corrects a canonical encounter day.
            # The returning registered clock must independently read exactly N.
            self._scene_attempts += 1
            x,y,w,h = W//2,H//3,W-W//2,H//3
            try:
                raw = tokens(self.processor.reader,frame[y:y+h,x:x+w])
                candidates = [(re.fullmatch(r'Day\s*([1-9]|1[0-9]|20)',t.strip(),re.I),q) for t,q in raw]
                accepted = [(int(m[1]),q) for m,q in candidates if m and q >= .90]
                if len(accepted)==1:
                    scene = {'kind':'day_transition','day':accepted[0][0],
                             'region':[x,y,w,h],'raw_text':json.dumps(raw)[:1024],
                             'method':'native_english_day_interstitial_not_canonical_day'}
            except Exception:
                self.logger.warning('Optional continuity scene OCR failed',exc_info=True)
        self._last_run_scene = scene
        previous_epoch = self.continuity_epoch
        self.continuity_epoch = self.run_observation.observe(at_ms,frame,intro=location is not None,clock=observation,scene=scene)
        split = self.continuity_epoch != previous_epoch
        self.last_ms = at_ms
        if split or (self.pre_clock and at_ms-self.pre_clock[-1][0]['at_ms'] > 8000):
            self.pre_clock.clear()
        if split:
            self.pre_scene.clear()
            if self.active and location:
                self.active['_continuity_ambiguous'] = True
        output = []
        if self.active and (at_ms - self.active['anchor_ms'] > 30000
                            or observation.get('continuity_signal') in ('run_end', 'menu', 'loading')):
            output.extend(self.flush())
        source = self._source(jpeg, at_ms, frame, 'intro' if location else 'clock')
        if location:
            if not self.intro_present:
                if self.active:
                    output.extend(self.flush())
                self._new(source, location)
            self.intro_present, self.misses = True, 0
            if self.active:
                self._intro(source, frame, location)
                self._prune()
        else:
            self.misses += 1
            if self.misses >= 2:
                self.intro_present = False
            if self.active:
                self._clock(source, observation)
            elif (visible and self.start_ms <= at_ms < self.end_ms
                  and observation.get('phase') not in ('post_fight','menu','loading')):
                self.pre_clock.append((source,observation))
        if location:
            self.pre_clock.clear()
            self.pre_scene.clear()
        elif self.active is None and self.start_ms <= at_ms < self.end_ms:
            self.pre_scene.append(source)
        return output

    def flush(self):
        if self.active is None:
            return []
        event, self.active = self.active, None
        event['_continuity_segment'] = f'{self.chunk_id}:{event["_epoch"]}'
        # Continuity is snapshotted at the introduction, not at a later OCR
        # timeout/result. A run ending after this fight affects the NEXT event.
        event['_continuity_supported'] = bool(event.get('_prefight_proven') and not event.get('_continuity_ambiguous'))
        event['_clock_reads'] = {}  # Deques/working observations never enter the queue.
        event['_visible_clock_reads'] = []
        event.pop('_hero_previous',None)
        return [event]


class BufferedEncounterPipeline(EncounterPipeline):
    """Locate intros continuously; read clock fields only around an encounter.

    Retain at most four raw pre-intro samples (eight seconds at 0.5fps), then
    replay them through the same evidence selector. No clock search/OCR or run
    tracking is needed during idle gameplay. After the 30s evidence window,
    skip CV until 90s from the first owned intro, not 90s from publication.
    The decoder still validates every source timestamp and drains every sample.
    """
    COOLDOWN_MS = 90000
    PREFIGHT_MS = 8000

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pending_frames = deque(maxlen=4)
        self.last_input_ms = None
        self.resume_ms = 0
        self.stats = {'samples': 0, 'cooldown_samples': 0, 'locator_samples': 0,
                      'evidence_samples': 0, 'buffer_replays': 0}

    def _reset_window(self):
        self.pre_clock.clear()
        self.pre_scene.clear()
        self.run_observation = ObservedRun()
        self.continuity_epoch = 0
        self.intro_present = False
        self.misses = 0

    def _selected(self, jpeg, at_ms, frame, location):
        self.stats['evidence_samples'] += 1
        return self._analyze(jpeg, at_ms, frame, location)

    def consume(self, jpeg, at_ms):
        if type(at_ms) is not int or at_ms < 0 or len(jpeg) > MAX_JPEG_BYTES:
            raise ValueError('Sample exceeds timestamp/JPEG bounds')
        if self.last_input_ms is not None and at_ms <= self.last_input_ms:
            raise ValueError('Sample timestamps must strictly advance')
        self.last_input_ms = at_ms
        self.stats['samples'] += 1
        output = []
        if self.active and at_ms - self.active['anchor_ms'] > 30000:
            output.extend(self.flush())
        if self.active is None and at_ms < self.resume_ms:
            self.stats['cooldown_samples'] += 1
            return output
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError('Could not decode full-context JPEG')
        H, W = frame.shape[:2]
        if W > 3840 or H > 2160:
            raise ValueError('Full-context source exceeds supported dimensions')
        self.stats['locator_samples'] += 1
        location = self.processor.locate_full_frame(frame)
        if self.active:
            output.extend(self._selected(jpeg, at_ms, frame, location))
        elif location:
            # Preserve a preroll intro across the ownership boundary, but never
            # use an unowned introduction to start the cooldown for this chunk.
            was_intro = self.intro_present
            self._reset_window()
            self.intro_present = was_intro
            for saved, timestamp in self.pending_frames:
                if at_ms - timestamp <= self.PREFIGHT_MS:
                    prior = cv2.imdecode(np.frombuffer(saved, np.uint8), cv2.IMREAD_COLOR)
                    self.stats['buffer_replays'] += 1
                    output.extend(self._selected(saved, timestamp, prior, None))
            self.pending_frames.clear()
            output.extend(self._selected(jpeg, at_ms, frame, location))
        else:
            self.misses += 1
            if self.misses >= 2:
                self.intro_present = False
            self.pending_frames.append((jpeg, at_ms))
        if self.active:
            self.resume_ms = self.active['anchor_ms'] + self.COOLDOWN_MS
        return output


def _raw_result(response):
    if not isinstance(response, dict) or response.get('status') not in ('ok', 'completed', 'success'):
        return None
    value = response.get('result')
    if isinstance(value, str):
        text = value.strip()
        if text.startswith('```'):
            text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text)
        try:
            value = json.loads(text)
        except (ValueError, TypeError, RecursionError):
            return None
    return value if isinstance(value, dict) else None


def parse_hero(response, role):
    value = _raw_result(response)
    if value is None:
        return None, None
    answer = value
    if isinstance(value.get('answers'), dict):
        answer = value['answers'].get('hero')
        if not isinstance(answer, dict) or answer.get('type') != 'choice':
            return None, None
    hero = answer.get(role, answer.get('hero', answer.get('choice')))
    if isinstance(hero, str):
        hero = hero.lower().replace(' ', '_')
    if (not isinstance(hero, str) or hero not in HEROES
            or any(data.get(key) is False for data in (value, answer) for key in ('reliable', 'visible'))
            or any(key in data and type(data[key]) is not bool for data in (value, answer)
                   for key in ('reliable', 'visible'))):
        return None, None
    probabilities = answer.get('probabilities')
    if not isinstance(probabilities, dict):
        return None, None
    if isinstance(probabilities, dict):
        scores = {k.lower().replace(' ', '_'): EncounterPipeline._confidence(v)
                  for k, v in probabilities.items() if isinstance(k, str) and k.lower().replace(' ', '_') in HEROES}
        if len(probabilities) != len(HEROES) or len(scores) != len(HEROES) or any(v is None for v in scores.values()) or abs(sum(scores.values())-1) > .01:
            return None, None
        ordered = sorted(scores.values(), reverse=True)
        if max(scores, key=scores.get) != hero or scores[hero] < .60 or ordered[0]-ordered[1] < .30:
            return None, None
        confidence = scores[hero]
    # Frozen exploratory guard for BOTH roles, not calibrated accuracy. A known
    # overlay/skin counterexample still passes it and remains documented tuning work.
    return hero, confidence


class EncounterEnricher:
    """Result-worker-only paid work. One attempt per role, no automatic retry."""
    def __init__(self, backend):
        self.backend = backend
        self.attempts = 0
        self.logger = logging.getLogger('sfde.enrichment')

    @staticmethod
    def _png(source, region):
        frame = cv2.imdecode(np.frombuffer(source['jpeg'], np.uint8), cv2.IMREAD_COLOR)
        x, y, w, h = region
        image = frame[y:y+h, x:x+w]
        scale = min(1., 640 / max(image.shape[:2]))
        if scale < 1:
            image = cv2.resize(image, (max(1, round(w*scale)), max(1, round(h*scale))), interpolation=cv2.INTER_AREA)
        success, encoded = cv2.imencode('.png', image)
        if not success:
            raise ValueError('Could not encode inference evidence')
        # The server accepts <=1 MiB. Very noisy full-height halves can exceed
        # that even at 640px; shrink deterministically, never upscale or crop.
        for _ in range(3):
            if encoded.nbytes <= 1024*1024:
                break
            h,w = image.shape[:2]
            image = cv2.resize(image,(max(1,int(w*.9)),max(1,int(h*.9))),interpolation=cv2.INTER_AREA)
            success,encoded = cv2.imencode('.png',image)
            if not success:
                raise ValueError('Could not encode bounded inference evidence')
        if encoded.nbytes > 1024*1024:
            raise ValueError('Inference evidence exceeds 1 MiB')
        return base64.b64encode(encoded.tobytes()).decode()

    def _infer(self, event, task, source, region):
        if self.attempts >= 64 or event.get('_paid_attempts', 0) >= 4:
            return None
        # Reserve client attempts before submission; failed/ambiguous calls count.
        self.attempts += 1
        event['_paid_attempts'] = event.get('_paid_attempts', 0) + 1
        request_id = str(uuid5(NAMESPACE_URL, f'{event["id"]}:{task}:{source["at_ms"]}:v1'))
        started = time.monotonic()
        try:
            response = self.backend.infer(event['chunk_id'], request_id=request_id, task=task,
                                          at_ms=source['at_ms'], image_base64=self._png(source, region))
            info = response if isinstance(response,dict) else {}
            event.setdefault('_inference_audit', []).append({
                'task': task, 'request_id': request_id, 'at_ms': source['at_ms'],
                'status': str(info.get('status','unknown'))[:64], 'cached': info.get('cached') is True,
                'model': str(info.get('model','unknown'))[:128],
                'prompt_version': str(info.get('prompt_version','unknown'))[:128],
                'usage': json.dumps(info.get('usage'),ensure_ascii=False,default=str)[:1024],
                'latency_ms': round((time.monotonic()-started)*1000),
                'response': json.dumps(response, ensure_ascii=False, default=str)[:4096]})
            return response
        except Exception:
            event.setdefault('_inference_audit', []).append({
                'task': task, 'request_id': request_id, 'at_ms': source['at_ms'], 'status': 'failed_or_uncertain',
                'latency_ms': round((time.monotonic()-started)*1000)})
            self.logger.warning('Optional %s inference failed; preserving encounter', task, exc_info=True)
            return None

    def enrich(self, event):
        self._enrich_day(event)
        hero_ms = event.get('_hero_ms')
        source = event['_images'][hero_ms if hero_ms is not None else event['_intro_ms']]
        W, H = source['source_width'], source['source_height']
        for role, region in [('ghost_hero', [W//2, 0, W-W//2, H]), ('streamer_hero', [0, 0, W//2, H])]:
            response = self._infer(event, role, source, region)
            hero, confidence = parse_hero(response, role)
            if hero is None:
                event['field_evidence'][role] = EncounterPipeline._evidence(
                    source, region, 'fixed-task-inference-unknown', 'intro', 'unknown_or_failed_optional_inference',
                    raw_text=json.dumps(response, ensure_ascii=False, default=str)[:1024])
                continue
            event[role] = hero
            evidence = EncounterPipeline._evidence(source, region, 'fixed-task-inference', 'intro',
                        ('stable_intro_full_height_max640' if hero_ms is not None
                         else 'selected_intro_full_height_max640_no_stable_pair')
                        + ';exploratory_top060_margin030_uncalibrated', None,
                       model=str(response.get('model', 'unknown'))[:128],
                       prompt_version=str(response.get('prompt_version', 'unknown'))[:128],
                       raw_text=json.dumps(response.get('result'), ensure_ascii=False)[:1024])
            event['field_evidence'][role] = evidence
            if event.get('_hero_previous_ms') is not None:
                evidence['samples'] = [{'at_ms':event['_hero_previous_ms']},{'at_ms':hero_ms}]
        return event

    def _enrich_day(self, event):
        if event['igd'] is None and event.get('_clock_fallback_ms') is not None:
            clock = event['_images'][event['_clock_fallback_ms']]
            region = event['_clock_region']
            response = self._infer(event, 'clock_day', clock, region)
            value = _raw_result(response)
            day = value.get('igd', value.get('day')) if value else None
            if value and isinstance(value.get('answers'), dict):
                answer = value['answers'].get('day')
                day = answer.get('value') if isinstance(answer, dict) and answer.get('type') == 'number' else None
            if value and (value.get('truncated') is True or value.get('visible') is False):
                day = None
            if valid_field('igd', day):
                event['igd'] = day
                event['field_evidence']['igd'] = EncounterPipeline._evidence(
                    clock, region, 'fixed-task-clock-day-inference', 'pre_fight',
                    'visible_registered_clock_local_day_unknown', model=str(response.get('model', 'unknown'))[:128],
                    prompt_version=str(response.get('prompt_version', 'unknown'))[:128],
                    raw_text=json.dumps(response.get('result'), ensure_ascii=False)[:1024])
                event['field_evidence']['igd']['samples'] = event.get('_clock_fallback_samples', [])
        return event
