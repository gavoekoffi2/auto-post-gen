import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Node strips the TypeScript annotations, so the policy is tested by running
// the real code rather than by pattern-matching it.
import {
  PLAN_LIMITS,
  PLAN_PRICES_FCFA,
  TRIAL_DAYS,
  isPaymentMethod,
  isPlanId,
  priceFor,
  resolveEntitlement,
} from "../server/src/shared/plans.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "").replace(/\/\/.*$/gm, "");

// ── One definition, two runtimes ───────────────────────────────────────

test("the dashboard's copy of the plans is byte-identical to the API's", () => {
  // The API copy enforces; the dashboard copy labels, prices and
  // pre-constrains. If they disagree, the product shows a price it will not
  // charge, or calls an account expired that the server still serves.
  assert.equal(read("src/lib/plans.ts"), read("server/src/shared/plans.ts"));
});

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
  const lapsed = resolveEntitlement(paid, NOW + 11 * DAY);
  assert.equal(lapsed.state, "expired");
  assert.equal(lapsed.canGenerate, false);
});

test("an active plan with no end date is open-ended (complimentary or pre-existing accounts)", () => {
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
  // The pricing page renders the shared list instead of its own copy.
  const pricing = stripComments(read("src/components/landing/PricingNew.tsx"));
  assert.match(pricing, /PLAN_PRICES_FCFA\[plan\.id\]/);
  assert.doesNotMatch(pricing, /monthlyFCFA:\s*\d/);
  assert.match(pricing, /to=\{`\/auth\?plan=\$\{plan\.id\}`\}/, "each CTA starts the trial of its own plan");
  // The server computes the amount itself; the request cannot set it.
  const service = stripComments(read("server/src/services/subscriptions.ts"));
  assert.match(service, /const amount = priceFor\(plan, billingPeriod\)/);
  assert.doesNotMatch(service, /input\.amount/);
});

test("the pricing page only claims what the product does", () => {
  const pricing = stripComments(read("src/components/landing/PricingNew.tsx"));
  // Features that do not exist on this stack, or do not differ by plan.
  for (const claim of [
    "Analytics avancés", "Analytics détaillés", "Posts personnalisables", "Validation par email",
    "ou carte bancaire", "1 500 FCFA", "24/7",
  ]) {
    assert.doesNotMatch(pricing, new RegExp(claim), `pricing still claims "${claim}"`);
  }
  // The limits sold are the limits enforced.
  assert.match(pricing, new RegExp(`${PLAN_LIMITS.starter.postsPerWeek} posts par semaine`));
  assert.match(pricing, new RegExp(`${PLAN_LIMITS.enterprise.postsPerWeek} posts/semaine`));
  assert.match(pricing, new RegExp(`${PLAN_LIMITS.pro.monthlyImageGenerations} affiches`));
});

// ── Database ───────────────────────────────────────────────────────────

const migration = read("server/migrations/0003_trial_and_subscriptions.sql");

test("the trial length is the same in the code, the database and the copy", () => {
  assert.equal(TRIAL_DAYS, 7);
  assert.match(migration, /now\(\) \+ interval '7 days'/);
  assert.match(read("server/src/routes/auth.ts"), /make_interval\(days => \$5\)/);
  assert.match(read("src/components/landing/PricingNew.tsx"), /TRIAL_DAYS/);
});

test("existing accounts are not expired by the deploy, and replay changes nothing", () => {
  const sql = stripComments(migration);
  assert.match(sql, /SET subscription_status = 'active',\s*current_period_ends_at = NULL\s*WHERE trial_ends_at IS NULL\s*AND subscription_status = 'trialing'/);
  // The default that would make the backfill match new rows is set AFTER it.
  assert.ok(
    sql.indexOf("SET DEFAULT (now() + interval '7 days')") > sql.indexOf("SET subscription_status = 'active'"),
  );
  // Every constraint is guarded, so CI's double replay passes.
  const constraints = sql.match(/ADD CONSTRAINT/g) || [];
  const guarded = sql.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
  assert.equal(constraints.length, guarded.length);
  // Double declarations are refused by the database, not only by the code.
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS subscription_requests_one_pending/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS subscription_requests_reference_unique/);
});

// ── Enforcement ────────────────────────────────────────────────────────

test("every place that creates content checks the entitlement", () => {
  const generations = stripComments(read("server/src/routes/generations.ts"));
  assert.equal((generations.match(/requireActiveEntitlement\(ctx\.profileId\)/g) || []).length, 2, "text and poster");
  assert.match(generations, /limits\.monthlyTextGenerations/);
  assert.match(generations, /limits\.monthlyImageGenerations/);
  // Resuming an existing poster job is a status read, never gated or billed.
  const resume = generations.slice(generations.indexOf('app.get("/generations/:id"'));
  assert.doesNotMatch(resume, /requireActiveEntitlement/);

  const weekly = stripComments(read("server/src/services/weekly.ts"));
  assert.match(weekly, /if \(!entitlement\.canGenerate\) return \{ profileId, generated: 0, skipped: "subscription_expired" \}/);
  assert.match(weekly, /entitlement\.limits\.postsPerWeek/);
});

test("already scheduled posts are still published after expiry", () => {
  // The promise made on the subscription page and in the reminder emails.
  for (const path of ["server/src/services/publish.ts", "server/src/services/scheduler.ts"]) {
    assert.doesNotMatch(stripComments(read(path)), /loadEntitlement|requireActiveEntitlement|subscription_status/, path);
  }
});

test("an approval is an operator action, and it is atomic", () => {
  const service = stripComments(read("server/src/services/subscriptions.ts"));
  assert.match(service, /FROM subscription_requests WHERE id = \$1 FOR UPDATE/);
  assert.match(service, /if \(request\.status !== "pending"\) throw conflict/);
  const misc = stripComments(read("server/src/routes/misc.ts"));
  const adminBlock = misc.slice(misc.indexOf('app.post("/admin/actions"'));
  assert.match(adminBlock, /const ctx = await requireAdmin\(request, reply\)/);
  assert.ok(adminBlock.indexOf('action === "approve_subscription"') > 0, "approval lives behind requireAdmin");
  // The customer's routes can declare and cancel, nothing else.
  const billing = stripComments(read("server/src/routes/billing.ts"));
  assert.doesNotMatch(billing, /decideRequest|setPlanManually|extendTrial|UPDATE profiles/);
});

// ── The dashboard ──────────────────────────────────────────────────────

test("the dashboard shows the deadline and sends an expired account to renew", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.match(dashboard, /<SubscriptionBanner profile=\{userProfile\} \/>/);
  assert.match(dashboard, /if \(!canGenerate\) \{\s*navigate\("\/abonnement"\);/);
  const app = read("src/App.tsx");
  assert.match(app, /path="\/abonnement"/);
  // Onboarding and profile offer only the volume the account receives.
  for (const page of ["src/pages/Onboarding.tsx", "src/pages/Profile.tsx"]) {
    assert.match(read(page), /\{ length: limits\.postsPerWeek \}/, page);
  }
  assert.doesNotMatch(read("src/pages/Onboarding.tsx"), /\(Starter\)|\(Pro\)|\(Enterprise\)/);
});

test("the subscription screens talk to the self-hosted API only", () => {
  for (const path of [
    "src/pages/Subscription.tsx", "src/components/SubscriptionBanner.tsx", "src/pages/Admin.tsx",
    "src/lib/plans.ts", "server/src/shared/plans.ts",
  ]) {
    const src = read(path);
    assert.doesNotMatch(src, /supabase/i, `${path} must not reference Supabase`);
    assert.doesNotMatch(src, /VITE_/, `${path} must not depend on a build-time variable`);
  }
  // The payment numbers come from the API (server env), not from the bundle.
  assert.match(read("src/pages/Subscription.tsx"), /subscription\.get\(\)/);
  assert.match(read("server/src/lib/env.ts"), /PAYMENT_WAVE/);
});

test("the owner's address is no longer shipped in the admin bundle", () => {
  const adminPage = read("src/pages/Admin.tsx");
  assert.doesNotMatch(adminPage, /@gmail\.com/);
  assert.match(adminPage, /user\.protectedOwner/);
});

test("the legal pages carry a real revision date", () => {
  for (const page of ["src/pages/Terms.tsx", "src/pages/Privacy.tsx"]) {
    const src = read(page);
    assert.doesNotMatch(src, /new Date\(\)\.toLocaleDateString/, page);
    assert.match(src, /formatLegalDate\(\)/, page);
  }
  assert.match(read("src/lib/legal.ts"), /LEGAL_LAST_UPDATED = "\d{4}-\d{2}-\d{2}"/);
});

// ── Migrations 0004 / 0005 ─────────────────────────────────────────────

test("the write probe mirrors the API's real job write, provider included", () => {
  // Production's generation_jobs has `provider text NOT NULL`; a probe that
  // inserted a job without one failed the rehearsal on the real copy.
  const probe = read("server/migrations/0000_legacy_production_compat.sql");
  const block = probe.slice(probe.indexOf("DO $probe$"), probe.indexOf("$probe$;"));
  assert.match(block, /INSERT INTO generation_jobs\s*\(profile_id, post_id, kind, status, provider, provider_job_id,\s*provider_status_url, result_url, error, format\)/);
  assert.match(block, /'image', 'processing', 'graphiste'/);
  // …and the API really writes that provider.
  assert.match(read("server/src/services/generation.ts"), /VALUES \(\$1, \$2, 'image', \$3, 'graphiste'/);
});

test("provider is mandatory everywhere, without rewriting historical jobs", () => {
  const sql = stripComments(read("server/migrations/0004_generation_job_provider.sql"));
  assert.match(sql, /ALTER COLUMN provider SET NOT NULL/);
  assert.match(sql, /CHECK \(provider IS NOT NULL\) NOT VALID/);
  assert.doesNotMatch(sql, /UPDATE generation_jobs/, "no provider is invented for historical rows");
  assert.doesNotMatch(sql, /DROP NOT NULL/);
});

test("a Mobile Money reference serves once, whatever its status, in any spelling", () => {
  const sql = stripComments(read("server/migrations/0005_payment_reference_once.sql"));
  // One global unique index on the canonical form, with no status filter.
  assert.match(sql, /CREATE UNIQUE INDEX subscription_requests_reference_once\s+ON subscription_requests \(upper\(regexp_replace\(payment_reference, '\\s', '', 'g'\)\)\);/);
  const index = sql.slice(sql.indexOf("CREATE UNIQUE INDEX"));
  assert.doesNotMatch(index.split(";")[0], /WHERE/, "no status may free a reference");
  // Existing duplicates stop the migration instead of being silently kept or deleted.
  assert.match(sql, /RAISE EXCEPTION/);
  // The API stores the same canonical form it is compared in.
  const service = read("server/src/services/subscriptions.ts");
  assert.match(service, /raw\.replace\(\/\\s\+\/g, ""\)\.toUpperCase\(\)/);
  assert.match(service, /const reference = canonicalReference\(input\.paymentReference\)/);
  assert.match(service, /subscription_requests_reference_once/);
});
