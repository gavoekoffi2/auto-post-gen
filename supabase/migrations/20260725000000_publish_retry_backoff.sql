-- =====================================================================
-- Bounded publish retries with backoff.
--
-- The cron publisher selected the 12 oldest due posts on every tick:
--
--   status = 'validated' AND scheduled_for <= now()  ORDER BY scheduled_for
--
-- A post that cannot publish (typically the default state of a new user:
-- no social network connected yet) is put straight back to 'validated'
-- with its scheduled_for still in the past. It is therefore due again on
-- the very next tick, and being the oldest, it is picked first. Once a
-- user accumulates 12 such posts they permanently occupy the batch and
-- NO new post ever publishes again — for that user or, since the batch is
-- global, for anyone whose posts sort after them.
--
-- This adds an attempt counter so retries back off and eventually stop,
-- which both unblocks the queue and surfaces the failure to the user.
-- =====================================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.posts.publish_attempts IS
  'Number of publish attempts made. Drives retry backoff and the give-up threshold; reset to 0 when the user explicitly retries.';

-- Posts genuinely ready for another publish attempt.
--   attempt 0 -> immediately
--   attempt 1 -> +15 min, 2 -> +30 min, 3 -> +1 h, 4 -> +2 h, 5+ -> +4 h (capped)
-- Posts at or over the give-up threshold are excluded entirely; the
-- publisher marks them 'failed' so they leave the queue and become visible
-- in the dashboard, where the existing "Réessayer" button revives them.
CREATE OR REPLACE FUNCTION public.due_posts_for_publishing(
  p_limit integer DEFAULT 12,
  p_max_attempts integer DEFAULT 6
) RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.id
    FROM public.posts p
   WHERE p.status = 'validated'
     AND p.scheduled_for IS NOT NULL
     AND p.scheduled_for <= now()
     AND p.publish_attempts < p_max_attempts
     AND (
       p.auto_publish_attempted_at IS NULL
       OR p.publish_attempts = 0
       OR p.auto_publish_attempted_at <
            now() - make_interval(mins => LEAST(240, 15 * (2 ^ LEAST(p.publish_attempts - 1, 4))::integer))
     )
   ORDER BY p.scheduled_for ASC
   LIMIT GREATEST(1, p_limit);
$$;

REVOKE ALL ON FUNCTION public.due_posts_for_publishing(integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.due_posts_for_publishing(integer, integer) TO service_role;

-- Posts that already exhausted their attempts before this migration existed
-- would otherwise sit at attempt 0 and keep looping. Give the publisher a
-- clean starting point by counting a prior attempt where one is recorded.
UPDATE public.posts
   SET publish_attempts = 1
 WHERE status = 'validated'
   AND publish_attempts = 0
   AND auto_publish_attempted_at IS NOT NULL;
