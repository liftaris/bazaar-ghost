# Encounters regression corpus v1 (BG-15)

Data only: `manifest.json` plus **30 raw images** (29 full frames and one existing
chat crop), about **11.34 MB** including this manifest/README. No detector, test,
model, video, review overlay, resize or re-encoding is included. Images are
byte-for-byte copies at their saved native rendition resolution: 1080p, 480p and
360p. The Bilibili mask source was already a re-encoded 20-second acquisition;
this corpus does not claim lossless provenance back to the platform stream.

## Evidence and limitations

- Genuine six-asterisk masked intro and non-intro control. **No settings-toggle
  proof**: privacy-style display is verified, hidden identity is not. Underlying
  and searchable names remain null; never search for `******`.
- Genuine Chronos shifted intro and following combat/clock, native360 examples,
  fade-onset/tail cases and visible-name right-edge matcher abstentions. Failed
  edge matching does **not** establish obstruction. Tags referring to abstentions
  describe prior research failures, not expected detector outputs.
- Three grey/cracked bottom-crown positives at 3300/3450/3520 are **correlated
  frames from one Bilibili recording/run**, not three independent sources. Seven
  other frames have orange/whole crowns. Day-1
  zero wins and ten-filled/zero-remaining endpoints are separately labeled.
  Animated victory glow is retained; the top trophy is not the bottom crown.
- Two explicit **same-Stelle resets**, A→B and B→C: results, loading/crossfade,
  fresh day-1 empty boards, menu/Ready for B→C, and subsequent Stelle intros.
  `runBoundaries` links the evidence. Onset brackets are visual observations, not
  server run-creation times. A's start and a global run census are unknown.
- Results/menu/loading/shop/combat/chat are `expectedScene: not_intro` negatives.
  Fading frames with a visible opponent plate remain intro positives, even when
  combat-board pixels are also visible. Chat text ending “synergy” is not a name.
- **No Karnok positive**, genuine fully occluded opponent-name example,
  letterbox/PiP coverage, broad source generalization or long-stream accuracy
  claim. Existing native-resolution renditions are not new-source holdouts.

## Contract / provenance

Each record has a stable ID, relative file, SHA-256, dimensions, source and
nominal time basis, source group, labels, review provenance and regression split.
All times have `exactPts: false`; cached Twitch times may have unknown original
VOD offsets. For sampled follow-up frames, IDs encode bin **start** while source
time approximates the bin midpoint. Bilibili `partId` is CID for part 1.

`sourceGroup` groups **all renditions of the same recording**; do not split them
across train/validation. Known local run IDs are evidence-scoped and linked by
`runBoundaries`; null means unadjudicated, not a different run. The m16 renditions
also share the `same-encounter-m16` tag. Everything is **previously seen
regression data, not blind held-out evaluation**.

Null labels mean unknown/unverified, not absent. Missing clock subfields were
not counted; `clock.present: false` is distinct from an unknown clock. `hero`
means player hero; `opponentHero` is separate. `name` concerns the opponent only.
No predicted boxes or scores are imported as ground truth. Full frames fit the
budget, so there are **no separate clock crops** or annotated geometry boxes.
The legacy chat crop has no available full-frame parent/hash/coordinates; these
are explicitly null rather than fabricated.

Provenance references identify the original ignored research reviews by hash;
the actual labels and raw images needed for replay are self-contained here.
Review was AI pixel review, **not independent human adjudication**. The parent AI
agent also checked the chat-only case. Selection uses 9 of the 18
BG-117 staged references plus 20 capture frames and the retained chat negative.

## Replay / quarantine

From the repository root, load `sfde/tests/fixtures/encounters/manifest.json`,
resolve each `file` relative to its directory, check SHA-256 and decode with
OpenCV/Pillow at native size. Inspect source groups and nulls before selecting
task-specific labels. This is **not yet wired into the existing fixture loader**;
future tests/feature integration require parent approval.

In `../annotations.json`, **only** `219543/5654.jpg` changes:
`validated: true` → `false`, plus `quarantine_reason` explaining the parent's
chat-only review. Every original field (including detection ID, confidence,
`original_username`, `username`, rank and correction flags) is preserved. The
original image is neither renamed nor removed. The loader skips it from
validated positive-name evaluation; `chat-219543-5654` retains identical bytes
here as a `not_intro` negative with null opponent name.
