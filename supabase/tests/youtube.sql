BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;
SELECT plan(14);

INSERT INTO sfde_profiles(id, profile_name, crop_region)
OVERRIDING SYSTEM VALUE VALUES (920001, 'youtube-test', ARRAY[0.5,0.5,0.4,0.2]);
INSERT INTO platform_accounts(id, source, source_id, display_name, processing_enabled, sfde_profile_id)
VALUES ('00000000-0000-4000-8000-000000920001', 'youtube', 'UC0000000000000000000000', 'YouTube only', true, 920001);
INSERT INTO vods(id, source, source_id, platform_account_id, title, duration_seconds,
  bazaar_chapters, ready_for_processing, published_at, notifications_enabled)
OVERRIDING SYSTEM VALUE VALUES (920001, 'youtube', 'YouTube0001',
  '00000000-0000-4000-8000-000000920001', 'The Bazaar', 3701, ARRAY[0,3701], true, '2025-01-01', false);
SELECT is((SELECT count(*)::integer FROM chunks WHERE vod_id = 920001), 3, 'YouTube account needs no Twitch streamer');
SELECT is((SELECT sum(end_seconds-start_seconds)::integer FROM chunks WHERE vod_id = 920001), 3701, 'YouTube chunks cover the short tail');
SELECT is(create_missing_chunks_for_vod(920001), 0, 'YouTube recataloging does not duplicate chunks');
SELECT is((SELECT old_templates FROM vod_processing_context WHERE id = 920001), false, 'upload date does not choose template era');
UPDATE vods SET recorded_at = '2025-01-01' WHERE id = 920001;
SELECT is((SELECT old_templates FROM vod_processing_context WHERE id = 920001), true, 'known old recording chooses old templates');
UPDATE vods SET recorded_at = NULL, template_version = 'current' WHERE id = 920001;
SELECT ok(claim_sfde_chunk((SELECT id FROM chunks WHERE vod_id = 920001 AND chunk_index = 0)), 'YouTube chunk claim works');
SELECT ok(NOT claim_sfde_chunk((SELECT id FROM chunks WHERE vod_id = 920001 AND chunk_index = 0)), 'YouTube duplicate worker is excluded');
INSERT INTO detections(chunk_id, vod_id, username, confidence, rank, frame_time_seconds)
SELECT id, vod_id, 'YouTubeFixture', 0.99, 'gold', 14 FROM chunks WHERE vod_id = 920001 AND chunk_index = 0;
SET LOCAL ROLE anon;
SELECT is((SELECT video_url FROM search_video_detections('YouTubeFixture', 'youtube')),
  'https://www.youtube.com/watch?v=YouTube0001&t=14s', 'public backend search returns a YouTube timestamp link');
SELECT ok((SELECT recorded_timestamp IS NULL FROM search_video_detections('YouTubeFixture', 'youtube')), 'unknown gameplay date remains unknown');
SELECT is((SELECT count(*)::integer FROM search_video_detections('YouTubeFixture', 'twitch')), 0, 'platform filter isolates results');
SELECT ok(NOT has_table_privilege('anon', 'platform_accounts', 'UPDATE'), 'anonymous callers cannot enable channels');
SELECT throws_ok('SELECT search_video_detections(result_limit => NULL)',
  'P0001', 'Invalid pagination', 'explicit null cannot bypass public search bounds');
RESET ROLE;
UPDATE platform_accounts SET processing_enabled = false WHERE id = '00000000-0000-4000-8000-000000920001';
SELECT ok(NOT claim_sfde_chunk((SELECT id FROM chunks WHERE vod_id = 920001 AND chunk_index = 1)), 'disabled YouTube account cannot claim');
UPDATE vods SET availability = 'unavailable' WHERE id = 920001;
SELECT is((SELECT count(*)::integer FROM search_video_detections('YouTubeFixture')), 0, 'unavailable YouTube source is hidden');
SELECT * FROM finish();
ROLLBACK;
