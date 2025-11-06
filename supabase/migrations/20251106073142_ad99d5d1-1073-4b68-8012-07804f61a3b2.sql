-- Create storage bucket for user assets (logos, custom images)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'user-assets', 
  'user-assets', 
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Create policy for viewing user assets (public)
CREATE POLICY "User assets are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'user-assets');

-- Create policy for uploading user assets
CREATE POLICY "Users can upload their own assets"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'user-assets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Create policy for updating user assets
CREATE POLICY "Users can update their own assets"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'user-assets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Create policy for deleting user assets
CREATE POLICY "Users can delete their own assets"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'user-assets' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);