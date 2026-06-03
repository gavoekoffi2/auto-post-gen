-- =====================================================================
-- Engagement inbox: collect social comments and (auto-)reply to them.
--
-- This is the provider-agnostic foundation requested for the
-- "collect comments + auto-reply" feature. It works with whichever
-- social backend is active (Ayrshare today; Postiz reserved). No social
-- API calls live here — only the storage + RLS + settings the edge
-- functions (sync-comments / comment-reply) and the dashboard read/write.
-- =====================================================================

-- 1. Remember the external post ids of a published post so we can map a
--    comment back to the post that produced it.
--    * provider_post_id : the umbrella id returned by the provider
--      (e.g. Ayrshare's top-level post id, used by its Comments API).
--    * external_post_ids: { "<platform>": "<social post id>" } for the
--      per-platform social posts (used by direct-OAuth + searchPlatformId).
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS provider_post_id TEXT,
  ADD COLUMN IF NOT EXISTS external_post_ids JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. Per-user engagement / auto-reply settings.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_reply_instructions TEXT;

-- 3. The comments inbox.
CREATE TABLE IF NOT EXISTS public.social_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id UUID REFERENCES public.posts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'ayrshare'
    CHECK (provider IN ('direct', 'ayrshare', 'postiz')),
  platform TEXT NOT NULL,
  external_comment_id TEXT NOT NULL,
  parent_comment_id TEXT,
  author_name TEXT,
  author_handle TEXT,
  author_avatar_url TEXT,
  message TEXT,
  comment_created_at TIMESTAMP WITH TIME ZONE,
  -- new | replied | ignored | hidden
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'replied', 'ignored', 'hidden')),
  reply_text TEXT,
  reply_external_id TEXT,
  replied_at TIMESTAMP WITH TIME ZONE,
  -- 'auto' (AI auto-reply) | 'manual' (sent from the dashboard)
  replied_by TEXT CHECK (replied_by IN ('auto', 'manual')),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, platform, external_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_social_comments_user_status
  ON public.social_comments (user_id, status, comment_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_comments_post
  ON public.social_comments (post_id);

ALTER TABLE public.social_comments ENABLE ROW LEVEL SECURITY;

-- Owners can read and curate (mark ignored/hidden, edit a draft reply)
-- their own comments. Inserts and reply writes come from edge functions
-- using the service role, which bypasses RLS — so we deliberately do NOT
-- expose an INSERT policy to end users.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_comments' AND policyname='Users can view their own comments') THEN
    CREATE POLICY "Users can view their own comments"
      ON public.social_comments FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_comments' AND policyname='Users can update their own comments') THEN
    CREATE POLICY "Users can update their own comments"
      ON public.social_comments FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='social_comments' AND policyname='Users can delete their own comments') THEN
    CREATE POLICY "Users can delete their own comments"
      ON public.social_comments FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_social_comments_updated_at ON public.social_comments;
CREATE TRIGGER update_social_comments_updated_at
  BEFORE UPDATE ON public.social_comments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
