# Single-frame clock fixtures and templates

These are **development/regression** pixels, not a blind validation set. All
images together with their metadata are below 2,000,000 bytes. No OCR weights or
new recognizer are included. Runtime needs only `geometry.png`, `safe.png`, and
`cracked.png`; other images are regression fixtures.

## Frozen labels and provenance

- `native480-labels.json`: fourteen locally extracted 852×480 battle frames from
  `/home/kaio/Dev/bazaar-ghost/test_data/2549030240/480p.mp4`. FFmpeg used nominal
  local-file seeks, one JPEG per timestamp, `-threads 2 -q:v 5`. Exact PTS and
  original VOD offset are not asserted. Clock day, ten cell interiors, and bottom
  crown were visually reviewed **before `clock_reader.py` was created**. Values
  agree with earlier 1080p proposals, but were checked on native480 pixels, not
  inferred from day. The labels enumerate source times, dimensions and hashes.
- `bili-labels.json`: directly pixel-reviewed cell counts at part seconds
  1500/3300/3450/3520: earned **5/8/9/9**, remaining **5/2/1/1**. Labels were
  frozen before implementation. The eighth/earlier dim cells at3300 still exceed
  this implementation's uncertainty tolerance: its returned count is unknown.
  Day/crown labels also agree with existing verified capture labels.
- `labels-freeze.json`: checksums of both pre-implementation label files, earlier
  verified capture labels, and labels for shifted/glow/1080p regression crops.
- `fixture-provenance.json`: the byte-identical native480 no-clock Bili intro
  (part152) and checksum of the omitted derived cell-review sheet.

Copied source crops are byte-identical to:

| Asset | Source |
|---|---|
| `geometry.png` | `/home/kaio/Dev/bazaarghost.stream/.ignore/experiments/clairic-pvp-2026-10-20/frames/m01-clock.png` |
| `safe-nine.png` | same directory, `m12-clock.png` |
| `safe.png` | `.ignore/sfde-next/capture/verified-crops/bili-clock-1500.png` |
| `cracked.png` | same directory, `bili-clock-3300.png` |
| `bili-3450.png`, `bili-3520.png` | same directory, `bili-clock-3450.png`, `bili-clock-3520.png` |
| `shifted.png` | same directory, `shifted-clock-380.png` |
| `glow-3234.png`, `glow-5709.png` | same directory, `clock-2549030240-3234.png`, `clock-2549030240-5709.png` |

Original geometry/safe-nine crops have parent xyxy `[185,410,390,685]` in
1920×1080. Bili crops have `[80,185,175,305]` in852×480. Shifted has
`[185,440,390,715]` in1920×1080. Glow parent rectangles are recorded in the capture
crop manifest. These source rectangles reconstruct full-frame test inputs only;
they are **not supplied to the automatic locator**. `sha256sums.json` inventories
every file here except itself and is checked by the tests.

## Important limits

All three genuine lethal timestamps3300/3450/3520 come from **one Bili recording
and run**, `BV1AHuC6nEGn:40830306653`. Safe1500/cracked3300 supply the templates;
3450/3520 are now explicit regression cases, no longer heldout positives.
Desaturated whole-crown and blur tests are synthetic expected-unknown probes,
not fabricated positive examples. Gray color alone is never lethal evidence.

Native480 counts cover remaining1–10, not a pristine0-remaining example. Both
real ten-win glow endpoints deliberately remain unknown. The revised annulus
accepts the one shifted Chronos crop for wins/crown, but its automatic day still
abstains. Right-side clocks outside the left-third search are unsupported. No
independent-source lethal generalization or all-layout/all-value support is
claimed. Parent review owns the final BG-116 field-method decision.
