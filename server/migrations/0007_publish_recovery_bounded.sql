-- =====================================================================
-- 0007 — Crash recovery of the publish queue gives up after the retry budget.
--
-- recover_stuck_publishing() (0001) puts a post that stayed 'publishing'
-- for ten minutes, and never reached the provider, back in the queue with one
-- more attempt counted. It never failed it: a post that stopped the publish
-- run every time was re-queued every fifteen minutes, forever, although the
-- comment promised it would "eventually leave the queue".
--
-- Same function, one change: at the retry budget (5 attempts, the API's
-- MAX_PUBLISH_ATTEMPTS in services/publish.ts) the post becomes 'failed',
-- with its error kept, instead of going back to the queue.
--
-- Idempotent (CREATE OR REPLACE); nothing is dropped, no row is rewritten
-- by the migration itself.
-- =====================================================================

CREATE OR REPLACE FUNCTION recover_stuck_publishing() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  -- Reached the provider: published, never sent a second time.
  UPDATE posts
     SET status = 'published',
         published_at = COALESCE(published_at, now())
   WHERE status = 'publishing'
     AND publishing_started_at IS NOT NULL
     AND publishing_started_at < now() - interval '10 minutes'
     AND provider_post_id IS NOT NULL;

  UPDATE posts
     SET status = CASE WHEN publish_attempts + 1 >= 5 THEN 'failed' ELSE 'validated' END,
         publish_attempts = publish_attempts + 1,
         next_publish_attempt_at = now() + interval '15 minutes',
         publishing_started_at = NULL,
         publish_error = COALESCE(publish_error, 'recovered_from_publishing_timeout')
   WHERE status = 'publishing'
     AND publishing_started_at IS NOT NULL
     AND publishing_started_at < now() - interval '10 minutes'
     AND provider_post_id IS NULL;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
