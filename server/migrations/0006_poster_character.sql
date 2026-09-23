-- =====================================================================
-- 0006 — A character on every poster.
--
-- An account may upload the photo of a person (or a mascot) to appear on
-- each generated poster. The API cuts the subject out once, at upload
-- (services/character.ts), stores the cut-out as one of the account's media
-- (kind 'other' — the media kind constraint is not rebuilt: in production it
-- carries legacy values 0000 merged in, which must not be lost), and lays it
-- onto every finished render on this server. The photo never goes to the
-- poster provider.
--
-- Additive and idempotent: columns and constraints are added if missing;
-- nothing is dropped, renamed or deleted.
-- =====================================================================

-- The stored cut-out. SET NULL: deleting the media file must never take the
-- profile with it; the feature simply switches off.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS poster_character_asset_id uuid;
DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_poster_character_fk
    FOREIGN KEY (poster_character_asset_id) REFERENCES media_assets (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- On/off without deleting the image, and which side of the poster it stands on.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS poster_character_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS poster_character_position text NOT NULL DEFAULT 'right';
DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_poster_character_position_known
    CHECK (poster_character_position IN ('left', 'right'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- When the account confirmed it holds the rights to use this image — the
-- image of a real person is published on its social networks.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS poster_character_rights_at timestamptz;

-- The character a job was STARTED with ({"assetId","position"}). The
-- provider was told then which side to keep free; the render is completed
-- minutes later, possibly after the account changed its settings, and must
-- be finished the way it was started.
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS character_overlay jsonb;
