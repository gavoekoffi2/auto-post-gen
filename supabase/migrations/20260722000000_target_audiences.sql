-- AI-suggested audience segmentation with explicit human approval.
-- Suggestions remain separate from the targets that are actually used for content.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS audience_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS audiences_confirmed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_audience_suggestions_array'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_audience_suggestions_array
      CHECK (jsonb_typeof(audience_suggestions) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_target_audiences_array'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_target_audiences_array
      CHECK (jsonb_typeof(target_audiences) = 'array');
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.audience_suggestions IS
  'Audience segments proposed by Claude from the company profile; not used until approved.';
COMMENT ON COLUMN public.profiles.target_audiences IS
  'Audience segments explicitly selected or edited and approved by the profile owner.';
COMMENT ON COLUMN public.profiles.audiences_confirmed_at IS
  'Timestamp of the most recent explicit human approval of target_audiences.';
