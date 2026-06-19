-- =====================================================================
-- Automatic posts: attach a real poster image.
--
-- auto-generate-weekly now kicks off an asynchronous Graphiste GPT poster
-- job for each automatic post (unless the profile uses its own custom image
-- library). The job id is stored here so publish-post can resume it and
-- attach the finished poster before the post is published — which also
-- unblocks image-only networks like Instagram.
--
--   image_job_id     : Graphiste GPT job identifier to resume.
--   image_status_url : absolute status URL returned by the API (if any).
--   image_status     : 'processing' | 'done' | 'failed' (NULL = no job).
-- =====================================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS image_job_id text,
  ADD COLUMN IF NOT EXISTS image_status_url text,
  ADD COLUMN IF NOT EXISTS image_status text;
