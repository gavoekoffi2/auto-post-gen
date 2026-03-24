-- Add Ayrshare profile key to profiles for social media publishing integration
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS ayrshare_profile_key TEXT DEFAULT NULL;

-- Update TypeScript types comment
COMMENT ON COLUMN public.profiles.ayrshare_profile_key IS
  'Ayrshare profile key for this user - used to publish posts to social media platforms';
