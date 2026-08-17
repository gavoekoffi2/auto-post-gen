-- =====================================================================
-- Retention, hot-path indexes and integrity constraints.
--
-- Three classes of problem, all of which only bite once the product has real
-- usage — which is exactly when they are hardest to fix:
--   1. Two tables grow without bound and sit on hot paths.
--   2. Queries the code runs on every request have no supporting index.
--   3. Values the code depends on are not constrained at the database level.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RETENTION
--
-- generation_usage is the quota ledger: EVERY rate-limited call inserts a row,
-- and every rate-limited call then counts rows in it. It was never pruned, so
-- the table (and the cost of each quota check) grows forever. The widest window
-- any caller asks for is 30 days, so anything older can never affect a
-- decision — keep 90 days for admin reporting headroom and drop the rest.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gc_generation_usage(p_keep_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.generation_usage
   WHERE created_at < now() - make_interval(days => GREATEST(p_keep_days, 30));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.gc_generation_usage(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.gc_generation_usage(integer) TO service_role;

-- One entry point the publish cron can call to keep every housekeeping table
-- bounded, so adding a new one later does not need a new scheduled job.
CREATE OR REPLACE FUNCTION public.run_maintenance()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  usage_removed integer;
  rate_removed integer;
BEGIN
  usage_removed := public.gc_generation_usage(90);
  rate_removed := public.gc_ip_rate_events();
  RETURN jsonb_build_object(
    'generation_usage_removed', usage_removed,
    'ip_rate_events_removed', rate_removed
  );
END;
$$;
REVOKE ALL ON FUNCTION public.run_maintenance() FROM public;
GRANT EXECUTE ON FUNCTION public.run_maintenance() TO service_role;

-- ---------------------------------------------------------------------
-- 2. HOT-PATH INDEXES
-- ---------------------------------------------------------------------

-- consume_generation_quota counts (user_id, function_name) inside a time
-- window on every rate-limited request. The existing index is
-- (user_id, created_at), so the function_name filter was resolved by scanning
-- every row the user ever produced.
CREATE INDEX IF NOT EXISTS idx_generation_usage_user_function_created
  ON public.generation_usage (user_id, function_name, created_at DESC);

-- sync-comments looks a published post up by its provider id, once per synced
-- post. Partial: only published posts ever carry one.
CREATE INDEX IF NOT EXISTS idx_posts_provider_post_id
  ON public.posts (user_id, provider_post_id)
  WHERE provider_post_id IS NOT NULL;

-- The comment inbox de-duplicates by external id before every insert batch.
CREATE INDEX IF NOT EXISTS idx_social_comments_user_external
  ON public.social_comments (user_id, external_comment_id);

-- The dashboard resumes unfinished poster jobs on every load; publish-post
-- does the same per due post. Partial so the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_posts_image_processing
  ON public.posts (user_id)
  WHERE image_status = 'processing' AND image_url IS NULL;

-- auto-generate-weekly scans profiles with auto_publish enabled on each run.
CREATE INDEX IF NOT EXISTS idx_profiles_auto_publish
  ON public.profiles (id)
  WHERE auto_publish = true;

-- ---------------------------------------------------------------------
-- 3. INTEGRITY CONSTRAINTS
--
-- The edge functions already clamp these values, but the database is the last
-- line: a bad row written by a future code path (or by hand) would otherwise
-- silently produce nonsense schedules or unbounded generation.
-- ---------------------------------------------------------------------

-- publish-post and the generator both treat platforms as a non-empty list.
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_platforms_not_empty;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_platforms_not_empty
  CHECK (platforms IS NOT NULL AND array_length(platforms, 1) >= 1) NOT VALID;

-- HARD_MAX_POSTS_PER_RUN is 20; anything above that is a misconfiguration.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_post_frequency_range;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_post_frequency_range
  CHECK (post_frequency BETWEEN 1 AND 20) NOT VALID;

-- preferred_time is parsed as HH:MM by the generator.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_preferred_time_format;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_preferred_time_format
  CHECK (preferred_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;

-- Repair rows that predate the constraints, then enforce them going forward.
UPDATE public.posts
   SET platforms = ARRAY['Instagram']
 WHERE platforms IS NULL OR array_length(platforms, 1) IS NULL;

UPDATE public.profiles
   SET post_frequency = LEAST(GREATEST(COALESCE(post_frequency, 2), 1), 20)
 WHERE post_frequency IS NULL OR post_frequency < 1 OR post_frequency > 20;

UPDATE public.profiles
   SET preferred_time = '10:00'
 WHERE preferred_time IS NULL
    OR preferred_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';

ALTER TABLE public.posts VALIDATE CONSTRAINT posts_platforms_not_empty;
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_post_frequency_range;
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_preferred_time_format;
