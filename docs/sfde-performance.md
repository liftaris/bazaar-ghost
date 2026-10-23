# NEXT processing time and encounter scheduling

## 2026-10-22: chunk-boundary failures and recorded freezes

A read-only validation snapshot contained 44 contemporary failed chunks across
17 VODs/11 streamers: 41 rejected opening timestamps and three rejected a
two-second interval between source frames. Historical preparation failures were
excluded. Examples explain why neighbouring chunks of the same VOD differed:

- Yosi14jp `2906665850`: opening chunk completed; all six later chunks failed.
- Christofermorn `2907000824`: opening chunk completed; three later chunks failed.
- The_moistbread `2907124267`: only the chunk containing the source freeze failed.

Direct HLS input seeks can begin at the next keyframe. At Yosi's 3600s boundary,
the original command began at 3600.991333s. Decoding eight seconds earlier and
trimming on decoded timestamps recovered the opening frame at 3600.025333s.
The decoder now uses this bounded seek lead, preserving the requested timeline
rather than rebasing the first available frame to zero. The existing pre-intro
buffer remains separate from chunk ownership.

The old opening assertion allowed only one nominal 30/60fps source frame. Actual
VFR boundaries also showed harmless 32–50ms variation. Opening support now uses
the nearest-frame sampling cadence; the sampled timestamp grid remains checked.

The_moistbread and Rahresh's two-second intervals were explicitly declared held
frames, not missing video. Source timing now reads frame duration before setpts
can erase it. Merimides had a real two-second source gap. Per the user's decision,
gaps in the recording are reported without failing/retrying the entire chunk:
`source_gap_count`, `max_source_gap_seconds`, and
`completion_reason=requested_range_with_source_gaps` identify this output.
Decoder errors, invalid/nonmonotonic timestamps and unsupported premature EOF
still fail. FPS may repeat a source frame over a recorded freeze, as playback does.

Validation: all 44 exact failure locations passed read-only source replays,
including the separate pre-intro ranges. Three full formerly failing 30-minute
chunks (Yosi, Christofer, Moistbread) produced all 900 expected samples each.
These were decoder-only checks, with no backend mutations or paid requests.
The complete offline suite passed 810 tests with one opt-in skip.

Detailed logs, source timing, initial failures and replay manifests are retained
under `.ignore/sfde-next/failure-name-investigation/`.

## 2026-10-22: readable clocks after the intro

The user confirmed that clock readings during the associated fight are useful;
day does not require pre-fight phase proof. The normal single-frame ClockReader
does not classify phase, so requiring `phase=pre_fight` had discarded readable
combat values. Twelve reviewed saved pictures showed battle reveal/combat, not
reward/shop screens, with visually consistent day readings.

The selector now keeps the first valid local reading of each missing clock
field within its existing encounter window. It records the original picture,
region, reading method and value, and retains `phase=unknown` when the reader
has not classified phase. It does not relabel combat evidence as pre-fight,
require three repeating reads, or introduce additional clock-model requests.
Existing accepted values are retained. Pre-intro selection remains available.

Local verification: 800 tests passed, one opt-in test skipped. A source-overlay
cached-video smoke test with real FFmpeg/CV/PaddleOCR retained the same two
encounters and four independent hero requests, taking 7.67s processor wall time.
HTTP/model responses were mocked; no paid requests were made. Detailed evidence
and the captured-image recovery audit live in `.ignore/sfde-next/clock-recovery/`.

## 2026-10-22: measured cooldown

Read-only analysis of 24 successful production (`main`) workflow runs yielded
638 detection log entries in 58 completed chunks, and 589 unique within-chunk
consecutive pairs across 20 VODs/streamers. We did not join unrelated chunks or
infer elapsed time across different VODs. 545 pairs had different observed names,
both OCR confidences >= .95, rank evidence, and no truncation flag.

The shortest distinct fights confirmed against source pixels:

| VOD | Streamer | Consecutive anchors | Gap |
|---|---|---|---|
| 2907124267 | the_moistbread | 5274 → 5384 | 110s |
| 2907124267 | the_moistbread | 642 → 756 | 114s |
| 2907124267 | the_moistbread | 2186 → 2300 | 114s |

Other gaps below 120s were checked rather than rejected solely by OCR score:

- `2907141614`, 484→494 and 816→826: repeated pictures of the same introductions.
  The second pair changed from `YaBoiThompso` to `YaBoiThompson` in the OCR log;
  the source still shows the same opponent.
- `2907070579`, 2576→2642: the second production result has .645 OCR confidence.
  Source frames 2638–2648 show rewards, fade and menu, not another PvP intro.

Use **90 seconds from the immutable first owned intro**, not from publication
or the end of its evidence window. This leaves 20 seconds before the shortest
confirmed next fight, including the eight-second pre-fight buffer. A 180-second
cooldown would overlap 109 distinct-name, high-confidence pairs in this sample
(excluding the verified duplicate). This is an observed-data tradeoff, not a
guarantee that a faster fight can never occur. Cuts, replays and future game
changes can invalidate it. A new chunk/retry starts without inherited cooldown.

Collected records, log hashes, pair statistics and source screenshots are retained
under `.ignore/sfde-next/skip-analysis/`. Production runs include `39693829041`,
`39697080948` and `39706427568`; all source checks are read-only, with no paid AI.

## Implementation

- Search five rank templates from the recording's known template era, at the
  existing height-normalized size. Do not search both eras at three scales.
- Remove the aspect-ratio early rejection. Native 896×480 Swordlless evidence
  now reaches matching without stretching source pixels or changing thresholds.
- `BufferedEncounterPipeline` retains at most four validated JPEG samples during
  idle gameplay. When an intro is found, replay the preceding eight seconds
  through the same local clock/evidence selector. Clock location, day OCR and
  wins/crown work happen around encounters rather than on every gameplay sample.
- Keep the existing 30-second evidence window, including independently selected
  hero/name inputs. Then drain decoded samples without CV until anchor+90s.
- FFmpeg still decodes and verifies timestamp coverage continuously. There is no
  dynamic seek/restart or false claim of decoded coverage over a skipped source
  range. `next_analysis_finished` reports the distinct sampled, cooldown,
  locator, evidence and buffer-replay counts.
- Pre-fight phase proof uses current buffered pixels, with fresh local context;
  neither clock values nor hero results are inherited from previous fights.

The clock's existing multiscale matcher is retained on selected samples.
`matchTemplate`'s normalized modes are not scale-invariant. Feature-based
registration such as SIFT would require separate accuracy/performance evidence.

## Matched local wall time

Same cached 480p30 source `2549030240`, range [2630,2820), two CPUs, 3 GiB,
95 owned samples plus four preroll samples. Packaged before/after runtime;
network disabled, shared PaddleOCR active, fake backend/model responses.
Both runs execute decoder, CV and publication threads concurrently.

| Measurement | Before | After |
|---|---:|---:|
| Processor elapsed wall time | 32.40s | 7.39s |
| Runtime including processor initialization | 33.62s | 8.39s |

Processor wall time improved 4.39× (77% reduction) on this clip. These are **not
summed chunk durations** and do not predict hosted workflow wall time: real API,
download, runner scheduling and image-build costs are excluded or mocked.

Both runs retain the same two anchors, usernames, name states, local day/wins/
lethal values and selected evidence timestamps. Four independent hero requests
are still made (fake responses here, not hero-accuracy evidence). Full source
coverage checks pass. After: 99 input samples, 29 cooldown samples, 70 locator
samples, 30 evidence samples including eight buffered replays.

Thirty existing frozen full-frame fixtures retain the same locator outcomes with
the five-template bank. Native 896×480 positive/negative regressions cover the
previously rejected rendition. Hosted workflow wall time and ongoing accuracy
must be observed after validation deployment; this local report is not hosted
performance evidence.
# Setup-to-output improvements

The October 22 hosted investigation measured 23m21s and 26m29s to finish two
recordings. These were spans across multiple workflow dispatches, not individual
processor jobs. Roughly seven minutes in each span had no queued or processing
chunk for that recording. Each chunk also rebuilt/loaded its own container.

Validation now publishes the runtime once, after the offline SFDE tests pass.
The deployment receives the OCI digest through `SFDE_RUNTIME_IMAGE`; dispatches
carry that digest and `BUILD_COMMIT`. Runners check out that processor revision,
pull the exact image, and verify its revision label. Advancing the branch cannot
silently pair untested code with an older runtime. The runtime includes the
existing FFmpeg, Paddle models, templates and contracts. There is no per-chunk
model installation or container build on this path. Manual/local workflows
without a published runtime retain their existing build path.

The prepare job caches Streamlink downloads, installs yt-dlp/Deno only for
YouTube, and skips resolver installation for local runs. Automatic workflow
matrices may run all globally reserved chunks concurrently; manual matrices
retain the four-job limit. The backend's existing atomic queued/processing cap
is still authoritative.

A terminal validation chunk enqueues a refill message after persisting its
result. The consumer prioritizes eligible pending chunks of that recording,
then other automatic candidates, using the same atomic slot reservations and
operator eligibility checks. Duplicate callbacks/messages cannot exceed the
global cap. Failed chunks retain the existing retry/backoff policy. The periodic
sweep remains the recovery path if a queue handoff fails.

Each successful chunk adds a `timing_<chunk-id>.json` artifact and job-summary
section with its runtime identity, image-pull seconds, queue-to-claim seconds,
reported processor milliseconds, and queue-to-completion seconds. Parallel job
durations must not be added together and presented as elapsed recording time.

Deployment sequence: the validation CI runs both test suites, publishes the
tested image, then deploys the Worker with its digest. A failed image publication
blocks deployment. The image is in the repository-linked GHCR package
`ghcr.io/liftaris/bazaar-ghost/sfde-next`; runners use `packages: read`, publishing
uses `packages: write`. Main/production is not part of this rollout.
