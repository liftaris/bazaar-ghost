-- Allow historical VOD recovery to suppress notifications without affecting other VODs.
ALTER TABLE public.vods
ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT true;

-- Newer branches already implement per-VOD and platform notification guards.
-- Keep their function definition intact when reconciling migration histories.
DO $migration$
BEGIN
  IF POSITION('notifications_enabled' IN pg_get_functiondef('public.notify_on_detection()'::regprocedure)) = 0 THEN
    EXECUTE $definition$
CREATE OR REPLACE FUNCTION public.notify_on_detection()
RETURNS TRIGGER AS $$
DECLARE
  v_secret_key TEXT;
  v_supabase_url TEXT;
  v_vod RECORD;
  v_streamer_name TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.vods
    WHERE id = NEW.vod_id
      AND notifications_enabled = false
  ) THEN
    RETURN NEW;
  END IF;

  -- Get secrets from vault.
  SELECT decrypted_secret INTO v_secret_key
  FROM vault.decrypted_secrets
  WHERE name = 'secret_key'
  LIMIT 1;

  SELECT decrypted_secret INTO v_supabase_url
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_url'
  LIMIT 1;

  IF v_secret_key IS NULL OR v_supabase_url IS NULL THEN
    RAISE WARNING 'Missing vault secrets for notification';
    RETURN NEW;
  END IF;

  -- Preserve the existing notification payload and dispatch behavior.
  SELECT v.source_id, v.published_at, s.display_name
  INTO v_vod
  FROM public.vods v
  JOIN public.streamers s ON s.id = v.streamer_id
  WHERE v.id = NEW.vod_id;

  PERFORM net.http_post(
    url := v_supabase_url || '/functions/v1/ghost-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_secret_key
    ),
    body := jsonb_build_object(
      'action', 'notify',
      'username', NEW.username,
      'vod_id', NEW.vod_id,
      'frame_time_seconds', NEW.frame_time_seconds,
      'vod_source_id', v_vod.source_id,
      'vod_published_at', v_vod.published_at,
      'streamer_name', v_vod.display_name
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';
    $definition$;
  END IF;
END;
$migration$;
