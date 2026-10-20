#!/usr/bin/env python3
"""Validate a JSONL snapshot and emit an import for an empty D1 application schema.

Platform identities/history survive conversion. Historical notifications cannot replay;
WebSub capabilities rotate and imported subscriptions remain unconfirmed. No network calls.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import unicodedata

if __package__:
    from .snapshot_schema import (ROOT, SCHEMA_VERSION, TARGET_SCHEMA_VERSION, SCRATCH_TABLES, TABLES, REQUIRED_TABLES, OPTIONAL_TABLES,
                                  IMPORT_TABLES, apply_schema, migrations, private_json, private_open)
else:
    from snapshot_schema import (ROOT, SCHEMA_VERSION, TARGET_SCHEMA_VERSION, SCRATCH_TABLES, TABLES, REQUIRED_TABLES, OPTIONAL_TABLES,
                                 IMPORT_TABLES, apply_schema, migrations, private_json, private_open)


TIMESTAMPS = {'created_at', 'updated_at', 'published_at', 'recorded_at', 'queued_at', 'started_at',
              'completed_at', 'scheduled_for', 'lease_expires_at', 'last_attempt_at', 'next_attempt_at',
              'last_cataloged_at', 'requested_at', 'confirmed_at', 'received_at', 'linked_at', 'sent_at',
              'oldest_vod', 'last_availability_check', 'unavailable_since', 'from_date', 'to_date'}
WEBSUB_RESET = 'Imported with rotated capabilities; subscription disabled until target-environment renewal.'


def trigrams(value):
    words, word = [], ''
    for char in value.lower():
        if unicodedata.category(char)[0] in ('L', 'N'):
            word += char
        elif word:
            words.append(word)
            word = ''
    if word:
        words.append(word)
    return sorted({('  ' + word + ' ')[i:i + 3] for word in words for i in range(len(word) + 1)})


def utc_timestamp(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('Timestamp must be a string with an explicit timezone')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp must include an explicit timezone')
    return parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def inventory(source):
    """Absence needs positive snapshot evidence; a missing file is not an empty table."""
    unknown_files = sorted(p.name for p in source.glob('*.jsonl') if p.stem not in TABLES)
    if unknown_files:
        raise ValueError(f'Unsupported snapshot tables: {unknown_files}')
    manifest_path = source / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if manifest is not None and not isinstance(manifest, dict):
        raise ValueError('Snapshot manifest must be an object')
    entries, absent = {}, {}
    if manifest is not None and manifest.get('format_version') == 2:
        if manifest.get('complete') is not True or not isinstance(manifest.get('tables'), dict):
            raise ValueError('Snapshot export is incomplete')
        if set(manifest['tables']) != set(TABLES):
            raise ValueError('Snapshot manifest must explicitly account for every supported table')
        entries = manifest['tables']
    elif manifest is not None:
        if (not isinstance(manifest, dict) or not set(manifest).issubset(REQUIRED_TABLES)
                or any(type(count) is not int or count < 0 for count in manifest.values())):
            raise ValueError('Unsupported snapshot manifest format')
        entries = {table: {'status': 'present', 'count': count} for table, count in manifest.items()}
        for table in OPTIONAL_TABLES:
            if not (source / f'{table}.jsonl').exists():
                entries[table] = {'status': 'absent', 'count': 0, 'reason': 'legacy snapshot predates optional tables'}
    for table in TABLES:
        path = source / f'{table}.jsonl'
        entry = entries.get(table, {})
        if entry and (entry.get('status') not in ('present', 'absent') or
                      type(entry.get('count')) is not int or entry['count'] < 0):
            raise ValueError(f'Invalid manifest entry for {table}')
        if entry.get('status') == 'absent':
            if table not in OPTIONAL_TABLES or entry['count'] != 0 or (path.exists() and path.stat().st_size):
                raise ValueError(f'Invalid absence declaration for {table}')
            absent[table] = entry.get('reason', 'source table absent')
        elif not path.is_file():
            raise ValueError(f'Missing {table}.jsonl; record optional table absence in the snapshot manifest')
    return entries, absent


def prepare_row(table, record):
    row = dict(record)
    if table == 'streamers' and 'sfot_profile_id' in row:
        if 'sfde_profile_id' in row:
            raise ValueError('Both legacy and current profile references exist')
        row['sfde_profile_id'] = row.pop('sfot_profile_id')
    if table == 'vods' and row.get('source', 'twitch') == 'twitch' and row.get('recorded_at') is None:
        # Twitch publish time is the stream start; the target schema has no per-platform fallback.
        row['recorded_at'] = row.get('published_at')
    if table == 'chunks':
        if row.get('status') in ('processing', 'queued'):
            raise ValueError('Snapshot contains active chunks. Pause and drain processing before export.')
        row['claim_token'], row['lease_expires_at'] = None, None
    if table == 'platform_ingestion_jobs':
        if row.get('status') == 'processing' or row.get('lease_token') is not None or row.get('lease_expires_at') is not None:
            raise ValueError('Snapshot contains an active ingestion lease. Pause and drain ingestion before export.')
    if table == 'youtube_websub_subscriptions':
        row.update(callback_token=secrets.token_hex(32), secret=secrets.token_hex(32),
                   requested_at=None, confirmed_at=None, lease_expires_at=None, last_error=WEBSUB_RESET)
    for key in TIMESTAMPS & row.keys():
        row[key] = utc_timestamp(row[key])
    return row


def reject_nonfinite(value):
    raise ValueError(f'Non-finite JSON number: {value}')


def split_import(destination):
    part, size, number, pending = None, 0, 0, ''
    try:
        with (destination / 'import.sql').open() as sql:
            for line in sql:
                pending += line
                if not sqlite3.complete_statement(pending):
                    continue
                length = len(pending.encode())
                if part is None or size + length > 4_000_000:
                    if part:
                        part.close()
                    number += 1
                    part = private_open(destination / f'import-{number:04}.sql')
                    size = 0
                part.write(pending)
                size += length
                pending = ''
        if pending.strip():
            raise ValueError('Incomplete SQL statement in export')
    finally:
        if part:
            part.close()
    return number


def convert(source, destination):
    source, destination = Path(source), Path(destination)
    entries, absent = inventory(source)
    if destination.exists():
        raise ValueError('Destination already exists; choose a new directory')
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    # The database and generated SQL contain newly rotated capabilities. Protect every artifact.
    with private_open(destination / 'snapshot.sqlite', 'x'):
        pass
    db = sqlite3.connect(destination / 'snapshot.sqlite')
    try:
        apply_schema(db)
        # Source notification state is never imported: the target keys notifications by Matchup, and its history is marked sent below.
        db.execute('DROP TRIGGER detection_outbox')
        counts, unknown, vod_statuses = {}, {}, []
        for table in TABLES:
            columns = {r[1] for r in db.execute(f'PRAGMA table_info({table})')}
            count, extra = 0, set()
            if table not in absent:
                with (source / f'{table}.jsonl').open() as input_rows:
                    for line in input_rows:
                        record = json.loads(line, parse_constant=reject_nonfinite)
                        if not isinstance(record, dict):
                            raise ValueError(f'{table} row must be an object')
                        accepted = columns | ({'sfot_profile_id'} if table == 'streamers' else set())
                        extra.update(set(record) - accepted)
                        if set(record) - accepted:
                            continue
                        try:
                            row = prepare_row(table, record)
                            if table == 'vods':
                                vod_statuses.append((row.get('status', 'pending'), row['id']))
                            if table == 'detections':
                                name = row['username'].lower()
                                grams = trigrams(name)
                                db.execute('INSERT OR IGNORE INTO search_names VALUES(?,?)', (name, len(grams)))
                                db.executemany('INSERT OR IGNORE INTO search_grams VALUES(?,?)', ((g, name) for g in grams))
                                row['username_lower'] = name
                            if table == 'notification_subscriptions':
                                row['username_lower'] = row['username'].lower()
                            row = {k: json.dumps(v, ensure_ascii=False, allow_nan=False) if isinstance(v, (list, dict))
                                   else int(v) if isinstance(v, bool) else v for k, v in row.items()}
                            names = ','.join('"' + k + '"' for k in row)
                            db.execute(f'INSERT INTO {table}({names}) VALUES({",".join("?" for _ in row)})', list(row.values()))
                        except (sqlite3.IntegrityError, OverflowError, ValueError) as error:
                            raise ValueError(f'{table} row {record.get("id", record.get("account_id", count + 1))}: {error}') from error
                        count += 1
            counts[table] = count
            if extra:
                unknown[table] = sorted(extra)
                private_json(destination / 'unmapped-columns.json', unknown)
                raise ValueError('Unmapped source columns; see unmapped-columns.json. Review before importing.')
            if table in entries and entries[table]['count'] != count:
                raise ValueError(f'{table} count differs from the completed export manifest')
        db.executemany('UPDATE vods SET status=? WHERE id=?', vod_statuses)
        imported_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        problems = db.execute('PRAGMA foreign_key_check').fetchall()
        if problems:
            raise ValueError(f'Foreign-key errors: {problems[:10]}')
        db.commit()
        triggers = db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").fetchall()
        output_counts = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in IMPORT_TABLES}
        # Validate the old application snapshot separately from the complete deployment
        # schema. New auth/social/dispatcher tables are never source import tables,
        # but any existing row makes the target unsafe for a fresh import.
        with closing(sqlite3.connect(':memory:')) as target:
            apply_schema(target, TARGET_SCHEMA_VERSION)
            target_tables = [row[0] for row in target.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            with private_open(destination / 'import.sql') as output:
                # platform_settings is seeded deployment configuration, never source data.
                seeded = ('public_cache_state', 'public_search_state', 'platform_settings')
                nonempty = ' OR '.join(f'EXISTS(SELECT 1 FROM {table})' for table in target_tables if table not in seeded)
                singleton = ' AND '.join(f'(SELECT count(*) FROM {table})=1 AND EXISTS(SELECT 1 FROM {table} WHERE id=1 AND revision=0)'
                                         for table in ('public_cache_state', 'public_search_state'))
                output.write(f"INSERT INTO mutation_checks(id,ok) VALUES('snapshot-import-empty',NOT({nonempty}) AND {singleton});\n")
                output.write("DELETE FROM mutation_checks WHERE id='snapshot-import-empty';\n")
                # The reviewed-group tables no longer exist in the target schema; they are scratch input for post_import.sql, which drops them.
                for table in SCRATCH_TABLES:
                    output.write(db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0] + ';\n')
                # Only the old application's triggers are suspended. New anchor/Matchup/auth/cache
                # triggers stay installed and materialize derived rows during this import.
                for name, _ in triggers:
                    output.write(f'DROP TRIGGER IF EXISTS {name};\n')
                for table in IMPORT_TABLES:
                    columns = [r[1] for r in db.execute(f'PRAGMA table_info({table})')]
                    quoted = ','.join(f'quote("{column}")' for column in columns)
                    names = ','.join(f'"{column}"' for column in columns)
                    for values in db.execute(f'SELECT {quoted} FROM {table}'):
                        output.write(f'INSERT INTO {table}({names}) VALUES({",".join(values)});\n')
                    if table == 'platform_accounts':
                        # Before the Recordings, so their Sessions and the provisional-Streamer trigger see the operator links.
                        output.write("INSERT INTO channel_ownership(channel_id,streamer_id,method,actor,started_at) "
                                     "SELECT id,streamer_id,'legacy-link','migration:convert',created_at FROM platform_accounts "
                                     "WHERE source<>'twitch' AND streamer_id IS NOT NULL;\n")
                # The target's Matchup trigger queued every imported Matchup; a history import never notifies.
                output.write(f"UPDATE notification_outbox_v2 SET sent_at='{imported_at}' WHERE sent_at IS NULL;\n")
                # Ownership triggers bump revisions during import; a fresh import starts at revision 0.
                output.write("UPDATE public_search_state SET revision=0 WHERE id=1;\nUPDATE public_cache_state SET revision=0 WHERE id=1;\n")
                for name, snapshot_sql in triggers:
                    # The target's own definition wins: later migrations replace application triggers.
                    row = target.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,)).fetchone()
                    output.write((row[0] if row else snapshot_sql) + ';\n')
            target.executescript((destination / 'import.sql').read_text())
            # Legacy reviewed groups become link overrides and merged Matchups; generated from the same statements as migration 0015.
            post_import = (ROOT / 'scripts/migration/post_import.sql').read_text()
            with private_open(destination / 'post_import.sql') as output:
                output.write(post_import)
            target.executescript(post_import)
            if target.execute('SELECT revision FROM public_cache_state WHERE id=1').fetchone()[0]:
                raise ValueError('Post-import left a non-zero cache revision')
            if target.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('Generated import violates target foreign keys')
            target_counts = {table: target.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in target_tables}
            # Each Twitch streamer also yields a Channel through the streamers trigger.
            expected = {**{t: c for t, c in output_counts.items() if t not in SCRATCH_TABLES}, 'platform_accounts': output_counts['platform_accounts'] + output_counts['streamers']}
            if any(target_counts[table] != count for table, count in expected.items()):
                raise ValueError('Generated import changed application row counts')
        parts = split_import(destination)
        manifest = {'format_version': 2, 'schema_version': SCHEMA_VERSION,
                    'source_schema_version': SCHEMA_VERSION, 'target_schema_version': TARGET_SCHEMA_VERSION, 'complete': True,
                    'migrations': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in migrations()},
                    'target_migrations': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in migrations(TARGET_SCHEMA_VERSION)},
                    'target_counts': target_counts,
                    'input_counts': counts, 'output_counts': output_counts, 'absent_source_tables': absent,
                    'import_parts': parts, 'imported_at': imported_at,
                    'post_import': {'file': 'post_import.sql', 'sha256': hashlib.sha256(post_import.encode()).hexdigest()},
                    'policies': {'notification_history': 'marked sent', 'websub_capabilities': 'rotated',
                                 'websub_subscriptions': 'unconfirmed; renew only after target cutover review',
                                 'websub_delivery_receipts': 'retained', 'ingestion_jobs': 'retained; active leases refused',
                                 'auth': 'source auth is excluded; target auth and social tables must be empty',
                                 'ingestion_dispatch': 'source dispatch state is excluded; target dispatcher table must be empty',
                                 'target': f'full schema 0001–{TARGET_SCHEMA_VERSION:04d} required; anchors and Matchups derive from imported detections',
                                 'matchup_groups': 'run post_import.sql once after the import parts: reviewed groups become link overrides and merged Matchups'}}
        private_json(destination / 'manifest.json', manifest)
        print(json.dumps({'counts': counts, 'absent_tables': sorted(absent), 'rotated_websub_subscriptions': counts['youtube_websub_subscriptions']}, indent=2))
        return counts
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    convert(args.source, args.destination)
