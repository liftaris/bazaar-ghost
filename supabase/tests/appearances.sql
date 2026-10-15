BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;
SELECT plan(10);
INSERT INTO sfde_profiles(id, profile_name, crop_region)
OVERRIDING SYSTEM VALUE VALUES (940001, 'appearances-test', ARRAY[0.5,0.5,0.4,0.2]);
INSERT INTO platform_accounts(id, source, source_id, display_name, processing_enabled, sfde_profile_id)
VALUES ('00000000-0000-4000-8000-000000940001', 'youtube', 'UC0000000000000000009400', 'Overlap fixture', true, 940001);
INSERT INTO vods(id, source, source_id, platform_account_id, duration_seconds,
  bazaar_chapters, ready_for_processing, notifications_enabled)
OVERRIDING SYSTEM VALUE VALUES
  (940001, 'youtube', 'Overlap0001', '00000000-0000-4000-8000-000000940001', 900, ARRAY[0,900], true, false),
  (940002, 'youtube', 'Overlap0002', '00000000-0000-4000-8000-000000940001', 900, ARRAY[0,900], true, false),
  (940003, 'youtube', 'Overlap0003', '00000000-0000-4000-8000-000000940001', 900, ARRAY[0,900], true, false);
INSERT INTO detections(id, chunk_id, vod_id, username, confidence, rank, frame_time_seconds)
SELECT ('00000000-0000-4000-8000-000000' || vod_id)::uuid, id, vod_id, 'OverlapFixture', 0.99, 'gold', 42
FROM chunks WHERE vod_id IN (940001,940002,940003);
SELECT is((SELECT COUNT(*)::integer FROM search_matchup_appearances('OverlapFixture')), 3, 'same username alone never merges footage');
CREATE TEMP TABLE linked AS SELECT link_matchup_appearances(ARRAY[
  '00000000-0000-4000-8000-000000940001'::uuid,
  '00000000-0000-4000-8000-000000940002'::uuid
], 'Fixture: reviewed matching source frames and surrounding sequence') AS id;
SELECT is(link_matchup_appearances(ARRAY[
  '00000000-0000-4000-8000-000000940001'::uuid,
  '00000000-0000-4000-8000-000000940002'::uuid
], 'Fixture: repeated verification'), (SELECT id FROM linked), 'repeat linking preserves the group identity');
SET LOCAL ROLE anon;
SELECT is((SELECT COUNT(*)::integer FROM search_matchup_appearances('OverlapFixture')), 2, 'verified copies occupy one result');
SELECT is((SELECT MAX(jsonb_array_length(appearances)) FROM search_matchup_appearances('OverlapFixture')), 2, 'both playable source appearances are retained');
SELECT is((SELECT total_count FROM search_matchup_appearances('OverlapFixture', NULL, 1)), 2::bigint, 'pagination counts groups before limiting');
SELECT ok(NOT has_function_privilege('anon', 'link_matchup_appearances(uuid[],text)', 'EXECUTE'), 'public users cannot merge matchups');
RESET ROLE;
UPDATE vods SET availability = 'unavailable' WHERE id = 940001;
SELECT is((SELECT COUNT(*)::integer FROM search_matchup_appearances('OverlapFixture')), 2, 'unavailable source does not hide a surviving verified copy');
SELECT is((SELECT jsonb_array_length(appearances) FROM search_matchup_appearances('OverlapFixture')
  WHERE matchup_id = (SELECT id FROM linked)), 1, 'only the surviving appearance is playable');
UPDATE vods SET availability = 'available' WHERE id = 940001;
SELECT ok(unlink_matchup_appearance('00000000-0000-4000-8000-000000940002'), 'verification can be reversed');
SELECT is((SELECT COUNT(*)::integer FROM search_matchup_appearances('OverlapFixture')), 3, 'unlink restores separate results without deleting detections');
SELECT * FROM finish();
ROLLBACK;
