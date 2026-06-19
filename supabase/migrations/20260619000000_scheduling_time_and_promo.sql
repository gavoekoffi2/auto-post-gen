-- =====================================================================
-- User-controlled scheduling time + value/promo mix for the automated
-- weekly poster.
--
--   * preferred_time        : the time of day (24h "HH:MM") at which
--                             auto-generated posts are scheduled. Until
--                             now this was hard-coded to 10:00 in the
--                             auto-generate-weekly function.
--   * promo_posts_per_week  : how many of the week's automatic posts are
--                             oriented toward the company's service
--                             (promo). The remaining posts are pure value
--                             (no promotion), which is the desired default
--                             editorial mix.
--
-- Both columns are NOT NULL with sensible defaults so existing profiles
-- and the handle_new_user trigger keep working without changes. '10:00'
-- preserves the previous behaviour; 1 promo/week matches the product's
-- "mostly value, one service-oriented post" guideline.
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_time text NOT NULL DEFAULT '10:00',
  ADD COLUMN IF NOT EXISTS promo_posts_per_week integer NOT NULL DEFAULT 1;

-- preferred_time must be a valid 24h HH:MM string.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_preferred_time_format;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_preferred_time_format
  CHECK (preferred_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- promo count must be non-negative and within a sane upper bound (the
-- weekly run is itself capped at HARD_MAX_POSTS_PER_RUN = 20).
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_promo_posts_range;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_promo_posts_range
  CHECK (promo_posts_per_week >= 0 AND promo_posts_per_week <= 21);
