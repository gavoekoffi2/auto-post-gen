-- Per-user IANA timezone for scheduling.
--
-- auto-generate-weekly ran `scheduledDate.setHours(hour, minute)` inside the
-- Supabase edge runtime, whose local time is UTC. A user in Paris who asked
-- for 10:00 got a post scheduled at 10:00 UTC — 11:00 or 12:00 their time —
-- and the "next Lundi" calculation used the UTC weekday, so a preferred day
-- could land a day off for users far from UTC.
--
-- 'UTC' is the default so existing rows keep exactly the behaviour they have
-- today; the app fills in the browser's real zone at onboarding and lets the
-- user change it from their profile.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_timezone_shape;

-- Not a full IANA registry check (Postgres cannot see the app's tz database),
-- but enough to reject junk before it reaches Intl.DateTimeFormat.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_timezone_shape
  CHECK (
    timezone = 'UTC'
    OR timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'
  );

COMMENT ON COLUMN public.profiles.timezone IS
  'IANA timezone (e.g. Europe/Paris, Africa/Lome) used to turn preferred_days + preferred_time into a real scheduled instant. Defaults to UTC.';
