-- =========================================================
-- Postiz integration + bug fixes
-- =========================================================

-- 1. Add Postiz configuration fields on profiles ------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS postiz_api_key TEXT,
  ADD COLUMN IF NOT EXISTS postiz_base_url TEXT DEFAULT 'https://api.postiz.com/public/v1',
  ADD COLUMN IF NOT EXISTS postiz_integrations JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS postiz_last_sync TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.postiz_api_key IS
  'Postiz public API key (from Settings > Developers in Postiz). Used to schedule/publish posts on connected social accounts.';
COMMENT ON COLUMN public.profiles.postiz_base_url IS
  'Postiz API base URL. Defaults to the hosted service; override for self-hosted instances.';
COMMENT ON COLUMN public.profiles.postiz_integrations IS
  'Cached list of user integrations (channels) returned by Postiz.';

-- 2. Add publish tracking fields on posts -------------------
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS postiz_post_id TEXT,
  ADD COLUMN IF NOT EXISTS postiz_integration_ids TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS publish_error TEXT,
  ADD COLUMN IF NOT EXISTS publish_attempts INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled
  ON public.posts (status, scheduled_for)
  WHERE status IN ('validated', 'scheduled');

-- 3. Contact messages table ---------------------------------
CREATE TABLE IF NOT EXISTS public.contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT,
  message TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  handled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can submit a contact message"
  ON public.contact_messages;
CREATE POLICY "Anyone can submit a contact message"
  ON public.contact_messages
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can read their own contact messages"
  ON public.contact_messages;
CREATE POLICY "Users can read their own contact messages"
  ON public.contact_messages
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- 4. Normalize preferred_days to French (fixes scheduling bug)
-- Old code stored English ids ("monday") but the scheduler compares
-- against French names ("Lundi"). We migrate existing rows to French.
UPDATE public.profiles
SET preferred_days = ARRAY(
  SELECT
    CASE LOWER(day)
      WHEN 'monday'    THEN 'Lundi'
      WHEN 'tuesday'   THEN 'Mardi'
      WHEN 'wednesday' THEN 'Mercredi'
      WHEN 'thursday'  THEN 'Jeudi'
      WHEN 'friday'    THEN 'Vendredi'
      WHEN 'saturday'  THEN 'Samedi'
      WHEN 'sunday'    THEN 'Dimanche'
      ELSE day
    END
  FROM UNNEST(preferred_days) AS day
)
WHERE preferred_days IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM UNNEST(preferred_days) d
    WHERE LOWER(d) IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')
  );

-- 5. Helper: claim scheduled posts atomically ---------------
-- Used by the publish-scheduled-posts function to avoid double publishing.
CREATE OR REPLACE FUNCTION public.claim_due_posts(p_limit INTEGER DEFAULT 20)
RETURNS SETOF public.posts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.posts
  SET    status = 'publishing',
         updated_at = NOW()
  WHERE  id IN (
    SELECT id
    FROM   public.posts
    WHERE  status IN ('validated', 'scheduled')
      AND  scheduled_for IS NOT NULL
      AND  scheduled_for <= NOW()
      AND  publish_attempts < 5
    ORDER BY scheduled_for ASC
    LIMIT  p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_posts(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_posts(INTEGER) TO service_role;
