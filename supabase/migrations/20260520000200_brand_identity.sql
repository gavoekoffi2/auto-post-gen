-- =====================================================================
-- Brand identity & image style preferences.
-- =====================================================================

-- Brand colours (hex, e.g. "#1A2B3C"). Optional; defaults applied via UI.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS brand_primary_color TEXT,
  ADD COLUMN IF NOT EXISTS brand_secondary_color TEXT,
  ADD COLUMN IF NOT EXISTS brand_accent_color TEXT;

-- Font family (chosen from a curated list of Google Fonts so we can
-- reliably render them in AI-generated visuals).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS brand_font TEXT;

-- Image style: how the AI image should look.
-- Allowed: photorealistic | illustration | minimalist | corporate | flat_design
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS image_style TEXT DEFAULT 'photorealistic';

-- Keywords automatically derived from the description, used to make
-- the web research queries laser-focused on the user's specific
-- activity (not just their broad sector).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS activity_keywords TEXT[] DEFAULT ARRAY[]::text[];

-- Cheap, defensive check so the image_style column never holds a
-- value the image generator doesn't know how to render.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_image_style_check
  CHECK (
    image_style IS NULL
    OR image_style IN ('photorealistic', 'illustration', 'minimalist', 'corporate', 'flat_design')
  )
  NOT VALID;

UPDATE public.profiles
SET image_style = 'photorealistic'
WHERE image_style IS NOT NULL
  AND image_style NOT IN ('photorealistic', 'illustration', 'minimalist', 'corporate', 'flat_design');

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_image_style_check;
