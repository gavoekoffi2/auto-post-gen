-- =====================================================================
-- Free trial and subscription lifecycle.
--
-- The pricing page has always promised "Essai gratuit 7 jours" on every plan,
-- but nothing implemented it: an account was simply `starter` forever, there
-- was no expiry, and no way to pay. This migration gives an account a real
-- lifecycle:
--
--   trialing  → the plan picked at signup, for 7 days, no card required
--   active    → a paid plan, until current_period_ends_at (NULL = open-ended,
--               used for complimentary / legacy accounts)
--   expired   → derived, never stored as a trap: a trial or a paid period
--               whose end date has passed
--
-- The EFFECTIVE state is computed from the timestamps at read time
-- (see resolveEntitlement in supabase/functions/_shared/plans.ts), so no cron
-- has to flip a flag at midnight and nothing breaks if one does not run.
-- =====================================================================

-- 1. Lifecycle columns on the profile.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing', 'active')),
  ADD COLUMN IF NOT EXISTS trial_plan text NOT NULL DEFAULT 'pro'
    CHECK (trial_plan IN ('starter', 'pro', 'enterprise')),
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_ends_at timestamptz,
  -- When the "your trial / subscription ends soon" email went out for the
  -- CURRENT end date. Cleared whenever that date moves (approval, extension).
  ADD COLUMN IF NOT EXISTS expiry_reminder_sent_at timestamptz;

-- 2. Accounts that already exist were created before any of this and are
--    being used (the owner, test accounts, early users). Expiring them on
--    deploy would lock people out of a product they were promised for free.
--    They become active with no end date; the operator can change that.
UPDATE public.profiles
SET subscription_status = 'active',
    current_period_ends_at = NULL
WHERE trial_ends_at IS NULL
  AND subscription_status = 'trialing';

-- 3. Every NEW account starts a trial on the plan it signed up for. The plan
--    arrives as sign-up metadata (?plan= on the pricing CTAs); anything
--    unexpected falls back to Pro, the plan the pricing page features.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  requested text := lower(coalesce(NEW.raw_user_meta_data ->> 'requested_plan', ''));
BEGIN
  IF requested NOT IN ('starter', 'pro', 'enterprise') THEN
    requested := 'pro';
  END IF;

  INSERT INTO public.profiles (
    id, email, sector, content_types, tone,
    subscription_status, trial_plan, trial_ends_at
  )
  VALUES (
    NEW.id, NEW.email, '', ARRAY[]::text[], '',
    'trialing', requested, now() + interval '7 days'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 4. None of these columns may be written by the browser. RLS decides which
--    ROWS a user may touch, not which columns — without this, anyone could
--    extend their own trial by a century from the console. The existing plan
--    guard is extended to the whole billing state. The service role (edge
--    functions, admin, a future payment webhook) is unaffected.
CREATE OR REPLACE FUNCTION public.guard_profile_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.plan := 'starter';
      NEW.subscription_status := 'trialing';
      NEW.trial_plan := 'pro';
      NEW.trial_ends_at := now() + interval '7 days';
      NEW.current_period_ends_at := NULL;
      NEW.expiry_reminder_sent_at := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.plan := OLD.plan;
      NEW.subscription_status := OLD.subscription_status;
      NEW.trial_plan := OLD.trial_plan;
      NEW.trial_ends_at := OLD.trial_ends_at;
      NEW.current_period_ends_at := OLD.current_period_ends_at;
      NEW.expiry_reminder_sent_at := OLD.expiry_reminder_sent_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Activation requests: the Mobile Money payment flow.
--    A user pays by Wave / Orange Money / MTN and submits the reference; the
--    operator checks it and activates from /admin. Written ONLY through the
--    request-subscription edge function (which validates it and emails the
--    operator), read by the user for their own history, decided by the admin
--    API. A payment-gateway webhook can later write the same rows.
CREATE TABLE IF NOT EXISTS public.subscription_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('starter', 'pro', 'enterprise')),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  amount_fcfa integer NOT NULL CHECK (amount_fcfa > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('wave', 'orange_money', 'mtn_momo', 'moov_money', 'other')),
  payer_phone text NOT NULL,
  payment_reference text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  admin_note text,
  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_requests_user
  ON public.subscription_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_pending
  ON public.subscription_requests (created_at)
  WHERE status = 'pending';

-- One pending request per user: a double-click or an impatient second
-- submission must not create two payments to verify.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscription_requests_one_pending
  ON public.subscription_requests (user_id)
  WHERE status = 'pending';

-- The same Mobile Money reference cannot be claimed twice (a rejected or
-- withdrawn request frees it, so a typo can be corrected).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscription_requests_reference
  ON public.subscription_requests (payment_method, lower(payment_reference))
  WHERE status IN ('pending', 'approved');

ALTER TABLE public.subscription_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.subscription_requests FROM anon, authenticated;
GRANT SELECT ON public.subscription_requests TO authenticated;

DROP POLICY IF EXISTS "Users read their own subscription requests" ON public.subscription_requests;
CREATE POLICY "Users read their own subscription requests"
  ON public.subscription_requests FOR SELECT
  USING (auth.uid() = user_id);

-- 6. The reminder cron scans for accounts ending soon; keep that cheap.
CREATE INDEX IF NOT EXISTS idx_profiles_trial_ends
  ON public.profiles (trial_ends_at)
  WHERE subscription_status = 'trialing' AND expiry_reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_period_ends
  ON public.profiles (current_period_ends_at)
  WHERE subscription_status = 'active' AND expiry_reminder_sent_at IS NULL;
