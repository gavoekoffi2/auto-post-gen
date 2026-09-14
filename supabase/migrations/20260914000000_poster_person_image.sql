-- =====================================================================
-- « Ma photo sur chaque affiche » — optional personal photo composited
-- into every generated poster.
--
-- When the user opts in and uploads a portrait, the poster engine
-- (Graphiste GPT) receives the photo as `reference_image_url` and the
-- creative brief instructs it to cut the person out and integrate them in
-- the layout, with the poster text on the opposite side.
--
--   use_poster_person_image : opt-in switch (off by default).
--   poster_person_image_url : public https URL in the user-assets bucket.
--   poster_person_label     : optional exact caption (name / role).
--   poster_person_placement : left | right | center.
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS use_poster_person_image boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS poster_person_image_url text,
  ADD COLUMN IF NOT EXISTS poster_person_label text,
  ADD COLUMN IF NOT EXISTS poster_person_placement text NOT NULL DEFAULT 'right';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_poster_person_label_length;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_poster_person_label_length
  CHECK (poster_person_label IS NULL OR char_length(poster_person_label) <= 60);

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_poster_person_placement_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_poster_person_placement_check
  CHECK (poster_person_placement IN ('left', 'right', 'center'));

-- The poster API downloads this URL server-side: only public https URLs are
-- usable. Reject anything else at the database level so a bad value can never
-- reach a paid generation.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_poster_person_image_url_https;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_poster_person_image_url_https
  CHECK (
    poster_person_image_url IS NULL
    OR (poster_person_image_url ~ '^https://' AND char_length(poster_person_image_url) <= 2000)
  );

COMMENT ON COLUMN public.profiles.use_poster_person_image IS
  'When true, the uploaded personal photo is composited into every generated poster.';
COMMENT ON COLUMN public.profiles.poster_person_image_url IS
  'Public https URL of the personal photo shown on every generated poster.';
COMMENT ON COLUMN public.profiles.poster_person_label IS
  'Optional exact caption (name / role) written under the person on the poster.';
COMMENT ON COLUMN public.profiles.poster_person_placement IS
  'Where the person sits in the poster composition: left | right | center.';
