-- Add platforms array to profiles to store user's social networks
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS platforms TEXT[] NOT NULL DEFAULT '{}';