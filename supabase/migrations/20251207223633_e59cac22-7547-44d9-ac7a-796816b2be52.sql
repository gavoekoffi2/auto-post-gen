-- Create storage bucket for user assets (logos, custom images)
INSERT INTO storage.buckets (id, name, public)
VALUES ('user-assets', 'user-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Policy: Users can upload their own files (files must be in a folder named after their user id)
CREATE POLICY "Users can upload their own files"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user-assets' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Policy: Users can update their own files
CREATE POLICY "Users can update their own files"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user-assets' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Policy: Users can delete their own files
CREATE POLICY "Users can delete their own files"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'user-assets' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Policy: Anyone can view public files in user-assets bucket
CREATE POLICY "Public files are viewable by everyone"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'user-assets');