# Hero skin prompt validation

The `hero-skins-v2` candidate identifies every image in the optimized 738-image development corpus correctly with real Clef Flash inference. The candidate preserves one image and one request per hero role. Deployment and hosted-canary verification are tracked separately below.

## Corpus

The installed Steam build is `25914521`. All 133 skin bundles were scanned. Hero ownership comes from the installed `Art/Heroes` asset directories, with SkinData and collectible metadata retained when present.

| Population | Images | Coverage |
| --- | ---: | --- |
| Installed reference views | 521 | 177 image identities, including one Karnok creature form |
| Historical reference views | 119 | Older skin artwork and supplemental references |
| Recent gameplay | 90 | Both roles in 45 October 29 validation encounters |
| Historical gameplay | 8 | Stable regression cases from other recordings |
| Total | 738 | Eight playable heroes |

The 177 installed identities represent 176 cosmetic identities plus the creature form, not 177 playable heroes. Alternate portraits and previews are separate image views, not independent skins. Every one of the 109 skin records in the installed collectible database has an image in the inventory. Installed presence does not establish current shop availability.

Three skins lack store images and use portrait fallbacks. Pygmalien `10b` lacks SkinData but has images and a collectible entry. Stelle `08a` and `08b` share an erroneous internal metadata name and remain separate directory-backed identities. Seven historical references can overlap installed appearances without a verified exact skin ID.

All 90 recent gameplay roles and eight historical cases were visually matched to installed skins. The review resolved eight previously uncertain identities and confirmed 15 medium-confidence labels without changing any existing non-null hero label. The mapping is asset-backed AI visual review, not human adjudication.

Artwork uses a 640-pixel maximum edge and neutral RGB 32 alpha background. Gameplay uses the existing SFDE full-height role halves and actual encoder. No extra crop, image, or OCR pass enters the runtime path. Original source hashes and prepared input hashes are retained. Licensed extracted artwork stays local.

## Optimization results

The initial comparison reproduced the current pipeline's five incorrect first choices among 82 provisionally labeled recent roles. The baseline accepted 46 of those roles, including one wrong result.

| Candidate | Recent gameplay raw correct | Reference raw correct | Historical raw correct |
| --- | ---: | ---: | ---: |
| Existing prompt | 77/82 | Not rerun | Historical responses retained separately |
| Concise species prompt | 77/82 | Not run | Not run |
| Species v3 | 82/82 | 179/184 selected references | Not run |
| Species v4 | 82/82 | 183/184 selected references | Not run |
| Species v5 | 82/82 | 183/184 selected references | Not run |
| Species v6 | 90/90 | 633/640 all views | 7/8 |
| Selected v7 | 90/90 | 640/640 all views | 8/8 |

The selected prompt fixes observed cosmetic transformations and portrait ambiguities. These include mounted Pygmalien explorers, a robot riding a dragon, a woman piloting a multi-arm exosuit, cropped Jules portraits, and the green-coated Pygmalien obscured by an overlay. Every request uses the same global prompt. Labels, filenames, and per-image identities do not enter the request.

The selected prompt file SHA-256 is `fb6f8dd45c3a0eaaa2eee6a358b66c7c6a72bd1f1a6a08bb4a51355961026970`. The Worker also hashes the serialized native prompt for its response version.

## Acceptance settings

The selected settings are top probability at least **0.33** and top-two margin at least **0.05**, identically for both roles. All 738 raw choices are correct, and all pass these settings. The observed minima are 0.3348 top probability and 0.0554 margin. Recent gameplay alone has minima 0.4357 and 0.1342.

These cutoffs are fitted to the development corpus. They are not calibrated probability guarantees. Unknowns do not count as correct. All existing malformed-distribution, invalid-value, normalization, and choice/argmax checks remain required.

The historical `.60/.30` policy and saved responses remain immutable evidence. Replaying old responses with new cutoffs is threshold sensitivity, not an evaluation of the new prompt. New prompt results are stored separately.

## Processing cost

The selected corpus pass used 738 real requests and 869,662 input tokens, approximately $0.03305 at the API-reported rate. Mean observed latency was 575 ms and p95 was 856 ms at concurrency four. A zero-call replay reproduced all results from cached provider responses.

A separate uncached repeat made another 738 real requests. All 738 choices were correct and passed the selected thresholds. Every probability distribution matched the first pass exactly.

The evaluator originally sorted JSON keys while the Worker preserves contract insertion order. A third, fresh 738-request pass used the exact production ordering and contract. All choices and distributions matched the earlier passes and passed the selected thresholds. The native serialized-prompt SHA-256 is `4a07560812b9940566ff1dd556975f730f58d498cb02ec899231167cb752ba6c`.

Recent-gameplay input tokens increase from roughly 790 to 1,067 per request. The additional prompt text does not add SFDE frame processing, OCR, image resolution, or model requests. The two hero calls cost about $0.000081 per encounter at the measured token count and API-reported rate. Remote API latency is distinct from container CPU and memory use.

A fresh latency comparison used the same 24 gameplay images across all eight heroes, with concurrency two for each prompt. Baseline median latency was 481 ms and p95 was 800 ms. The selected prompt's median was 527 ms and p95 was 854 ms. This small network measurement adds about 47 ms per request at the median, rather than an extra model call. It is not a container CPU or memory benchmark.

## Verification status

- Main independently reconstructed and verified all 738 request hashes and provider distributions against the saved results.
- An independent reviewer checked all 640 reference image hashes and confirmed corpus ownership and coverage limits.
- A fresh uncached repeat passed all 738 rows with identical distributions.
- A separate production-order pass passed all 738 rows with identical distributions.
- Worker tests passed 583 cases. Script tests passed 234 cases with one opt-in skip. Typecheck and local build passed.
- An independent review found no code blocker. Its serialization-order concern was resolved by the production-order pass.
- The full network-disabled Python suite passed 900 tests with one opt-in skip.
- Validation deployment and its hosted processing canary are pending.

All successful results are development-corpus agreement after iterative optimization. Repeated skin views and repeated appearances in two recordings are correlated. A hosted canary checks the deployed system separately and does not turn this corpus into a heldout accuracy estimate.

## Local evidence

The local run directory is `/tmp/opencode/hero-clef-optimization/`.

- `corpus/HANDOFF.json`, `coverage.json`, and `verification.json` describe extraction and coverage.
- `gameplay/asset-review/REPORT.md` and `asset-backed-labels.json` retain visual mappings and provenance.
- `optimizer/candidate-v7.json` is the exact selected native prompt.
- `optimizer/runs/v7-all-738/` retains distributions, thresholds, hashes, and cost.
- `optimizer/verify_winner.py` reconstructs provider request hashes and verifies correctness and acceptance.
- `decisions.tsv` and `optimizer/decisions.tsv` record decisions and rejected candidates.

To verify the selected saved run without new inference:

```sh
cd /tmp/opencode/hero-clef-optimization/optimizer
python verify_winner.py --run runs/v7-all-738 --prompt candidate-v7.json --top .33 --margin .05
```
