-- =====================================================================
-- Per-user scheduling timezone.
--
-- profiles.preferred_time is a wall-clock time ("10:00") that the weekly
-- generator turned into an instant with Date#setHours — i.e. in the EDGE
-- RUNTIME's clock, which is UTC. Every user outside UTC therefore had their
-- posts published at the wrong hour (an Abidjan user picking 10:00 got 10:00
-- UTC; a Nairobi user got 13:00 local). The time only ever meant anything
-- relative to the user's own zone, so store that zone alongside it.
--
-- Default 'UTC' preserves today's behaviour for existing rows until a user
-- saves their profile, at which point the browser's detected zone is stored.
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

-- Reject a zone Postgres does not know, so the generator can rely on it.
CREATE OR REPLACE FUNCTION public.is_valid_timezone(p_name text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RETURN false;
  END IF;
  PERFORM now() AT TIME ZONE p_name;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_timezone_valid;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_timezone_valid
  CHECK (public.is_valid_timezone(timezone)) NOT VALID;

-- Normalise anything already stored before validating the constraint.
UPDATE public.profiles
   SET timezone = 'UTC'
 WHERE timezone IS NULL OR NOT public.is_valid_timezone(timezone);

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_timezone_valid;

COMMENT ON COLUMN public.profiles.timezone IS
  'IANA timezone (e.g. Africa/Abidjan) that preferred_time and preferred_days are expressed in.';
