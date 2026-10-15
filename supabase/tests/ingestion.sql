BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;
SELECT plan(17);
INSERT INTO sfde_profiles(id, profile_name, crop_region)
OVERRIDING SYSTEM VALUE VALUES (960001, 'ingestion-test', ARRAY[0.5,0.5,0.4,0.2]);
-- Isolate work selection; this transaction rolls back all fixture changes.
UPDATE platform_ingestion_jobs SET status = 'completed';
INSERT INTO platform_accounts(id, source, source_id, display_name, processing_enabled, sfde_profile_id)
VALUES ('00000000-0000-4000-8000-000000960001', 'youtube', 'UC0000000000000000960001', 'Ingestion fixture', true, 960001);
SELECT is((SELECT count(*)::integer FROM platform_ingestion_jobs WHERE account_id = '00000000-0000-4000-8000-000000960001'),
  1, 'enabling a new creator schedules polling');
UPDATE platform_ingestion_jobs SET status = 'completed' WHERE kind = 'account';
SELECT enqueue_platform_ingestion('youtube', 'video', 'YouTube9601', '00000000-0000-4000-8000-000000960001');
CREATE TEMP TABLE first_lease AS SELECT * FROM claim_platform_ingestion(false);
SELECT is((SELECT count(*)::integer FROM first_lease), 1, 'worker claims due video');
SELECT is((SELECT count(*)::integer FROM claim_platform_ingestion(false)), 0, 'another worker cannot claim active lease');
SELECT ok(NOT finish_platform_ingestion((SELECT id FROM first_lease), gen_random_uuid(), 'completed'), 'wrong token cannot finish');
SELECT ok(receive_youtube_notification('00000000-0000-4000-8000-000000960001', repeat('a',64), ARRAY['YouTube9601']), 'signed delivery persists atomically');
SELECT ok(NOT receive_youtube_notification('00000000-0000-4000-8000-000000960001', repeat('a',64), ARRAY['YouTube9601']), 'duplicate delivery is ignored');
SELECT ok(finish_platform_ingestion((SELECT id FROM first_lease), (SELECT lease_token FROM first_lease), 'completed'), 'lease owner finishes');
SELECT is((SELECT status FROM platform_ingestion_jobs WHERE source_id='YouTube9601'), 'pending', 'notification during processing survives completion');
CREATE TEMP TABLE second_lease AS SELECT * FROM claim_platform_ingestion(false);
UPDATE platform_ingestion_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE source_id='YouTube9601';
CREATE TEMP TABLE recovered_lease AS SELECT * FROM claim_platform_ingestion(false);
SELECT ok((SELECT lease_token FROM second_lease) <> (SELECT lease_token FROM recovered_lease), 'expired lease is reclaimed with new token');
SELECT ok(NOT finish_platform_ingestion((SELECT id FROM second_lease), (SELECT lease_token FROM second_lease), 'completed'), 'stale worker cannot finish reclaimed work');
SELECT ok(finish_platform_ingestion((SELECT id FROM recovered_lease), (SELECT lease_token FROM recovered_lease), 'waiting', 900, NULL,
  '{"archive_state":"post_live"}'), 'unready archive is durable waiting work');
SELECT is((SELECT count(*)::integer FROM claim_platform_ingestion(false)), 0, 'waiting archive respects retry time');
UPDATE platform_ingestion_jobs SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE source_id='YouTube9601';
UPDATE platform_accounts SET processing_enabled=false WHERE id='00000000-0000-4000-8000-000000960001';
SELECT is((SELECT count(*)::integer FROM claim_platform_ingestion(false)), 0, 'disabled creators cannot be ingested');
SELECT ok(NOT receive_youtube_notification('00000000-0000-4000-8000-000000960001', repeat('b',64), ARRAY['YouTube9601']), 'disabled creators ignore callbacks');
SELECT ok(NOT has_table_privilege('anon', 'youtube_websub_subscriptions', 'SELECT'), 'subscription secrets are private');
SELECT ok(NOT has_function_privilege('authenticated', 'claim_platform_ingestion(boolean)', 'EXECUTE'), 'clients cannot claim ingestion work');
SELECT throws_ok($$SELECT enqueue_platform_ingestion('bilibili','video','YouTube9601')$$,
  'P0001', 'Invalid ingestion identity', 'platform identities cannot collide');
SELECT * FROM finish();
ROLLBACK;
