# Application snapshots for Cloudflare

The source snapshot contract covers backend application data through `0003_platform_contracts.sql`. The generated import requires the complete target schema through `0007_platform_ingestion_dispatch.sql`. These are separate version boundaries: the tools do not export Supabase Auth users, browser sessions, or any new user/social data. A snapshot containing unknown tables or columns stops conversion for review.

Pause source cataloging, ingestion, scheduled processing and notification delivery; drain active jobs before a final export. PostgREST pagination cannot provide a cross-table transactional snapshot. The exporter makes only read requests and refuses redirects, so project credentials cannot be forwarded to a different origin.

With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` already supplied in the environment:

```sh
python scripts/migration/export_supabase.py .ignore/source-snapshot
python scripts/migration/convert.py .ignore/source-snapshot .ignore/d1-import
```

Both commands require new output directories. Output directories have mode `0700`; JSONL, SQL, manifests and the intermediate SQLite database have mode `0600`. The source WebSub table contains callback capabilities and signing secrets. Keep raw snapshots private even after conversion.

The snapshot manifest records every supported table as present with a row count or absent because the older source schema has no such table. A permission error, generic HTTP404, interrupted export, missing file, or row-count mismatch is an error. `sfot_profiles` and `sfot_profile_id` from the original schema are recognized. Original flat count manifests explicitly identify older snapshots; missing optional tables from those snapshots are reported in the conversion manifest. An unmanifested snapshot must contain the complete supported table set, including empty files.

Conversion applies all supported migrations in order to a private SQLite database and then loads profiles, streamer/platform identities, videos, chunks, detections, verified appearances, historical delivery state, ingestion jobs and WebSub state in dependency order. It validates foreign keys, constraints and chunk overlap before emitting SQL. Source timestamps normalize to UTC with millisecond precision; this preserves actual instants when D1 compares timestamp strings. Video IDs, recorded dates, Bilibili BV/CID identities and part order, processing settings, cursors, job state, and screenshot keys remain represented.

Any processing/queued chunk, processing ingestion job, or retained ingestion lease prevents conversion, even if the lease has already expired. Drain or explicitly resolve those jobs in the source before taking a new snapshot; the converter does not decide whether unfinished work succeeded.

Imported notification outbox rows are marked sent, and historical Twitch detections receive sent outbox records. Importing history does not create a notification backlog. Delivery receipts and WebSub body-digest tombstones are retained.

WebSub callback tokens and signing secrets are **rotated during conversion**. The generated database and SQL contain new random capabilities; original capabilities are not copied into the target. All imported subscription request, confirmation, and expiry fields are cleared. A subscription must be renewed for the target environment before any notification can be accepted. This is recorded in the manifest and in each subscription's status text. Keep `OUTBOUND_ENABLED=false` and scheduled/catalog jobs paused until you have reviewed the target hostname, provider configuration, and processing settings. Renew subscriptions only after that review; the converter never calls the hub.

Apply all target migrations `0001`–`0007` to a fresh target before importing. The first import statement checks every target application, auth, social and operational dispatcher table is empty before changing any triggers. The `public_cache_state` singleton must exist with its initialized revision of zero; it is the one expected populated application table. A target containing even an auth verification, an orphan user, moderation history or an idle/queued/running ingestion-dispatch row is refused, as is a target still on schema3 or schema6. The dispatcher table starts empty: dispatch tickets and GitHub run ownership belong only to their original environment and are never exported or replayed by this source-schema3 converter. Import the numbered `import-0001.sql` parts in order; each part ends at a complete SQL statement and normally stays below4MB. A single larger statement remains whole. The complete `import.sql` is also available. Resume a partially imported database only with an explicit checkpoint review; rerunning the whole import is deliberately refused.

Conversion validates the source with schema3, emits only the explicitly supported source tables, then rehearses that exact SQL against a fresh full schema7 database. The newer clip/auth/moderation triggers remain installed while the older application triggers are temporarily suspended. Imported detections therefore create their new durable clip anchors automatically; no user account, session, like, favorite, comment or report is imported. The manifest records `source_schema_version`, `target_schema_version`, both migration hash sets, original application counts and the complete resulting `target_counts` including derived clips. The private `snapshot.sqlite` is the intermediate source-contract database, not a complete target database backup.

For the dedicated validation environment, inspect the actual bound database and pass deployment preflight before any remote import:

```sh
python scripts/deployment_check.py validation --ref refs/heads/migration/cloudflare
```

Verify output table counts against `manifest.json`, run `PRAGMA foreign_key_check`, inspect source-specific video/search results and stored screenshot objects, and confirm there are no pending historical notification records. Database import does not copy R2/storage objects. No source export or hosted import is performed automatically by tests or deployment.

The tests exercise populated Twitch/YouTube/Bilibili snapshots, cross-platform appearances, paused ingestion state, capability rotation, private file permissions, deleted-ID sequence preservation, full-target trigger behavior and rejection paths. A real local workerd/D1 proof is opt-in because `cf` needs local listeners:

```sh
RUN_LOCAL_D1_MIGRATION_TESTS=1 python -m unittest scripts.tests.test_migration_d1 -v
```

This proof generates only synthetic fixture data, applies every target migration to isolated local D1, imports the actual generated SQL, checks identities/timestamps/groups/replay state/derived clips/empty auth/foreign keys, exercises moderation against the imported data, and rejects repeat imports, existing users, occupied operational dispatcher state and missing revision state. It never exports Supabase or accesses hosted D1. Set `LOCAL_D1_ARTIFACT_DIR` to a new private directory to retain the proof manifest and captured CLI logs; otherwise the disposable databases are removed after the test.
