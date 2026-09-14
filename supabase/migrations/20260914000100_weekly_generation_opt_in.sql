-- =====================================================================
-- Weekly generation for users who validate their posts manually.
--
-- auto-generate-weekly used to run ONLY for profiles with auto_publish =
-- true. Every other user — i.e. everyone who wants to approve each post —
-- received nothing from the weekly cron, and send-validation-email had no
-- pending post to mail. This column makes weekly generation the default,
-- independently of whether publication is automatic.
--
--   auto_generate_enabled = true  → posts are generated every week.
--   auto_publish          = true  → they are also published automatically.
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auto_generate_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.auto_generate_enabled IS
  'When true, the weekly cron generates this week''s posts (pending validation unless auto_publish is on).';

-- Existing accounts keep the behaviour they implicitly had: a profile that
-- never completed onboarding is skipped by the cron anyway (it checks
-- sector/tone/content_types/description), so defaulting to true is safe.
