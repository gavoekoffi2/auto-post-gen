-- =====================================================================
-- Publish queue: bounded retries + backoff.
--
-- The cron picks due posts with `status = 'validated' AND scheduled_for <=
-- now()` ordered by scheduled_for ASC with a small LIMIT. A post that cannot
-- publish (no social account connected, or a provider that only ever queues
-- the job) was written back as 'validated' with its scheduled_for still in the
-- past, so it was re-selected on EVERY tick, forever. Because the batch is
-- both ordered oldest-first and capped, a handful of such posts permanently
-- occupied the whole batch and starved every newer post in the queue.
--
-- This migration gives the queue the two things it was missing: a record of
-- how many times a post was attempted, and a time before which it must not be
-- attempted again. publish-post uses both to back off and, after a bounded
-- number of failures, to move the post to 'failed' so the user sees it in the
-- dashboard (with the per-platform reason and a "Réessayer" button) instead of
-- it silently blocking the queue.
-- =====================================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_publish_attempt_at timestamptz NOT NULL DEFAULT now();

-- NOT NULL with a now() default keeps the cron predicate a single plain
-- comparison (`next_publish_attempt_at <= now()`), which the index below can
-- serve directly — instead of an OR against NULL for never-attempted posts.
UPDATE public.posts SET next_publish_attempt_at = COALESCE(next_publish_attempt_at, created_at, now())
 WHERE next_publish_attempt_at IS NULL;

COMMENT ON COLUMN public.posts.publish_attempts IS
  'Number of publish attempts that did not result in a confirmed publish. Reset when a user retries manually.';
COMMENT ON COLUMN public.posts.next_publish_attempt_at IS
  'Cron must not re-attempt this post before this instant (retry backoff). Defaults to now(), i.e. eligible immediately.';

-- The cron''s selection index has to cover the new backoff predicate, otherwise
-- the added filter turns the queue scan into a sequential scan as posts pile up.
DROP INDEX IF EXISTS idx_posts_status_scheduled;
CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled
  ON public.posts (status, scheduled_for, next_publish_attempt_at)
  WHERE status = 'validated';

-- Clients may reset the retry state when a user explicitly retries, but they
-- must not be able to hand themselves unlimited publish attempts by rewriting
-- the counter to a negative number.
ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_publish_attempts_nonneg;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_publish_attempts_nonneg CHECK (publish_attempts >= 0) NOT VALID;
ALTER TABLE public.posts VALIDATE CONSTRAINT posts_publish_attempts_nonneg;

-- A post recovered from a crashed 'publishing' run is a real attempt too:
-- count it, so a post that repeatedly kills the function eventually leaves the
-- queue instead of being re-queued forever.
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
         publish_attempts = publish_attempts + 1,
         next_publish_attempt_at = now() + interval '15 minutes',
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
