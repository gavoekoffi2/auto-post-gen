-- User-controlled weekly editorial mix and durable post classification.
-- Existing profiles default to one researched news/trend post per week.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS research_posts_per_week integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_research_posts_range'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_research_posts_range
      CHECK (research_posts_per_week >= 0 AND research_posts_per_week <= 21);
  END IF;
END $$;

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS content_category text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_content_category_values'
      AND conrelid = 'public.posts'::regclass
  ) THEN
    ALTER TABLE public.posts
      ADD CONSTRAINT posts_content_category_values
      CHECK (content_category IN ('value', 'research', 'promo'));
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.research_posts_per_week IS
  'Number of weekly automatic posts grounded specifically in current sector news/research.';
COMMENT ON COLUMN public.posts.content_category IS
  'Editorial intent: value, research, or promo.';
