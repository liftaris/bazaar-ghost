# NEXT name extraction: observations and review

## Collection policy

Detecting the nameplate is sufficient to collect OCR observations. Preserve
visible fragments, case, punctuation and uncertain/incorrect text; do not infer
letters hidden by a webcam, avatar or chat overlay. Search eligibility belongs
to the backend. Verified asterisk masks retain their existing sticky streamer
mode behaviour and do not become guessed usernames.

Name evidence contains the OCR tokens and their scores, crop coordinates,
and the original native screenshot reference/hash. Raw observations remain even
when the selected username excludes a separate text row. The existing bounded
wire field uses an excerpt/hash for oversized raw evidence; the full selected
observation is also exported in the workflow detection-summary artifact. None of
the 2,517 current-claim records in the October 22 investigation used that fallback.

## Observed October 22 fixes

Some small right-edge template matches sat lower than the glyph tops. This
clipped `TimWolle` into `himWolle`. Use the edge for the right/bottom boundaries
and expand the crop upward to the rank-relative name row when necessary. Do not
move an already-correct crop downward or discard its original pixels.

Concatenating all OCR boxes also appended separate chat lines, for example
`akb209\nnoite lay top 100 hj`. The name-row selector uses existing OCR polygons:

1. Find the tallest box. Its height is the name's glyph height.
2. Select boxes at least 75% as tall whose vertical centres are within 15% of
   that height of the tallest box's centre.
3. Join the selected boxes left to right. Detection sometimes splits one name,
   for example `evil` + `_neuro`.
4. Preserve all observations in raw evidence; record selected token indices
   separately as `name_line_indices`.
5. If geometry is unavailable, preserve all observed tokens.

There is no extra OCR/model request or streamer-specific configuration. This is
a geometric heuristic, not identity validation: a same-size overlay on the name's
line can defeat it. Chat merged into the same OCR box remains mixed text, marked
uncertain under the existing policy.

## November 2 fixes: one OCR pass

PaddleOCR's default detection box padding (`text_det_unclip_ratio=1.5`) ends
the box above low underscores. Recognition then reads a gap: `Black_Hamster`
became `Black Hamster`, saved as `Black`. Name reads use a ratio of 2.5.

A second OCR pass on an enlarged, binarized strip existed only to recognise
`******` masks. It found no masks in 1,389 October 30 encounters. With the wider
box, the ordinary pass reads masks as asterisks, so the second pass is removed.
A selected name that is mostly asterisks, at or above the confidence threshold,
is `masked`. Usernames cannot contain `*`, and OCR varies the count and can
misread one: the natural `mask-00006` fixture reads `k*******`. No first-pass
read among the 1,389 encounters contained an asterisk.

Box heights relative to the tallest box, on the October 30 sample: same-row chat
was at most 0.66 as tall. Donation overlays were as tall as names, but their
centres sat 0.21-0.25 of the name height lower; pieces of one split name were
within 0.04. Evidence: frontend repository
`.ignore/sfde-parity-2026-10-30/ocr-experiment/`.

## Actual checks and limits

The initial crop proposal regressed two previously complete names: Loustache's
`emir_2garin` lost an underscore, and Yosi's `bloddywolf` acquired a spurious
mask-branch asterisk and became obstructed. Both came from shifting good crops
downward. They are now permanent native-image regression fixtures.

After narrowing the crop fix, a saved-image check of **666 records across 46
streamers** preserved all **194 complete controls** exactly (name and state).
Among 472 obstructed records, 95 selections changed by excluding off-midline
tokens: Layzyn 3, Leodriango 72, Rahresh 17, SpaceJuju 3. No state classifications
changed anywhere in that sample. Raw observations are retained. These are
before/after regression comparisons, not independently labelled accuracy or a
guarantee about unseen overlays. Seven targeted native-image fixtures also cover
the observed clipping/chat cases and the two discovered regressions.

## Future backend review

OCR confidence does not establish that recognized text belongs to the opponent.
For example, the mixed token `FredTheFroghow are you fit` scored **0.985875**.
The reviewed Leodriango/Rahresh selected-result scores ranged from **0.743655 to
0.973262** despite visible contamination.

The user proposed a later backend service/cron for targeted VLM review based on
low confidence, unusual values/obstruction, or website user reports. It is not
implemented here. Preserve raw OCR and source images for that review rather than
adding speculative rejection rules to SFDE.

Investigation artifacts: `.ignore/sfde-next/failure-name-investigation/`, including
the frozen cross-streamer manifest, original screenshots, first-candidate failures
and final before/after output.
