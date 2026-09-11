-- A capability URL for media that must be fetched by someone who has no
-- session: the publishing provider, which downloads the poster to attach it.
--
-- /api/media/:id/file requires a session, so a re-hosted poster is invisible
-- to the publisher — a scheduled post would go out text-only, and fail
-- outright on a network that requires media.
--
-- The token is a long random string, minted only for an asset that is
-- actually being published, and revocable by setting it back to NULL. It
-- grants exactly one thing: reading that one file.
--
-- Idempotent, and safe on a database that already carries 0001 and 0002.

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS public_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_public_token
  ON media_assets (public_token)
  WHERE public_token IS NOT NULL;
