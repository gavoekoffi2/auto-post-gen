-- Add columns to store social media connections and credentials
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS instagram_username TEXT,
ADD COLUMN IF NOT EXISTS facebook_username TEXT,
ADD COLUMN IF NOT EXISTS twitter_username TEXT,
ADD COLUMN IF NOT EXISTS linkedin_username TEXT,
ADD COLUMN IF NOT EXISTS tiktok_username TEXT,
ADD COLUMN IF NOT EXISTS connected_platforms TEXT[] DEFAULT '{}';

-- Add comment for clarity
COMMENT ON COLUMN public.profiles.connected_platforms IS 'List of platforms with active connections (username provided)';
COMMENT ON COLUMN public.profiles.instagram_username IS 'Instagram account username';
COMMENT ON COLUMN public.profiles.facebook_username IS 'Facebook account username';
COMMENT ON COLUMN public.profiles.twitter_username IS 'Twitter account username';
COMMENT ON COLUMN public.profiles.linkedin_username IS 'LinkedIn account username';
COMMENT ON COLUMN public.profiles.tiktok_username IS 'TikTok account username';