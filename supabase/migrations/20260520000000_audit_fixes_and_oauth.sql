-- =====================================================================
-- Audit fixes: cleanup duplicate storage policies, add missing constraints,
-- create social_connections table, add validation_token expiry, indexes.
-- =====================================================================

-- 1. Drop the redundant policies introduced by 20251207223633.
--    They duplicate policies from 20251106073142 (different names, same logic).
DROP POLICY IF EXISTS "Users can upload their own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own files" ON storage.objects;
DROP POLICY IF EXISTS "Public files are viewable by everyone" ON storage.objects;

-- Ensure the canonical storage bucket configuration is in place
-- (enforce file size limit and allowed mime types).
UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
WHERE id = 'user-assets';

-- 2. Add missing DELETE RLS policy on profiles (users can delete their own profile)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'Users can delete their own profile'
  ) THEN
    CREATE POLICY "Users can delete their own profile"
      ON public.profiles FOR DELETE
      USING (auth.uid() = id);
  END IF;
END $$;

-- 3. Validation token expiry (24h) and used-at tracking
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS validation_token_created_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS validation_token_used_at TIMESTAMP WITH TIME ZONE;

UPDATE public.posts
SET validation_token_created_at = created_at
WHERE validation_token IS NOT NULL AND validation_token_created_at IS NULL;

-- 4. Track auto-published timestamp for safety/audit
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS auto_publish_attempted_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS publish_error TEXT;

-- 5. Social connections (OAuth tokens). Encrypted at rest by Supabase.
CREATE TABLE IF NOT EXISTS public.social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'twitter', 'linkedin', 'tiktok')),
  account_id TEXT NOT NULL,
  account_username TEXT,
  account_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMP WITH TIME ZONE,
  scopes TEXT[],
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, platform, account_id)
);

CREATE INDEX IF NOT EXISTS idx_social_connections_user_platform
  ON public.social_connections (user_id, platform);

ALTER TABLE public.social_connections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_connections' AND policyname='Users can view their own social connections') THEN
    CREATE POLICY "Users can view their own social connections"
      ON public.social_connections FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_connections' AND policyname='Users can insert their own social connections') THEN
    CREATE POLICY "Users can insert their own social connections"
      ON public.social_connections FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_connections' AND policyname='Users can update their own social connections') THEN
    CREATE POLICY "Users can update their own social connections"
      ON public.social_connections FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_connections' AND policyname='Users can delete their own social connections') THEN
    CREATE POLICY "Users can delete their own social connections"
      ON public.social_connections FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE TRIGGER update_social_connections_updated_at
  BEFORE UPDATE ON public.social_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Rate-limiting / quota tracking for AI generation
CREATE TABLE IF NOT EXISTS public.generation_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  function_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generation_usage_user_created
  ON public.generation_usage (user_id, created_at DESC);

ALTER TABLE public.generation_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='generation_usage' AND policyname='Users can view their own usage') THEN
    CREATE POLICY "Users can view their own usage"
      ON public.generation_usage FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- 7. Backfill: align legacy English day IDs to French capitalised labels.
--    Onboarding/Profile previously stored ['monday','tuesday',...] but
--    auto-generate-weekly expects ['Lundi','Mardi',...].
UPDATE public.profiles
SET preferred_days = ARRAY(
  SELECT CASE lower(d)
    WHEN 'monday' THEN 'Lundi'
    WHEN 'tuesday' THEN 'Mardi'
    WHEN 'wednesday' THEN 'Mercredi'
    WHEN 'thursday' THEN 'Jeudi'
    WHEN 'friday' THEN 'Vendredi'
    WHEN 'saturday' THEN 'Samedi'
    WHEN 'sunday' THEN 'Dimanche'
    ELSE d
  END
  FROM unnest(preferred_days) AS d
)
WHERE preferred_days IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM unnest(preferred_days) AS d
    WHERE lower(d) IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')
  );

-- 8. Make the post status canonical: pending|validated|published|failed
ALTER TABLE public.posts
  ADD CONSTRAINT posts_status_check
  CHECK (status IN ('pending', 'validated', 'published', 'failed'))
  NOT VALID;

-- Validate the constraint after migration so existing rows with unknown
-- statuses (if any) are normalised to 'pending'.
UPDATE public.posts SET status = 'pending'
WHERE status NOT IN ('pending', 'validated', 'published', 'failed');

ALTER TABLE public.posts VALIDATE CONSTRAINT posts_status_check;
