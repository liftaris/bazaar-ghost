# Authenticated YouTube rollout

## Predicate

At least two Kripp recordings scheduled through the deployed validation service complete normal streaming chunks and publish nonempty OCR/catalog results. Production is verified only after the repository promotion gates pass and the deployed production service completes the same path. Probe downloads do not satisfy this predicate.

## TODO

- [x] Read poteto-mode Principles in full.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [x] Integrate cookies into metadata and per-chunk resolution without full media downloads.
- [x] Run focused resolver/workflow regression tests.
- [x] Commit, push, review and deploy validation through migration/cloudflare.
- [ ] Schedule two Kripp recordings and inspect actual chunk, OCR and catalog output.
- [ ] Fix observed failures and repeat the deployed check.
- [ ] Promote through dev/main gates and verify production, or record the exact gate preventing promotion.
- [ ] Phase D: Keep the audit trail.
- [ ] Phase E: Verify and hand back.

## Scope and gates

Three implementation surfaces cover the current integration gap: resolver, dependency pins and workflow authentication. Existing source identity and media-locator dictionaries remain authoritative. Credentials live in an application secret separate from the temporary probe secret. Each runner receives its own disposable cookie jar because yt-dlp updates that jar. No cookie or signed media URL belongs in an artifact.

The deployment gate is high rigor because production deployment and scheduling affect shared services. The throughput checkpoint is to overlap independent deployment discovery with implementation review, not to run duplicate schedulers. Nested delegation was attempted but is unavailable at this session depth; the parent must provide the independent review gate.

## Evidence

Append checkpoints to `docs/youtube-rollout-decisions.tsv`. Record exact commits, Actions runs and recording identifiers. A green workflow alone is not OCR or production evidence.

PR 82 merged at `130c9bd39d149384961c73a4bc85f225c4d4d81b` after independent review and both CI jobs passed. Validation deployment passed in run 40546559912, and live health returned the exact commit. The selected recordings are Kripparrian uploads `HklpcveV_4o` and `k3Mnp0OQ8ug`, cataloged through hosted runs 40546805031 and 40546810258. The deployed scheduler dispatched processing runs 40548008075 and 40548009614. Their final runtime outcomes remain pending.

The existing validation automatic-processing cutoff is 2026-10-16. Preserve it. YouTube ingestion and discovery remain disabled during this bounded rollout. Enabling processing permits the scheduler to process the explicitly cataloged recent recordings, not the older two-recording backlog.

Authenticated Cloudflare account inventory found `bazaarghost-validation` as the only BazaarGhost D1 database. The production branch still uses Supabase. Production Cloudflare configuration contains placeholders, so promotion requires the separate data and resource migration rather than inventing resource IDs.
