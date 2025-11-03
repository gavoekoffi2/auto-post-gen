-- Add description column to profiles table for storing business/activity description
ALTER TABLE public.profiles 
ADD COLUMN description TEXT;

-- Add style_example column to store user's preferred content style examples
ALTER TABLE public.profiles 
ADD COLUMN style_example TEXT;