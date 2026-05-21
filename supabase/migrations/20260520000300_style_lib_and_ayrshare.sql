-- =====================================================================
-- Style example library + third-party social provider (Ayrshare).
-- =====================================================================

-- Multi-example style library. Each entry is { label, content }.
-- Stored as JSONB so the user can add/remove without a separate table.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS style_examples JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.profiles.style_examples IS
  'Array of {label, content} reference posts the AI should imitate in tone and structure';

-- Third-party social provider for social_connections. 'direct' means
-- we own the OAuth (legacy). 'ayrshare' means the connection is
-- managed by Ayrshare and we publish via their API.
ALTER TABLE public.social_connections
  ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS profile_key TEXT;

-- Tighten allowed values.
ALTER TABLE public.social_connections
  DROP CONSTRAINT IF EXISTS social_connections_provider_check;
ALTER TABLE public.social_connections
  ADD CONSTRAINT social_connections_provider_check
  CHECK (provider IN ('direct', 'ayrshare', 'postiz'));

-- A user has at most one Ayrshare profile_key across all their
-- connections (one Ayrshare profile per user covers ALL platforms).
-- We track it on a per-row basis but enforce uniqueness per user/provider.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_connections_ayrshare_user
  ON public.social_connections (user_id)
  WHERE provider = 'ayrshare';

-- Allow social_connections.platform to be 'all' for the Ayrshare
-- umbrella row (one row covers all platforms via their profile_key).
-- Drop the original CHECK constraint and recreate it with the
-- expanded set of platforms.
ALTER TABLE public.social_connections
  DROP CONSTRAINT IF EXISTS social_connections_platform_check;

ALTER TABLE public.social_connections
  ADD CONSTRAINT social_connections_platform_check
  CHECK (
    platform IN ('instagram', 'facebook', 'twitter', 'linkedin', 'tiktok', 'youtube', 'pinterest', 'threads', 'bluesky', 'reddit', 'mastodon', 'all')
  );
