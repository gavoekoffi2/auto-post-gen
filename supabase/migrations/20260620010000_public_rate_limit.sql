-- =====================================================================
-- IP rate limiting for the public (unauthenticated) endpoints
-- (send-contact, validate-post). Backed by a small events table that is
-- only reachable by the service role; an advisory lock makes the
-- count-then-insert atomic, and old rows are GC'd opportunistically.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.ip_rate_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_rate_events_bucket_created
  ON public.ip_rate_events (bucket, created_at DESC);

-- RLS on, no policies → only the service role (which bypasses RLS) can use it.
ALTER TABLE public.ip_rate_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hit_ip_rate_limit(
  p_bucket text,
  p_max integer,
  p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  used integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_bucket, 0));
  -- Opportunistic GC so the table stays small.
  DELETE FROM public.ip_rate_events
   WHERE created_at < now() - make_interval(secs => p_window_seconds * 4);
  SELECT count(*) INTO used
    FROM public.ip_rate_events
   WHERE bucket = p_bucket
     AND created_at >= now() - make_interval(secs => p_window_seconds);
  IF used >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.ip_rate_events (bucket) VALUES (p_bucket);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.hit_ip_rate_limit(text, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.hit_ip_rate_limit(text, integer, integer) TO service_role;
