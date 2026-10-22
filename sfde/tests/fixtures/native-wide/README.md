# Native non-16:9 regression

Twitch VOD `2907371019` (swordlless), exact `480p30` rendition, native 896×480.
Captured 2026-10-22 using FFmpeg 8.0.3, single decoder thread, input-side seek
and duration, fps=0.5, JPEG q=2; no resize, crop, or reconstructed pixels.

| Timestamp | Pixel label | SHA-256 |
|---|---|---|
| 226 | Not an intro | d354afef9377e6c6140d1e4341413bcf876641b29977c4c19cebfb28193b2245 |
| 230 | Onei, diamond intro | 366aba2035806c754c0befc8e7b55901352aff95c273932dbc66c9c8c7565f20 |
| 390 | Raaaaay, diamond intro | 6c736d0453c23fe29b4b36e6a7a0fdecee7930f2e38176cddf9b767f6587caf8 |
| 550 | Mennarch, silver intro | be63f69d51c2e8224bbf03dcf10d282a35e177e1d8458038ab0088250a3d2252 |

The old aspect gate rejected every frame before template matching. These fixtures
test native geometry and the five-template locator; labels do not assert OCR or
hero-identification accuracy.
