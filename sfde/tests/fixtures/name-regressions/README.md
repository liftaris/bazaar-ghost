# Captured NEXT name regressions

Native validation intro JPEGs reviewed on 2026-10-22. These are previously seen
regression examples, not a blind accuracy benchmark. Original URLs, field
evidence and before/after OCR are recorded in the local investigation at
`.ignore/sfde-next/failure-name-investigation/`.

- `ikarus_-1544.jpg`: VOD 2907114968, evidence 1544s. Low edge match clipped the
  top of `TimWolle` and produced `himWolle`.
- `ikarus_-8686.jpg`: same VOD, evidence 8686s. Rank-aligned crop reads `Shasou19`.
- `layzyn-11914.jpg`: VOD 2907070579, evidence 11914s. `Brockolis` plus smaller
  chat-overlay line. Only the name row belongs in the username.
- `layzyn-4368.jpg`: same VOD, evidence 4368s. Keep the actual `SoloCupiu` OCR
  observation and obstruction; do not append chat or reconstruct its final letter.
- `layzyn-6548.jpg`: same VOD, evidence 6548s. `akb209` plus smaller chat text.
- `loustache-2039.jpg`: VOD 2907112519. The broader check found that moving an
  already-correct crop downward lost the visible underscore in `emir_2garin`.
- `yosi14jp-1702.jpg`: VOD 2907573676. Keep `bloddywolf` and its complete state;
  shifting this correct crop downward introduced a spurious mask-branch `*`.

No streamer-specific coordinates or profiles are used by the tests.
