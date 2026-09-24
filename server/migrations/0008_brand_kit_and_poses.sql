-- =====================================================================
-- 0008 — Brand kit on every poster, and a character that adapts its gesture.
--
-- 1. POSES. The account's character can now be several photos of the same
--    person in different gestures (presenting, pointing, thumbs up...). For
--    each poster the API picks the one that suits the post's message and
--    lays the REAL photo on the render — the renderer never redraws the
--    person, which is how "another face" ended up on posters.
--    The single cut-out of 0006 becomes the first pose (backfill below).
-- 2. LOGO. "Show my logo on every poster": the account's own logo file is
--    applied onto the finished render, exactly as uploaded.
-- 3. BRAND COLOURS. "Apply my brand colours to every poster".
-- 4. PER POST. A post may include or leave out the character; NULL follows
--    the account's default (profiles.poster_character_enabled).
-- 5. The logo a job was started with, so it is finished the same way.
--
-- Additive and idempotent: tables, columns and constraints are added if
-- missing; nothing is dropped, renamed or deleted. Existing accounts keep
-- what they had: the logo and the brand colours stay applied (DEFAULT true),
-- as they already were.
-- =====================================================================

CREATE TABLE IF NOT EXISTS poster_character_poses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  -- Deleting the media deletes the pose: a pose without its image is nothing.
  asset_id     uuid NOT NULL REFERENCES media_assets (id) ON DELETE CASCADE,
  gesture      text NOT NULL DEFAULT 'neutre',
  -- Where the person looks or points in the photo. A pose facing away from
  -- the poster's centre is mirrored when it is laid on.
  facing       text NOT NULL DEFAULT 'front',
  width        integer,
  height       integer,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS poster_character_poses_profile_idx ON poster_character_poses (profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS poster_character_poses_asset_key ON poster_character_poses (asset_id);

DO $$ BEGIN
  ALTER TABLE poster_character_poses ADD CONSTRAINT poster_character_poses_gesture_known
    CHECK (gesture IN ('neutre', 'presente', 'pointe', 'pouce', 'confiant',
                       'explique', 'reflechit', 'accueille', 'celebre'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE poster_character_poses ADD CONSTRAINT poster_character_poses_facing_known
    CHECK (facing IN ('left', 'front', 'right'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The 0006 cut-out becomes the account's first pose. Guarded, so a replay
-- adds nothing.
INSERT INTO poster_character_poses (profile_id, asset_id, gesture, facing)
SELECT p.id, p.poster_character_asset_id, 'neutre', 'front'
  FROM profiles p
  JOIN media_assets m ON m.id = p.poster_character_asset_id AND m.profile_id = p.id
 WHERE p.poster_character_asset_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM poster_character_poses x WHERE x.asset_id = p.poster_character_asset_id
   );

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS poster_logo_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS brand_colors_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS include_character boolean;

ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS logo_overlay jsonb;
