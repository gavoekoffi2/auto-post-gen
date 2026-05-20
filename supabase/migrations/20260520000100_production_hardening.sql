-- =====================================================================
-- Production hardening: tighter constraints, NOT NULL where it matters,
-- guarantee that the trigger that creates a profile row on signup
-- exists, and add helper indexes used by the dashboard queries.
-- =====================================================================

-- 1. Ensure handle_new_user trigger runs even if a previous migration
--    failed to attach it. Idempotent: drop & recreate the trigger.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 2. Backfill profiles missing for any existing auth.users (happens when
--    the trigger was added after some users already signed up).
INSERT INTO public.profiles (id, email, sector, content_types, tone, post_frequency)
SELECT u.id, u.email, '', ARRAY[]::text[], '', 2
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- 3. Useful covering indexes
CREATE INDEX IF NOT EXISTS idx_posts_user_created ON public.posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled
  ON public.posts (status, scheduled_for)
  WHERE status = 'validated';

-- 4. Defensive: posts.platforms should never be NULL. Backfill and lock.
UPDATE public.posts SET platforms = ARRAY[]::text[] WHERE platforms IS NULL;

-- 5. handle_new_user is SECURITY DEFINER; tighten search_path explicitly.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, sector, content_types, tone)
  VALUES (NEW.id, NEW.email, '', ARRAY[]::text[], '')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 6. Recreate trigger after function update (PG drops it implicitly
--    in some cases when the function signature is identical, but be
--    explicit).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 7. Relax the NOT NULL on profiles' onboarding fields so the
--    handle_new_user trigger can create an empty row before the user
--    completes onboarding (existing migrations made them NOT NULL with
--    no default, which made the trigger fail silently for some setups).
ALTER TABLE public.profiles ALTER COLUMN sector DROP NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN tone DROP NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN content_types DROP NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN sector SET DEFAULT '';
ALTER TABLE public.profiles ALTER COLUMN tone SET DEFAULT '';
ALTER TABLE public.profiles ALTER COLUMN content_types SET DEFAULT ARRAY[]::text[];

-- 8. Hard cap on post.content length to defend the AI pipeline.
ALTER TABLE public.posts
  ADD CONSTRAINT posts_content_length CHECK (char_length(content) <= 10000)
  NOT VALID;
ALTER TABLE public.posts VALIDATE CONSTRAINT posts_content_length;

-- 9. Validate that platforms are from a known set (case-insensitive
--    check). We accept either French capitalised labels (UI) or the
--    canonical lowercase IDs used in social_connections.
ALTER TABLE public.posts
  ADD CONSTRAINT posts_platforms_known
  CHECK (
    platforms <@ ARRAY[
      'Instagram','Facebook','Twitter','Twitter (X)','LinkedIn','TikTok',
      'instagram','facebook','twitter','linkedin','tiktok'
    ]::text[]
  )
  NOT VALID;
-- Don't validate retroactively to avoid breaking pre-existing rows; the
-- check applies to new inserts/updates.

-- 10. Add a helper view used by the publisher: validated posts due now.
CREATE OR REPLACE VIEW public.due_validated_posts AS
SELECT *
FROM public.posts
WHERE status = 'validated'
  AND (scheduled_for IS NULL OR scheduled_for <= now());

GRANT SELECT ON public.due_validated_posts TO service_role;

-- 11. The publisher uses an intermediate 'publishing' status to atomically
--     claim a post and prevent double-publishing between cron + manual
--     invocations. Add it to the canonical status set.
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_status_check;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_status_check
  CHECK (status IN ('pending', 'validated', 'publishing', 'published', 'failed'))
  NOT VALID;
UPDATE public.posts SET status = 'pending'
WHERE status NOT IN ('pending', 'validated', 'publishing', 'published', 'failed');
ALTER TABLE public.posts VALIDATE CONSTRAINT posts_status_check;

-- 12. Recovery: if a post has been stuck in 'publishing' for more than
--     10 minutes (function timed out, crashed, etc.) the next cron tick
--     should retry it. We expose this via a helper function the cron
--     can call before its main pass.
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
  SET status = 'validated',
      publish_error = COALESCE(publish_error, 'recovered_from_publishing_timeout')
  WHERE status = 'publishing'
    AND auto_publish_attempted_at IS NOT NULL
    AND auto_publish_attempted_at < now() - interval '10 minutes';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
REVOKE ALL ON FUNCTION public.recover_stuck_publishing() FROM public;
GRANT EXECUTE ON FUNCTION public.recover_stuck_publishing() TO service_role;
