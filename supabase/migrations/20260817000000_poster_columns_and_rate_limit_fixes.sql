-- =====================================================================
-- Follow-up audit fixes
--   1. Lock the server-owned columns on public.posts (poster job handles,
--      publish bookkeeping, validation tokens) against client writes.
--   2. Scope the IP rate-limit garbage collection to its own bucket.
--   3. Return the real total from recover_stuck_publishing().
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. SERVER-OWNED COLUMNS ON posts
--
-- RLS decides which ROWS a user may touch, never which COLUMNS. The posts
-- UPDATE policy therefore let the row owner write every column, including
-- ones only the server should set. The dangerous one is image_status_url:
-- publish-post feeds it to the Graphiste poller, which sends
-- `Authorization: Bearer GRAPHISTE_GPT_API_KEY`. A user who set that column
-- to their own https endpoint would have the cron hand them the API key.
-- (The poller is now origin-pinned in code as well — this is the second
-- layer, so the bad value can never be stored in the first place.)
--
-- The other columns are integrity, not secrecy: validation_token* drive the
-- email approval flow, provider_post_id / published_at / external_post_ids
-- are publish bookkeeping that recover_stuck_publishing() trusts, and
-- user_id must never move a row to another account.
--
-- Grant back exactly the columns the dashboard writes:
--   title, content, platforms, scheduled_for  (edit + calendar reschedule)
--   image_url                                 (regenerate/clear the poster)
--   status, publish_error                     (validate + retry)
-- ---------------------------------------------------------------------
REVOKE UPDATE ON public.posts FROM authenticated;
GRANT UPDATE (
  title,
  content,
  platforms,
  scheduled_for,
  image_url,
  status,
  publish_error
) ON public.posts TO authenticated;

-- ---------------------------------------------------------------------
-- 2. RATE-LIMIT GC
--
-- The opportunistic cleanup deleted rows for EVERY bucket using the calling
-- bucket's window (`created_at < now() - window * 4`). A caller with a short
-- window therefore wiped the history of buckets with longer windows, letting
-- their limits be bypassed. Delete only within the bucket we hold the
-- advisory lock for, which is also the only bucket this call can reason
-- about.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hit_ip_rate_limit(
  p_bucket text,
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
  PERFORM pg_advisory_xact_lock(hashtextextended(p_bucket, 0));
  -- Opportunistic GC, scoped to this bucket only.
  DELETE FROM public.ip_rate_events
   WHERE bucket = p_bucket
     AND created_at < now() - make_interval(secs => p_window_seconds * 4);
  SELECT count(*) INTO used
    FROM public.ip_rate_events
   WHERE bucket = p_bucket
     AND created_at >= now() - make_interval(secs => p_window_seconds);
  IF used >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.ip_rate_events (bucket) VALUES (p_bucket);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.hit_ip_rate_limit(text, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.hit_ip_rate_limit(text, integer, integer) TO service_role;

-- Bucket-scoped GC only runs for buckets that are still being hit, so sweep
-- abandoned buckets on a bounded schedule instead of leaking rows forever.
-- Retention is generous (24h) — every window in use is an hour or less.
CREATE OR REPLACE FUNCTION public.gc_ip_rate_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.ip_rate_events WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.gc_ip_rate_events() FROM public;
GRANT EXECUTE ON FUNCTION public.gc_ip_rate_events() TO service_role;

-- ---------------------------------------------------------------------
-- 3. recover_stuck_publishing() RETURN VALUE
--
-- GET DIAGNOSTICS reports the row count of the LAST statement only, so the
-- function returned just the re-queued posts and reported 0 whenever the
-- only recovered rows were the ones marked published. Count both.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_stuck_publishing()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  marked_published integer;
  requeued integer;
BEGIN
  UPDATE public.posts
     SET status = 'published',
         published_at = COALESCE(published_at, now())
   WHERE status = 'publishing'
     AND auto_publish_attempted_at IS NOT NULL
     AND auto_publish_attempted_at < now() - interval '10 minutes'
     AND provider_post_id IS NOT NULL;
  GET DIAGNOSTICS marked_published = ROW_COUNT;

  UPDATE public.posts
     SET status = 'validated',
         publish_error = COALESCE(publish_error, 'recovered_from_publishing_timeout')
   WHERE status = 'publishing'
     AND auto_publish_attempted_at IS NOT NULL
     AND auto_publish_attempted_at < now() - interval '10 minutes'
     AND provider_post_id IS NULL;
  GET DIAGNOSTICS requeued = ROW_COUNT;

  RETURN marked_published + requeued;
END;
$$;
REVOKE ALL ON FUNCTION public.recover_stuck_publishing() FROM public;
GRANT EXECUTE ON FUNCTION public.recover_stuck_publishing() TO service_role;
