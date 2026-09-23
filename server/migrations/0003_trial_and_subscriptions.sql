-- =====================================================================
-- 0003 — Free trial and subscription lifecycle.
--
-- The pricing page promises "Essai gratuit 7 jours" on every plan, but
-- nothing implemented it: an account was `starter` forever, with no expiry
-- and no way to pay. This gives an account a real lifecycle:
--
--   trialing → the plan picked at signup, for 7 days, no card required
--   active   → a paid plan until current_period_ends_at (NULL = open-ended,
--              for complimentary and pre-existing accounts)
--   expired  → DERIVED, never stored: a trial or paid period whose end date
--              has passed
--
-- The effective state is computed from the timestamps at read time
-- (resolveEntitlement, server/src/shared/plans.ts), so nothing has to flip a
-- flag at midnight and nothing breaks if a job does not run.
--
-- Safe on a populated database and on replay: columns are added, never
-- replaced; the backfill only touches rows this file has just created the
-- columns for; constraints are guarded. Nothing is dropped or deleted.
-- =====================================================================

-- 1. Lifecycle columns. Added WITHOUT a volatile default first, so the
--    backfill below can tell pre-existing accounts apart.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'trialing';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_plan text NOT NULL DEFAULT 'pro';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS current_period_ends_at timestamptz;
-- When the "your trial / subscription ends soon" email went out for the
-- CURRENT end date. Cleared whenever that date moves (approval, extension).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS expiry_reminder_sent_at timestamptz;

-- 2. Accounts that exist before this release were created without any of
--    this and are in use (the owner, test accounts, legacy customers).
--    Expiring them on deploy would lock people out of a product they were
--    promised for free, so they become active with no end date; the
--    operator can change that from /admin. On replay this matches nothing:
--    every account created since has a trial end date.
UPDATE profiles
   SET subscription_status = 'active',
       current_period_ends_at = NULL
 WHERE trial_ends_at IS NULL
   AND subscription_status = 'trialing';

-- 3. From now on a new row starts a 7-day trial even if a writer forgets to
--    say so. The registration route sets these explicitly as well.
ALTER TABLE profiles ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '7 days');

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_subscription_status_known
    CHECK (subscription_status IN ('trialing', 'active'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_trial_plan_known
    CHECK (trial_plan IN ('starter', 'pro', 'enterprise'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The reminder job scans for accounts ending soon; keep that cheap.
CREATE INDEX IF NOT EXISTS profiles_trial_ends_idx
  ON profiles (trial_ends_at)
  WHERE subscription_status = 'trialing' AND expiry_reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS profiles_period_ends_idx
  ON profiles (current_period_ends_at)
  WHERE subscription_status = 'active' AND expiry_reminder_sent_at IS NULL;

-- 4. Payment declarations — the Mobile Money flow.
--    The customer pays by Wave / Orange Money / MTN / Moov and submits the
--    transaction reference; the operator checks it and approves from /admin.
--    Written only by the API (which computes the amount itself), read by the
--    customer for their own history. A payment-gateway webhook can later
--    write the same rows.
CREATE TABLE IF NOT EXISTS subscription_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  plan               text NOT NULL,
  billing_period     text NOT NULL,
  amount_fcfa        integer NOT NULL,
  payment_method     text NOT NULL,
  payer_phone        text NOT NULL,
  payment_reference  text NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  admin_note         text,
  decided_at         timestamptz,
  decided_by         uuid REFERENCES profiles (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE subscription_requests ADD CONSTRAINT subscription_requests_plan_known
    CHECK (plan IN ('starter', 'pro', 'enterprise'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE subscription_requests ADD CONSTRAINT subscription_requests_period_known
    CHECK (billing_period IN ('monthly', 'annual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE subscription_requests ADD CONSTRAINT subscription_requests_amount_positive
    CHECK (amount_fcfa > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE subscription_requests ADD CONSTRAINT subscription_requests_method_known
    CHECK (payment_method IN ('wave', 'orange_money', 'mtn_momo', 'moov_money', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE subscription_requests ADD CONSTRAINT subscription_requests_status_known
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS subscription_requests_profile_idx
  ON subscription_requests (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_requests_pending_idx
  ON subscription_requests (created_at)
  WHERE status = 'pending';

-- One pending request per account: a double click or an impatient second
-- submission must not create two payments to verify.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_requests_one_pending
  ON subscription_requests (profile_id)
  WHERE status = 'pending';

-- The same Mobile Money reference cannot be claimed twice. A rejected or
-- withdrawn request frees it, so a typo can be corrected.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_requests_reference_unique
  ON subscription_requests (payment_method, lower(payment_reference))
  WHERE status IN ('pending', 'approved');
