-- =====================================================================
-- Zernio social provider (https://zernio.com): connect + publish for
-- LinkedIn, Facebook and 13 more networks via a single API key, with
-- per-user isolation through Zernio "profiles".
-- =====================================================================

-- Allow 'zernio' as a connection provider.
ALTER TABLE public.social_connections
  DROP CONSTRAINT IF EXISTS social_connections_provider_check;
ALTER TABLE public.social_connections
  ADD CONSTRAINT social_connections_provider_check
  CHECK (provider IN ('direct', 'ayrshare', 'postiz', 'zernio'));

-- One Zernio umbrella row per user (mirrors the Ayrshare uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_connections_zernio_user
  ON public.social_connections (user_id)
  WHERE provider = 'zernio';

-- Allow 'zernio' as a comment source too (Zernio exposes a comments API),
-- so the existing inbox can later sync from it.
ALTER TABLE public.social_comments
  DROP CONSTRAINT IF EXISTS social_comments_provider_check;
ALTER TABLE public.social_comments
  ADD CONSTRAINT social_comments_provider_check
  CHECK (provider IN ('direct', 'ayrshare', 'postiz', 'zernio'));
