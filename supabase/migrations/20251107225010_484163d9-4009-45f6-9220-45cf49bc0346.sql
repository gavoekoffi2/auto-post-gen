-- Add custom images fields to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS use_custom_images boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS custom_image_urls text[] DEFAULT '{}';

-- Add comment for documentation
COMMENT ON COLUMN public.profiles.use_custom_images IS 'Si activé, l''IA utilisera les images personnalisées de l''utilisateur';
COMMENT ON COLUMN public.profiles.custom_image_urls IS 'URLs des images personnalisées uploadées par l''utilisateur';