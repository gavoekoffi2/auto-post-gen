-- =====================================================================
-- posts.video_url: lets a post carry a generated video (Mission 2) so it
-- flows through the SAME publish pipeline as image/text posts.
--
-- publish-post sends it to Zernio as a video media item (type=video), which
-- Zernio publishes to TikTok, YouTube Shorts, Instagram Reels, etc. When
-- video_url is set it takes precedence over image_url for that post.
-- =====================================================================

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS video_url TEXT;
