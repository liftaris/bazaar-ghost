# Hero regression corpus v1 (BG-15)

Eight previously reviewed contexts, 20 unchanged image files, 19 unchanged saved
responses and five original prompt documents. Five natural name-visibility
annotations reference existing `../frames/` bytes; no duplicate crops are added.
`manifest.json` records SHA-256, dimensions, source/time/part/rendition, recording
partitions, known run bounds, crop parents and AI-provisional review status.

This is **previously seen regression data, not blind heldout or independently
human-adjudicated truth**. Skins have descriptions, not verified catalog IDs.
There is no Karnok positive. Ghost Jules is a dissolve, excluded from stable
identity scoring. No clock or temporal footage is promoted here.

Preserved failures include full-frame Dooley/Mak/wrestling Vanessa → left Stelle,
original eight-choice m01 Pygmalien → Mak, earlier wrestling Vanessa → unknown,
and overlaid green Pygmalien → Mak in three distinct prompt protocols. The
current exploratory guard **still accepts the wrong overlaid Mak**. Passing CI
means these observations remain reproducible, not that the classifier is fixed.

`test_hero_regressions.py` verifies hashes/dimensions/crop lineage, original prompt
and input binding, all answer distributions, and actual `parse_hero` results for
compatible eight-choice tasks. Ten-choice and experimental prompts are not
silently treated as current-runtime protocols. The transport adapter adds only
`status: ok`; it does not edit the saved result. Original response files and
their original hashes are retained byte-for-byte; historical request path strings
are metadata only and are never resolved. No credentials, signed URLs or image
base64 are included. Run with normal network-disabled CI, never live inference.

On stable contexts, the 18 correlated saved protocol outputs contain **10 correct,
7 wrong, 1 unknown**. The compatible guard subset has **5 correct, 1 wrong,
5 unknown** across 11 stable replays; one transition replay is separately
excluded and rejected. These are fixture counts, **not independent accuracy**.
All five partial/uncertain names remain unsearchable; historical annotations are
retained separately and never used to reconstruct visible text. Legacy sources
for the thumbnail overlays resolve to Twitch `2696509426`, not a placeholder ID.

The Docker test stage copies all `tests/`, including referenced legacy crops and
annotations. No ignored/workstation files or live model access are required.
