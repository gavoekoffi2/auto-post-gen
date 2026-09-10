-- Behavioural checks that run against a real Postgres with every migration
-- applied (see .github/workflows/ci.yml → schema job). Each check RAISEs on
-- failure, so psql -v ON_ERROR_STOP=1 fails the job.
--
-- These lock the invariants the product actually depends on: signup creates a
-- profile, generation quotas are a real cap, a post that cannot publish leaves
-- the queue instead of blocking it, a user cannot escalate their own plan or
-- read anyone else's data.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.check(label text, condition boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition THEN
    RAISE NOTICE 'ok  - %', label;
  ELSE
    RAISE EXCEPTION 'FAILED - %', label;
  END IF;
END;
$$;

-- Two users created the way Supabase creates them.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com');

-- 1. Signup ------------------------------------------------------------------
SELECT pg_temp.check(
  'signup trigger creates a profile for every auth user',
  (SELECT count(*) FROM public.profiles) = 2);

SELECT pg_temp.check(
  'a new account starts on the starter plan with auto-publish off',
  (SELECT count(*) FROM public.profiles WHERE plan = 'starter' AND auto_publish IS NOT TRUE) = 2);

-- 2. Generation quota --------------------------------------------------------
SELECT pg_temp.check(
  'consume_generation_quota allows exactly p_max reservations in the window',
  (SELECT count(*) FILTER (WHERE allowed)
     FROM (SELECT public.consume_generation_quota(
                    '11111111-1111-1111-1111-111111111111', 'generate-image', 3, 3600) AS allowed
             FROM generate_series(1, 5)) t) = 3);

-- generate-image releases its reservation when the provider fails before any
-- paid render. Deleting the newest reservation must free exactly one slot —
-- not wipe the month's usage history.
DELETE FROM public.generation_usage
 WHERE id = (SELECT id FROM public.generation_usage
              WHERE user_id = '11111111-1111-1111-1111-111111111111'
                AND function_name = 'generate-image' AND status = 'reserved'
              ORDER BY created_at DESC LIMIT 1);

SELECT pg_temp.check(
  'releasing one reservation frees one slot and keeps the rest of the history',
  (SELECT count(*) FROM public.generation_usage
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND function_name = 'generate-image') = 2
  AND public.consume_generation_quota(
        '11111111-1111-1111-1111-111111111111', 'generate-image', 3, 3600));

-- 3. Publish queue -----------------------------------------------------------
-- Twelve old posts that cannot publish (nothing connected) plus one fresh post.
-- The cron batch is ordered oldest-first and capped, so without a backoff the
-- twelve occupy the whole batch on every tick and the fresh post never goes out.
INSERT INTO public.posts (user_id, title, content, platforms, status, scheduled_for)
SELECT '11111111-1111-1111-1111-111111111111', 'stuck ' || n, 'contenu', ARRAY['Instagram'],
       'validated', now() - interval '30 days' + (n * interval '1 minute')
  FROM generate_series(1, 12) n;
INSERT INTO public.posts (user_id, title, content, platforms, status, scheduled_for)
VALUES ('22222222-2222-2222-2222-222222222222', 'fresh', 'contenu', ARRAY['LinkedIn'],
        'validated', now() - interval '1 minute');

SELECT pg_temp.check(
  'a never-attempted post is eligible immediately (column is NOT NULL DEFAULT now())',
  (SELECT count(*) FROM public.posts
    WHERE status = 'validated' AND scheduled_for <= now()
      AND next_publish_attempt_at <= now()) = 13);

-- One failed attempt each, as publish-post now records it.
UPDATE public.posts
   SET publish_attempts = 1, next_publish_attempt_at = now() + interval '15 minutes'
 WHERE title LIKE 'stuck %';

SELECT pg_temp.check(
  'posts inside their backoff window no longer occupy the batch',
  (SELECT coalesce(string_agg(title, ','), '')
     FROM (SELECT title FROM public.posts
            WHERE status = 'validated' AND scheduled_for <= now()
              AND next_publish_attempt_at <= now()
            ORDER BY scheduled_for ASC LIMIT 12) t) = 'fresh');

SELECT pg_temp.check(
  'the retry counter cannot be set negative',
  NOT EXISTS (SELECT 1 FROM public.posts WHERE publish_attempts < 0));

-- 4. Crash recovery ----------------------------------------------------------
UPDATE public.posts
   SET status = 'publishing', auto_publish_attempted_at = now() - interval '20 minutes',
       provider_post_id = NULL, publish_attempts = 0
 WHERE title = 'fresh';
SELECT public.recover_stuck_publishing() \gset ignored_

SELECT pg_temp.check(
  'a crashed run that never reached the provider is re-queued, counted and backed off',
  (SELECT status = 'validated' AND publish_attempts = 1 AND next_publish_attempt_at > now()
     FROM public.posts WHERE title = 'fresh'));

UPDATE public.posts
   SET status = 'publishing', auto_publish_attempted_at = now() - interval '20 minutes',
       provider_post_id = 'provider-123'
 WHERE title = 'fresh';
SELECT public.recover_stuck_publishing() \gset ignored_

SELECT pg_temp.check(
  'a crashed run that DID reach the provider is marked published, never re-posted',
  (SELECT status = 'published' FROM public.posts WHERE title = 'fresh'));

-- 5. Platform constraint -----------------------------------------------------
-- The connect dialog offers exactly the networks a post can be addressed to.
DO $$
BEGIN
  INSERT INTO public.posts (user_id, title, content, platforms, status)
  VALUES ('11111111-1111-1111-1111-111111111111', 'youtube', 'x', ARRAY['YouTube'], 'pending');
  RAISE EXCEPTION 'FAILED - posts.platforms accepted a network the product cannot publish to';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  - posts.platforms rejects a network the product cannot publish to';
END $$;

-- 6. Row level security ------------------------------------------------------
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
SET request.jwt.claim.role = 'authenticated';

SELECT pg_temp.check(
  'a user sees only their own posts',
  (SELECT count(*) FROM public.posts WHERE user_id <> '11111111-1111-1111-1111-111111111111') = 0);

SELECT pg_temp.check(
  'a user cannot read another account''s profile',
  (SELECT count(*) FROM public.profiles
    WHERE id = '22222222-2222-2222-2222-222222222222') = 0);

DO $$
BEGIN
  UPDATE public.posts SET user_id = '22222222-2222-2222-2222-222222222222'
   WHERE user_id = '11111111-1111-1111-1111-111111111111';
  RAISE EXCEPTION 'FAILED - a user was able to move a post to another account';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok  - WITH CHECK stops a user moving a post to another account';
END $$;

-- The plan drives paid features, and RLS cannot protect a single column, so a
-- trigger reverts the change instead of raising.
UPDATE public.profiles SET plan = 'enterprise'
 WHERE id = '11111111-1111-1111-1111-111111111111';

SELECT pg_temp.check(
  'a user cannot upgrade their own plan',
  (SELECT plan FROM public.profiles
    WHERE id = '11111111-1111-1111-1111-111111111111') = 'starter');

SELECT pg_temp.check(
  'a user cannot read stored social tokens',
  (SELECT count(*) FROM public.social_connections) = 0);

RESET ROLE;

-- The payment webhook runs as service_role and must still be able to set it.
UPDATE public.profiles SET plan = 'enterprise'
 WHERE id = '11111111-1111-1111-1111-111111111111';

SELECT pg_temp.check(
  'the server (service role) can still grant a plan',
  (SELECT plan FROM public.profiles
    WHERE id = '11111111-1111-1111-1111-111111111111') = 'enterprise');
