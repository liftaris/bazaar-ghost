BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;
SELECT plan(9);
INSERT INTO sfde_profiles(id, profile_name, crop_region)
OVERRIDING SYSTEM VALUE VALUES (930001, 'bilibili-test', ARRAY[0.5,0.5,0.4,0.2]);
INSERT INTO platform_accounts(id, source, source_id, display_name, processing_enabled, sfde_profile_id)
VALUES ('00000000-0000-4000-8000-000000930001', 'bilibili', '930001', 'Bilibili fixture', true, 930001);
INSERT INTO vods(id, source, source_id, source_video_id, source_part_id, source_part_index,
  platform_account_id, duration_seconds, bazaar_chapters, ready_for_processing, notifications_enabled)
OVERRIDING SYSTEM VALUE VALUES
  (930001, 'bilibili', 'BV0000000001:1001', 'BV0000000001', '1001', 1,
    '00000000-0000-4000-8000-000000930001', 1801, ARRAY[0,1801], true, false),
  (930002, 'bilibili', 'BV0000000001:1002', 'BV0000000001', '1002', 2,
    '00000000-0000-4000-8000-000000930001', 900, ARRAY[0,900], true, false);
SELECT is((SELECT COUNT(*)::integer FROM chunks WHERE vod_id = 930001), 2, 'first Bilibili part has its own chunks');
SELECT is((SELECT MAX(end_seconds) FROM chunks WHERE vod_id = 930002), 900, 'second part timeline starts at zero');
SELECT ok(claim_sfde_chunk((SELECT id FROM chunks WHERE vod_id = 930002)), 'Bilibili worker can claim a part');
INSERT INTO detections(chunk_id, vod_id, username, confidence, rank, frame_time_seconds)
SELECT id, vod_id, 'BilibiliFixture', 0.99, 'gold', 42 FROM chunks WHERE vod_id = 930002;
SET LOCAL ROLE anon;
SELECT is((SELECT video_url FROM search_video_detections('BilibiliFixture', 'bilibili')),
  'https://www.bilibili.com/video/BV0000000001/?p=2&t=42', 'watch link selects part two and part-relative timestamp');
SELECT is((SELECT embed_url FROM search_video_detections('BilibiliFixture', 'bilibili')),
  'https://player.bilibili.com/player.html?bvid=BV0000000001&cid=1002&t=42&autoplay=0&danmaku=0',
  'embed link uses stable cid');
SELECT is((SELECT COUNT(*)::integer FROM search_video_detections('BilibiliFixture', 'youtube')), 0, 'platform searches stay isolated');
SELECT is((SELECT COUNT(*)::integer FROM vod_stats WHERE id IN (930001,930002)), 0, 'legacy Twitch catalog excludes Bilibili');
RESET ROLE;
UPDATE vods SET source_part_index = 1 WHERE id = 930002;
SELECT is((SELECT source_id FROM vods WHERE id = 930002), 'BV0000000001:1002', 'part reorder preserves detection identity');
SELECT is(create_missing_chunks_for_vod(930002), 0, 'recataloging a reordered part remains idempotent');
SELECT * FROM finish();
ROLLBACK;
