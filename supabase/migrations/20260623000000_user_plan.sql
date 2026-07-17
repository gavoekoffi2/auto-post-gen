-- =====================================================================
-- Subscription plan + plan-gated AI comment auto-reply (Enterprise only).
--
-- Billing is deferred (free beta), so `plan` is set manually for now, e.g.
--   UPDATE public.profiles SET plan = 'enterprise' WHERE id = '<user-uuid>';
-- A future billing integration will set it via the service role.
--
-- The AI comment auto-reply is an Enterprise-plan feature. It is enforced
-- server-side in the sync-comments edge function (which reads `plan` with the
-- service role); this migration additionally prevents end users from
-- self-upgrading the column from the public API.
-- =====================================================================

-- 1. The plan column. Tiers mirror the published pricing (Starter / Pro /
--    Enterprise). Everyone starts on 'starter'.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'starter'
    CHECK (plan IN ('starter', 'pro', 'enterprise'));

-- 2. Guard: end users (the PostgREST `authenticated` / `anon` roles) cannot
--    change their own plan. RLS controls which ROWS a user may touch, but not
--    which COLUMNS — without this, any user could POST plan='enterprise' and
--    unlock auto-reply for free. Edge functions use the service role, which is
--    not subject to this guard, and so remains able to set the plan.
CREATE OR REPLACE FUNCTION public.guard_profile_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.plan := 'starter';
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.plan := OLD.plan;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_plan_ins ON public.profiles;
CREATE TRIGGER guard_profile_plan_ins
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_plan();

DROP TRIGGER IF EXISTS guard_profile_plan_upd ON public.profiles;
CREATE TRIGGER guard_profile_plan_upd
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_plan();
