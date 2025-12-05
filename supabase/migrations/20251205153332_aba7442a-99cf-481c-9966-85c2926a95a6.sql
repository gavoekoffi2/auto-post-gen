-- Add company_name field to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company_name TEXT;