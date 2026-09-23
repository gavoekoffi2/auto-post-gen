import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PLAN_LIMITS,
  PLAN_PRICES_FCFA,
  TRIAL_DAYS,
  isPaymentMethod,
  isPlanId,
  priceFor,
  resolveEntitlement,
} from "../src/lib/plans.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const read = (path) => readFileSync(path, "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "").replace(/\/\/.*$/gm, "");

// ── The policy itself ──────────────────────────────────────────────────

test("a running trial grants the plan chosen at signup, and says how long is left", () => {
  const e = resolveEntitlement(
    { plan: "starter", subscription_status: "trialing", trial_plan: "enterprise", trial_ends_at: iso(2.5 * DAY) },
    NOW,
  );
  assert.equal(e.state, "trialing");
  assert.equal(e.plan, "enterprise");
  assert.deepEqual(e.limits, PLAN_LIMITS.enterprise);
  assert.equal(e.daysLeft, 3, "rounded up: 2.5 days left reads as J-3, never J-2");
  assert.equal(e.canGenerate, true);
});

test("an ended trial stops new generation and falls to the smallest limits", () => {
  const e = resolveEntitlement(
    { plan: "starter", subscription_status: "trialing", trial_plan: "pro", trial_ends_at: iso(-1000) },
    NOW,
  );
  assert.equal(e.state, "expired");
  assert.equal(e.canGenerate, false);
  assert.equal(e.daysLeft, 0);
  assert.deepEqual(e.limits, PLAN_LIMITS.starter);
});

test("expiry is decided by the clock, not by a job that has to run", () => {
  const profile = { subscription_status: "trialing", trial_plan: "pro", trial_ends_at: iso(DAY) };
  assert.equal(resolveEntitlement(profile, NOW).state, "trialing");
  assert.equal(resolveEntitlement(profile, NOW + DAY + 1).state, "expired");
});

test("a paid period grants its plan until its end date, then expires", () => {
  const paid = { plan: "pro", subscription_status: "active", current_period_ends_at: iso(10 * DAY) };
  const running = resolveEntitlement(paid, NOW);
  assert.equal(running.state, "active");
  assert.equal(running.plan, "pro");
  assert.equal(running.daysLeft, 10);
  assert.equal(running.canGenerate, true);

  const lapsed = resolveEntitlement(paid, NOW + 11 * DAY);
  assert.equal(lapsed.state, "expired");
  assert.equal(lapsed.canGenerate, false);
});

test("an active plan with no end date is open-ended (complimentary or legacy accounts)", () => {
  const e = resolveEntitlement({ plan: "enterprise", subscription_status: "active", current_period_ends_at: null }, NOW);
  assert.equal(e.state, "active");
  assert.equal(e.plan, "enterprise");
  assert.equal(e.endsAt, null);
  assert.equal(e.daysLeft, null);
});

test("malformed billing data never grants more than Starter", () => {
  for (const profile of [
    null,
    {},
    { subscription_status: "active", plan: "platinum" },
    { subscription_status: "active", plan: "toString" },
    { subscription_status: "trialing", trial_plan: "pro", trial_ends_at: null },
  ]) {
    const e = resolveEntitlement(profile, NOW);
    assert.ok(e.plan === "starter" || e.state === "expired", JSON.stringify(profile));
    assert.ok(e.limits.postsPerWeek <= PLAN_LIMITS.starter.postsPerWeek, JSON.stringify(profile));
  }
  // `in` also matches inherited keys; the guards must not.
  assert.equal(isPlanId("toString"), false);
  assert.equal(isPaymentMethod("constructor"), false);
  assert.equal(isPaymentMethod("wave"), true);
});

// ── Prices ─────────────────────────────────────────────────────────────

test("the price charged is the price displayed", () => {
  assert.equal(priceFor("pro", "monthly"), PLAN_PRICES_FCFA.pro.monthly);
  assert.equal(priceFor("pro", "annual"), PLAN_PRICES_FCFA.pro.annualPerMonth * 12);
  for (const plan of Object.keys(PLAN_PRICES_FCFA)) {
    const p = PLAN_PRICES_FCFA[plan];
    assert.ok(p.annualPerMonth < p.monthly, `${plan}: annual must be cheaper per month`);
  }

  // The pricing page renders these values instead of its own copy.
  const pricing = stripComments(read("src/components/landing/PricingNew.tsx"));
  assert.match(pricing, /PLAN_PRICES_FCFA/);
  assert.doesNotMatch(pricing, /monthlyFCFA:\s*\d/);

  // The server computes the amount itself; the request cannot set it.
  const fn = stripComments(read("supabase/functions/request-subscription/index.ts"));
  assert.match(fn, /const amount = priceFor\(plan, billingPeriod\)/);
  assert.doesNotMatch(fn, /body\.amount/);
});

// ── Database ───────────────────────────────────────────────────────────

test("the trial length is the same in the code, the database and the copy", () => {
  const mig = read("supabase/migrations/20260923000000_trial_and_subscriptions.sql");
  assert.equal(TRIAL_DAYS, 7);
  assert.match(mig, /now\(\) \+ interval '7 days'/);
  const pricing = read("src/components/landing/PricingNew.tsx");
  assert.match(pricing, /TRIAL_DAYS/);
});

test("new accounts start a trial on the plan they picked; existing ones are not expired by the deploy", () => {
  const mig = stripComments(read("supabase/migrations/20260923000000_trial_and_subscriptions.sql"));
  assert.match(mig, /raw_user_meta_data ->> 'requested_plan'/);
  assert.match(mig, /IF requested NOT IN \('starter', 'pro', 'enterprise'\) THEN/);
  // Backfill: accounts that existed before become active and open-ended.
  assert.match(mig, /SET subscription_status = 'active',\s*current_period_ends_at = NULL/);
});

test("the browser cannot write its own billing state", () => {
  const mig = stripComments(read("supabase/migrations/20260923000000_trial_and_subscriptions.sql"));
  const guard = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION public.guard_profile_plan"));
  for (const column of ["plan", "subscription_status", "trial_plan", "trial_ends_at", "current_period_ends_at", "expiry_reminder_sent_at"]) {
    assert.match(guard, new RegExp(`NEW\\.${column} := OLD\\.${column};`), `${column} must be pinned on UPDATE`);
  }
  // Payment declarations are readable by their owner and written only by
  // the edge function (service role).
  assert.match(mig, /REVOKE ALL ON public\.subscription_requests FROM anon, authenticated;/);
  assert.match(mig, /GRANT SELECT ON public\.subscription_requests TO authenticated;/);
  assert.doesNotMatch(mig, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*subscription_requests[^;]*TO authenticated/);
  assert.match(mig, /USING \(auth\.uid\(\) = user_id\)/);
  // Double submissions and reused references are refused by the database.
  assert.match(mig, /uniq_subscription_requests_one_pending/);
  assert.match(mig, /uniq_subscription_requests_reference/);
});

// ── Enforcement ────────────────────────────────────────────────────────

test("an expired account is refused new content everywhere content is created", () => {
  for (const path of [
    "supabase/functions/generate-content/index.ts",
    "supabase/functions/generate-image/index.ts",
    "supabase/functions/zernio-connect/index.ts",
    "supabase/functions/comment-reply/index.ts",
  ]) {
    const src = stripComments(read(path));
    assert.match(src, /!(entitlement\.canGenerate|resolveEntitlement\(profile\)\.canGenerate)/, path);
    assert.match(src, /code: "subscription_expired"/, path);
  }
  const weekly = stripComments(read("supabase/functions/auto-generate-weekly/index.ts"));
  assert.match(weekly, /if \(!entitlement\.canGenerate\)/);
  const comments = stripComments(read("supabase/functions/sync-comments/index.ts"));
  assert.match(comments, /entitlement\.canGenerate && entitlement\.limits\.aiAutoReply/);
});

test("already scheduled posts are still published after expiry", () => {
  // The promise made in the reminder emails and on the subscription page.
  const publish = read("supabase/functions/publish-post/index.ts");
  assert.doesNotMatch(publish, /resolveEntitlement|subscription_status/);
});

test("approval grants the plan; nothing the customer sends can", () => {
  const adminApi = stripComments(read("supabase/functions/admin-api/index.ts"));
  // Claimed conditionally so two admins cannot grant one payment twice.
  assert.match(adminApi, /\.eq\("status", "pending"\)\s*\.select\("id"\)/);
  assert.match(adminApi, /subscription_status: "active",\s*current_period_ends_at: periodEnd\.toISOString\(\)/);
  // Approval is super-admin only: it sits after the role gate.
  assert.ok(
    adminApi.indexOf('action === "approve_subscription"') > adminApi.indexOf('actorRole !== "super_admin"'),
  );
  const request = stripComments(read("supabase/functions/request-subscription/index.ts"));
  assert.doesNotMatch(request, /\.from\("profiles"\)\s*\.update/);
});
