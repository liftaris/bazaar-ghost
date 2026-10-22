# SFDE validation checks

These are delivery targets, not measured results. Scope: PvP encounters, names,
streamer mode, heroes, day, wins remaining and the lethal crown. Battle outcomes
and starting boards are later work.

## Units and labels

- An encounter is one PvP introduction in one recording. Match outputs to labeled
  introduction intervals, one to one. Extra outputs are duplicates or false
  positives; unmatched introductions are misses. A masked name is still an encounter.
- A name is correct only when its complete visible text matches, including case
  and punctuation. Do not score a partial name as complete or guess hidden text.
- Label name state separately: complete, partial, obstructed, masked or unreadable.
  A mask is a visible masking pattern, not an OCR failure.
- Score ghost and streamer identification separately for each encounter. Each
  gets its own model call; streamer results are not reused between fights.
- Label clock fields at their own frame time and phase. Day is an integer; wins
  remaining is ten minus blue-filled boxes; lethal is the grey/cracked crown.
  Hidden fields are unknown. The crown is not the battle outcome.

For every field report: eligible labels, correct, wrong, unknown, and unsupported
values asserted on hidden/absent evidence. Exactness is correct / (correct + wrong).
Coverage is (correct + wrong) / eligible labels. Do not omit unknowns from coverage.
Report counts as well as percentages; an empty denominator is “not measured”.

## Test split

Freeze labels, image hashes and source times before inference. Tune on development
recordings. Hold out entire independent runs/recordings, grouping reuploads and
aligned copies together. Resized, shifted or obscured copies are stress tests, not
independent footage. Report results by recording, layout, obstruction and hero.

The validation corpus must include native low-resolution footage, a second layout,
repeated opponents, a same-hero run reset, chunk edges, real masks, both crown
states, and missing/obstructed clocks. Report wins coverage for every value 0–10
and hero coverage for all eight identities. Missing cases stay explicit gaps.

## Acceptance targets

| Check | Target |
| --- | --- |
| Encounter precision / recall | At least 99% / 95%; zero duplicates in boundary/retry regressions |
| Complete name exactness / coverage | At least 99% / 90% of fully visible eligible Latin-script names |
| Real mask precision / recall | 100% / at least 95%; no fabricated searchable names |
| Ghost and streamer hero exactness / coverage | At least 98% / 90%, scored separately |
| Day and wins exactness / coverage | At least 99% / 90% of clearly visible clocks, per field |
| Lethal exactness / coverage | At least 99% / 90%, report both classes separately |
| Field association | Zero cross-fight propagation in reviewed cases |
| Data integrity | Stable Matchup IDs; no lost social data, links, or valid field evidence |

All named regression cases must pass. Small samples establish regression evidence,
not statistical proof of these rates. Lack of a positive class cannot pass a binary
classifier. Keep unsupported outputs unknown and the corresponding work item open.

## Resources and reproducibility

Record commit, dependency/model pins, prompt hash, crop/resize settings, sampling
rate, source rendition, and fixture version. Report calls and input tokens per
encounter, cache hits, failures, estimated gross cost, request p50/p95, processing
time per source minute, peak RSS, and evidence bytes per encounter. Compare CPU
time and memory against the upgraded OCR baseline on the same hardware and clips.

Initial validation targets: at most four paid attempts per encounter, estimated
model cost below $0.002 per encounter, and no more than 25% CPU-time or 128 MiB RSS
increase without a recorded design decision. Reserve attempts before submission;
failed/time-out requests still count. Enforce a separate job/account-day limit.
Provider usage and invoice visibility must be reported separately from estimates.

## Rollout checks

Deploy only to Cloudflare validation from `migration/cloudflare`. First run bounded
canary chunks with explicit call limits. Verify the deployed commit, source times,
saved screenshots, public field evidence, unknown names, and retry identity. Keep
the canary result separate from corpus accuracy. Broader validation processing
starts after review of canary correctness and account usage. Production remains
on the existing `main` / Supabase system.

## Opt-in processor contract

`SFDE_NEXT_ENABLED=true` requires an explicit validation/local environment and
endpoint. The Process VOD workflow defaults to the existing processor. AI requests require
the validation Worker's separate `SFDE_AI_ENABLED=true` switch.

The new path retains full source frames, bounds neighboring-frame selection, and
publishes nullable names with independent field evidence. Clock values come from
owned pre-intro sources with a verified introduction anchor; a later result-screen
clock cannot supply a pre-fight value. No temporal day reconciliation is performed.
Win counting uses collective row geometry and color quality, not a guarantee that
every individual box is unobstructed. Unsupported/glowing rows remain unknown.

Each fight makes two independent hero requests when the model service is enabled
and within its request limit: one
for the ghost and one for the streamer. Streamer results are never reused across
fights, regardless of day sequence, run continuity, or chunk boundaries.

Prefer a stable artwork frame when available; otherwise use the selected intro
frame rather than skipping both hero calls. Record which selection was used.

### Automatic extraction, without profiles

The new path uses automatic nameplate and clock location, not per-streamer crops
or edge settings. The clock reader searches the left third for the clock rim;
day, wins, and crown crops are positioned relative to that match. NEXT does not
pass a profile to the clock reader. Existing legacy profile behavior is separate.

Preserve partial or uncertain OCR text and mark it obstructed. SFDE collects
observations; backend queries own search filtering. Never reconstruct hidden
letters. Streamer mode is recorded on the VOD/session from observed masking, not
assumed to be a permanent streamer property.

The existing publisher bounds display names to 128 UTF-16 units. Oversized OCR
keeps an observed prefix marked obstructed; the full observation remains in the
native result artifact. Raw field evidence stays within its 1024-unit bound;
oversized evidence uses an explicit excerpt with original length/hash rather
than silently cutting JSON. Ordinary names and evidence retain their exact text.

Hero probability guards are exploratory, not calibrated accuracy. The user
accepted imperfect hero identification for this slice; known errors and incomplete
coverage remain documented tuning work rather than delivery blockers. The local
Paddle/OpenCV clock approach is accepted; model comparisons remain dated research.
