-- User-controlled weekly editorial mix and durable post classification.
-- Existing profiles default to one researched news/trend post per week.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS research_posts_per_week integer NOT NULL DEFAULT 1;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_research_posts_range;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_research_posts_range
  CHECK (research_posts_per_week >= 0 AND research_posts_per_week <= 21);

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS content_category text;

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_content_category_values;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_content_category_values
  CHECK (content_category IN ('value', 'research', 'promo'));

COMMENT ON COLUMN public.profiles.research_posts_per_week IS
  'Number of weekly automatic posts grounded specifically in current sector news/research.';
COMMENT ON COLUMN public.posts.content_category IS
  'Editorial intent: value, research, or promo.';
