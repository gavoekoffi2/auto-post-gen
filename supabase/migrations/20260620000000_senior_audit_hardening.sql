-- =====================================================================
-- Senior audit hardening
--   1. Atomic per-user generation quota (closes the rate-limit bypass).
--   2. Safer stuck-publish recovery (no double-posting).
--   3. Lock down user-writable columns on social_connections / social_comments.
--   4. Track when a validation email was sent (stop resetting the token TTL).
-- =====================================================================

-- 1. ATOMIC QUOTA -----------------------------------------------------
-- The old check was "count rows, then later insert" — concurrent requests all
-- read the same count and slipped past the limit, allowing unbounded AI spend.
-- This function serializes per (user, function) with an advisory lock, counts
-- within the window, and inserts the usage row in the same transaction.
CREATE OR REPLACE FUNCTION public.consume_generation_quota(
  p_user uuid,
  p_function text,
  p_max integer,
  p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  used integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_function, 0));
  SELECT count(*) INTO used
    FROM public.generation_usage
   WHERE user_id = p_user
     AND function_name = p_function
     AND created_at >= now() - make_interval(secs => p_window_seconds);
  IF used >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.generation_usage (user_id, function_name, status)
  VALUES (p_user, p_function, 'reserved');
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_generation_quota(uuid, text, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.consume_generation_quota(uuid, text, integer, integer) TO service_role;

-- 2. SAFER RECOVERY ---------------------------------------------------
-- A post stuck in 'publishing' may already have been posted at the provider
-- (the function crashed after the external call but before the status update).
-- Re-queueing it to 'validated' caused double-posting. Posts that already
-- recorded a provider_post_id are marked published; only those without one are
-- retried.
CREATE OR REPLACE FUNCTION public.recover_stuck_publishing()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.posts
     SET status = 'published',
         published_at = COALESCE(published_at, now())
   WHERE status = 'publishing'
     AND auto_publish_attempted_at IS NOT NULL
     AND auto_publish_attempted_at < now() - interval '10 minutes'
     AND provider_post_id IS NOT NULL;

  UPDATE public.posts
     SET status = 'validated',
         publish_error = COALESCE(publish_error, 'recovered_from_publishing_timeout')
   WHERE status = 'publishing'
     AND auto_publish_attempted_at IS NOT NULL
     AND auto_publish_attempted_at < now() - interval '10 minutes'
     AND provider_post_id IS NULL;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
REVOKE ALL ON FUNCTION public.recover_stuck_publishing() FROM public;
GRANT EXECUTE ON FUNCTION public.recover_stuck_publishing() TO service_role;

-- 3. COLUMN-LEVEL WRITE LOCKS ----------------------------------------
-- social_connections: the browser only ever SELECTs status and DELETEs to
-- disconnect — it never UPDATEs. Revoke UPDATE so a user cannot overwrite their
-- own access_token / refresh_token / profile_key (profile_key routes publishing
-- through a provider profile; spoofing it could post through the wrong account).
REVOKE UPDATE ON public.social_connections FROM authenticated;

-- social_comments: the browser only curates the `status` column ("ignored").
-- Revoke blanket UPDATE and grant back just that column so server-owned reply
-- columns (reply_text, reply_external_id, raw, …) cannot be spoofed by a user.
REVOKE UPDATE ON public.social_comments FROM authenticated;
GRANT UPDATE (status) ON public.social_comments TO authenticated;

-- 4. VALIDATION EMAIL TRACKING ---------------------------------------
-- send-validation-email previously re-emailed every pending post on each run
-- AND reset validation_token_created_at, so the 24h token TTL never actually
-- expired. Track when the email was sent so we only send once.
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS validation_email_sent_at timestamptz;
