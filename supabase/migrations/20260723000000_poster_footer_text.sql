-- Optional user-defined line rendered on every generated poster.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS poster_footer_text text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_poster_footer_text_length;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_poster_footer_text_length
  CHECK (poster_footer_text IS NULL OR char_length(poster_footer_text) <= 120);

COMMENT ON COLUMN public.profiles.poster_footer_text IS
  'Optional exact message displayed in the bottom-left corner of every generated poster.';
