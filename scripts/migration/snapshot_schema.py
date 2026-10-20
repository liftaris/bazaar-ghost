"""The application snapshot contract through the multiplatform schema migration."""
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_VERSION = 3
TARGET_SCHEMA_VERSION = 17
REQUIRED_TABLES = ('sfde_profiles', 'streamers', 'vods', 'chunks', 'detections',
                   'notification_subscriptions', 'server_channels', 'processing_config', 'cataloger_runs')
# Optional means absent from older source schemas, never permission-denied or silently omitted.
OPTIONAL_TABLES = ('platform_accounts', 'matchup_groups', 'matchup_appearances', 'matchup_review_events',
                   'platform_ingestion_jobs', 'youtube_websub_subscriptions', 'youtube_websub_deliveries',
                   'notification_outbox', 'notification_deliveries', 'webhook_events', 'chat_mentions')
TABLES = ('sfde_profiles', 'streamers', 'platform_accounts', 'vods', 'chunks', 'detections',
          'matchup_groups', 'matchup_appearances', 'matchup_review_events',
          'notification_subscriptions', 'server_channels', 'processing_config', 'cataloger_runs',
          'notification_outbox', 'notification_deliveries', 'webhook_events', 'chat_mentions',
          'platform_ingestion_jobs', 'youtube_websub_subscriptions', 'youtube_websub_deliveries')
# Reviewed groups of the source schema: loaded into same-named scratch tables that post_import.sql consumes and drops.
SCRATCH_TABLES = ('matchup_groups', 'matchup_appearances', 'matchup_review_events')
IMPORT_TABLES = (*TABLES[:5], 'search_names', 'search_grams', *TABLES[5:])
KEYS = {'server_channels': 'guild_id', 'processing_config': 'key',
        'notification_subscriptions': 'discord_user_id,username_lower',
        'matchup_appearances': 'detection_id', 'notification_outbox': 'detection_id',
        'notification_deliveries': 'detection_id,destination',
        'youtube_websub_subscriptions': 'account_id', 'youtube_websub_deliveries': 'account_id,body_sha256'}


def migrations(version=SCHEMA_VERSION):
    # Auth is developed independently. Do not pretend this converter can migrate user sessions.
    selected = sorted(p for p in (ROOT / 'worker/migrations').glob('*.sql')
                      if int(p.name.split('_', 1)[0]) <= version)
    if {int(p.name.split('_', 1)[0]) for p in selected} != set(range(1, version + 1)):
        raise ValueError('Incomplete supported D1 migration sequence')
    return selected


def apply_schema(db, version=SCHEMA_VERSION):
    db.execute('PRAGMA foreign_keys=ON')
    for path in migrations(version):
        db.executescript('BEGIN;\n' + path.read_text() + '\nCOMMIT;')


def private_open(path, mode='w'):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if mode == 'x' else os.O_TRUNC)
    descriptor = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    os.fchmod(descriptor, 0o600)
    return os.fdopen(descriptor, 'w', encoding='utf-8')


def private_json(path, data):
    with private_open(path) as output:
        json.dump(data, output, indent=2, ensure_ascii=False)
        output.write('\n')
