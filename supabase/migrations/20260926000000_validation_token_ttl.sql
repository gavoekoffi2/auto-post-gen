-- =====================================================================
-- Validation token TTL
--
-- posts.validation_token defaults to gen_random_uuid() on every insert, but
-- validation_token_created_at had no default, so every post created after
-- 20260520000000 carried a NULL there and validate-post skipped the 24h
-- expiry check: email validation links never expired. Backfill from
-- created_at and default future rows to now().
-- =====================================================================

UPDATE public.posts
   SET validation_token_created_at = COALESCE(created_at, now())
 WHERE validation_token IS NOT NULL
   AND validation_token_created_at IS NULL;

ALTER TABLE public.posts
  ALTER COLUMN validation_token_created_at SET DEFAULT now();
