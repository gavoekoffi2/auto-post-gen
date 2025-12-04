-- Add preference for people type in images
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS image_people_type TEXT DEFAULT 'african';