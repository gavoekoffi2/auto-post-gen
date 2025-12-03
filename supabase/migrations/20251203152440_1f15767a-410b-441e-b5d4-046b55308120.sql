-- Add automation fields to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS preferred_days text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS auto_publish boolean DEFAULT false;

-- Add validation fields to posts
ALTER TABLE public.posts 
ADD COLUMN IF NOT EXISTS validation_status text DEFAULT 'draft',
ADD COLUMN IF NOT EXISTS validation_token uuid DEFAULT gen_random_uuid(),
ADD COLUMN IF NOT EXISTS week_number integer;

-- Create index for validation tokens
CREATE INDEX IF NOT EXISTS idx_posts_validation_token ON public.posts(validation_token);

-- Create index for week number to easily query weekly posts
CREATE INDEX IF NOT EXISTS idx_posts_week_number ON public.posts(week_number);