-- Add YouTube accounts and platform-aware processing while retaining Twitch identities.
CREATE TABLE public.platform_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('twitch', 'youtube')),
  source_id text NOT NULL,
  display_name text NOT NULL,
  streamer_id bigint REFERENCES public.streamers(id),
  sfde_profile_id bigint NOT NULL DEFAULT 1 REFERENCES public.sfde_profiles(id),
  processing_enabled boolean NOT NULL DEFAULT false,
  catalog_cursor integer NOT NULL DEFAULT 1 CHECK (catalog_cursor > 0),
  archive_cursor integer NOT NULL DEFAULT 1 CHECK (archive_cursor > 0),
  last_cataloged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_id),
  UNIQUE (id, source)
);
ALTER TABLE public.platform_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON public.platform_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY public_read ON public.platform_accounts FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.platform_accounts TO anon, authenticated;
GRANT ALL ON public.platform_accounts TO service_role;

ALTER TABLE public.vods
  ADD COLUMN platform_account_id uuid,
  ADD COLUMN sfde_profile_id bigint REFERENCES public.sfde_profiles(id),
  ADD COLUMN recorded_at timestamptz,
  ADD COLUMN template_version text NOT NULL DEFAULT 'auto' CHECK (template_version IN ('auto', 'old', 'current')),
  ADD COLUMN content_kind text NOT NULL DEFAULT 'archive' CHECK (content_kind IN ('archive', 'upload')),
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT vods_platform_account_source_fkey FOREIGN KEY (platform_account_id, source)
    REFERENCES public.platform_accounts(id, source);
CREATE INDEX vods_platform_account_idx ON public.vods(platform_account_id);

-- New accounts have their own enablement/profile; a Twitch streamer link is optional.
CREATE VIEW public.vod_processing_context WITH (security_invoker = true) AS
SELECT v.id, v.source, v.source_id, v.availability, v.ready_for_processing,
  v.published_at, v.recorded_at, v.platform_account_id, v.streamer_id,
  COALESCE(a.display_name, s.login) AS creator_name,
  CASE WHEN v.platform_account_id IS NOT NULL THEN a.processing_enabled
       ELSE COALESCE(s.processing_enabled, false) END AS processing_enabled,
  CASE WHEN v.template_version = 'old' THEN true
       WHEN v.template_version = 'current' THEN false
       ELSE COALESCE(CASE WHEN v.source = 'twitch' THEN v.published_at ELSE v.recorded_at END
         < '2025-08-12T00:00:00Z'::timestamptz, false) END AS old_templates,
  to_jsonb(p.*) AS profile
FROM public.vods v
LEFT JOIN public.platform_accounts a ON a.id = v.platform_account_id
LEFT JOIN public.streamers s ON s.id = v.streamer_id
JOIN public.sfde_profiles p ON p.id = COALESCE(v.sfde_profile_id, a.sfde_profile_id, s.sfde_profile_id, 1);
GRANT SELECT ON public.vod_processing_context TO service_role;
REVOKE ALL ON public.vod_processing_context FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_sfde_chunk(p_chunk_id uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE chunks c SET status = 'processing', started_at = NOW(), completed_at = NULL,
    last_error = NULL, attempt_count = COALESCE(attempt_count, 0) + 1,
    lease_expires_at = NOW() + INTERVAL '35 minutes'
  FROM vod_processing_context v
  WHERE c.id = p_chunk_id AND c.vod_id = v.id AND c.status IN ('pending', 'queued')
    AND v.availability = 'available' AND v.ready_for_processing AND v.processing_enabled;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.simulate_chunk_plan_for_vod(
  p_vod_id bigint, p_target_chunk_seconds integer DEFAULT 1800, p_min_gap_seconds integer DEFAULT 1
) RETURNS TABLE(segment_start integer, segment_end integer, gap_start integer, gap_end integer,
  proposed_chunk_start integer, proposed_chunk_end integer, proposed_duration integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vod vods%ROWTYPE;
  v_existing int4multirange;
  v_segments int4multirange := '{}';
  v_gap int4range;
  v_segment int4range;
  v_start integer;
  v_end integer;
  v_i integer;
BEGIN
  IF p_target_chunk_seconds <= 0 OR p_min_gap_seconds <= 0 THEN
    RAISE EXCEPTION 'Chunk and minimum gap durations must be positive';
  END IF;
  SELECT * INTO v_vod FROM vods WHERE id = p_vod_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM vod_processing_context
    WHERE id = p_vod_id AND processing_enabled AND ready_for_processing AND availability = 'available')
    OR COALESCE(v_vod.duration_seconds, 0) <= 0 THEN RETURN; END IF;
  IF COALESCE(cardinality(v_vod.bazaar_chapters), 0) = 0 THEN RETURN; END IF;
  IF cardinality(v_vod.bazaar_chapters) % 2 <> 0 THEN
    RAISE EXCEPTION 'Bazaar chapters must contain start/end pairs';
  END IF;
  FOR v_i IN 1..cardinality(v_vod.bazaar_chapters) BY 2 LOOP
    v_start := GREATEST(0, v_vod.bazaar_chapters[v_i]);
    v_end := LEAST(v_vod.duration_seconds, v_vod.bazaar_chapters[v_i + 1]);
    IF v_end > v_start THEN
      v_segments := v_segments + int4multirange(int4range(v_start, v_end, '[)'));
    END IF;
  END LOOP;
  SELECT COALESCE(range_agg(int4range(start_seconds, end_seconds, '[)')), '{}')
    INTO v_existing FROM chunks WHERE vod_id = p_vod_id;
  FOR v_segment IN SELECT unnest(v_segments) LOOP
    FOR v_gap IN SELECT unnest(int4multirange(v_segment) - v_existing) LOOP
      v_start := lower(v_gap);
      IF upper(v_gap) - v_start < p_min_gap_seconds THEN CONTINUE; END IF;
      WHILE v_start < upper(v_gap) LOOP
        v_end := LEAST(v_start + p_target_chunk_seconds, upper(v_gap));
        segment_start := lower(v_segment); segment_end := upper(v_segment);
        gap_start := lower(v_gap); gap_end := upper(v_gap);
        proposed_chunk_start := v_start; proposed_chunk_end := v_end;
        proposed_duration := v_end - v_start;
        RETURN NEXT;
        v_start := v_end;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_chunks_for_vod(
  p_vod_id bigint DEFAULT NULL, p_source_id text DEFAULT NULL
) RETURNS TABLE(chunk_id uuid, vod_id bigint, source_id text, chunk_index integer,
  start_seconds integer, end_seconds integer, status public.processing_status, attempt_count integer)
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (p_vod_id IS NULL) = (p_source_id IS NULL) THEN RAISE EXCEPTION 'Provide exactly one VOD identifier'; END IF;
  RETURN QUERY SELECT c.id, c.vod_id, v.source_id, c.chunk_index, c.start_seconds, c.end_seconds, c.status, c.attempt_count
  FROM chunks c JOIN vod_processing_context v ON v.id = c.vod_id
  WHERE (v.id = p_vod_id OR (v.source = 'twitch' AND v.source_id = p_source_id))
    AND c.status = 'pending' AND c.scheduled_for <= NOW()
    AND v.availability = 'available' AND v.ready_for_processing AND v.processing_enabled
  ORDER BY c.priority DESC, c.chunk_index;
END;
$$;

CREATE FUNCTION public.create_account_chunks() RETURNS trigger LANGUAGE plpgsql
SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF NEW.processing_enabled AND NOT OLD.processing_enabled THEN
    FOR v_id IN SELECT id FROM vods WHERE platform_account_id = NEW.id LOOP
      PERFORM create_missing_chunks_for_vod(v_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_enabled_chunks AFTER UPDATE OF processing_enabled ON public.platform_accounts
  FOR EACH ROW EXECUTE FUNCTION public.create_account_chunks();

CREATE OR REPLACE FUNCTION public.process_pending_vods(max_vods integer DEFAULT 5)
RETURNS TABLE(vod_id bigint, source_id text, pending_chunks bigint, request_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url text; v_key text; v_limit integer; v_active integer; v_vod record; v_request bigint;
BEGIN
  IF max_vods < 1 OR max_vods > 100 THEN RAISE EXCEPTION 'max_vods must be between 1 and 100'; END IF;
  PERFORM recover_expired_chunks();
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'secret_key' LIMIT 1;
  IF v_url IS NULL OR v_key IS NULL THEN RAISE EXCEPTION 'Configure supabase_url and secret_key in Vault'; END IF;
  SELECT COALESCE((SELECT value::integer FROM processing_config WHERE key = 'max_concurrent_chunks'), 10) INTO v_limit;
  SELECT COUNT(*) INTO v_active FROM chunks WHERE status IN ('queued', 'processing');
  IF v_active >= v_limit THEN RETURN; END IF;
  FOR v_vod IN
    SELECT v.id, v.source_id, COUNT(*) AS pending_chunks
    FROM vod_processing_context v JOIN chunks c ON c.vod_id = v.id
    WHERE v.ready_for_processing AND v.availability = 'available' AND v.processing_enabled
      AND c.status = 'pending' AND c.scheduled_for <= NOW()
    GROUP BY v.id, v.source_id, v.published_at
    ORDER BY MAX(c.priority) DESC, MIN(c.attempt_count), v.published_at DESC LIMIT max_vods
  LOOP
    SELECT net.http_post(url := v_url || '/functions/v1/process-vod',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('vod_id', v_vod.id), timeout_milliseconds := 30000) INTO v_request;
    RETURN QUERY SELECT v_vod.id, v_vod.source_id, v_vod.pending_chunks, v_request;
    v_active := v_active + v_vod.pending_chunks;
    EXIT WHEN v_active >= v_limit;
  END LOOP;
END;
$$;

-- A separate contract keeps the existing Twitch-only player working during backend rollout.
CREATE VIEW public.video_detections WITH (security_invoker = true) AS
SELECT d.id AS detection_id, d.username, d.confidence, d.rank, d.frame_time_seconds,
  d.storage_path, d.truncated, d.igd, d.created_at AS indexed_at,
  v.id AS vod_id, v.source, v.source_id, v.title, v.published_at, v.recorded_at,
  v.platform_account_id, v.streamer_id, COALESCE(a.display_name, s.display_name, s.login) AS creator_name,
  CASE v.source WHEN 'youtube' THEN 'https://www.youtube.com/watch?v=' || v.source_id || '&t=' || d.frame_time_seconds || 's'
    WHEN 'twitch' THEN 'https://www.twitch.tv/videos/' || v.source_id || '?t=' || d.frame_time_seconds || 's' END AS video_url,
  CASE WHEN v.source = 'twitch' THEN COALESCE(v.recorded_at, v.published_at)
       ELSE v.recorded_at END + make_interval(secs => d.frame_time_seconds) AS recorded_timestamp
FROM public.detections d JOIN public.vods v ON v.id = d.vod_id
LEFT JOIN public.platform_accounts a ON a.id = v.platform_account_id
LEFT JOIN public.streamers s ON s.id = v.streamer_id
WHERE v.availability = 'available' AND d.confidence > 0.7;
GRANT SELECT ON public.video_detections TO anon, authenticated, service_role;

CREATE FUNCTION public.search_video_detections(
  search_query text DEFAULT NULL, source_filter text DEFAULT NULL,
  account_filter uuid DEFAULT NULL, video_filter bigint DEFAULT NULL,
  result_limit integer DEFAULT 100, result_offset integer DEFAULT 0
) RETURNS SETOF public.video_detections LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, extensions AS $$
BEGIN
  IF result_limit < 1 OR result_limit > 500 OR result_offset < 0 THEN RAISE EXCEPTION 'Invalid pagination'; END IF;
  RETURN QUERY SELECT d.* FROM video_detections d
  WHERE (search_query IS NULL OR search_query = '' OR d.username ILIKE '%' || search_query || '%')
    AND (source_filter IS NULL OR d.source = source_filter)
    AND (account_filter IS NULL OR d.platform_account_id = account_filter)
    AND (video_filter IS NULL OR d.vod_id = video_filter)
  ORDER BY d.indexed_at DESC, d.detection_id LIMIT result_limit OFFSET result_offset;
END;
$$;
GRANT EXECUTE ON FUNCTION public.search_video_detections(text,text,uuid,bigint,integer,integer)
  TO anon, authenticated, service_role;

-- Suppress historical YouTube notifications until an explicit notification mode is enabled.
CREATE OR REPLACE FUNCTION public.notify_on_detection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_key text; v_url text; v_video record;
BEGIN
  SELECT v.source, v.source_id, v.published_at, v.recorded_at, v.notifications_enabled,
    COALESCE(a.display_name, s.display_name, s.login) AS creator_name INTO v_video
  FROM vods v LEFT JOIN streamers s ON s.id = v.streamer_id
  LEFT JOIN platform_accounts a ON a.id = v.platform_account_id WHERE v.id = NEW.vod_id;
  IF NOT v_video.notifications_enabled OR v_video.source <> 'twitch' THEN RETURN NEW; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'secret_key' LIMIT 1;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
  IF v_key IS NULL OR v_url IS NULL THEN RETURN NEW; END IF;
  PERFORM net.http_post(url := v_url || '/functions/v1/ghost-bot',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object('action', 'notify', 'username', NEW.username, 'vod_id', NEW.vod_id,
      'frame_time_seconds', NEW.frame_time_seconds, 'vod_source_id', v_video.source_id,
      'vod_published_at', v_video.published_at, 'streamer_name', v_video.creator_name));
  RETURN NEW;
END;
$$;
