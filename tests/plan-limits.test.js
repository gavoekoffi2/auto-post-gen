import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync("supabase/functions/_shared/plans.ts", "utf8");
const client = readFileSync("src/lib/plans.ts", "utf8");

/** Pull the PLAN_LIMITS literal out of either copy without executing TS. */
function parseLimits(source) {
  const start = source.indexOf("export const PLAN_LIMITS");
  assert.ok(start >= 0, "PLAN_LIMITS must be exported");
  const body = source.slice(source.indexOf("{", start), source.indexOf("\n};", start));
  const limits = {};
  for (const [, plan, fields] of body.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
    const entry = {};
    for (const [, key, value] of fields.matchAll(/(\w+):\s*([^,\n]+)/g)) {
      const raw = value.trim().replace(/^["']|["'],?$/g, "").replace(/,$/, "");
      entry[key] = /^\d+$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
    }
    limits[plan] = entry;
  }
  return limits;
}

test("the browser mirror of the plan limits never drifts from the server copy", () => {
  // The UI copy only labels and pre-constrains; the server copy enforces. If
  // they disagree, the product promises a limit it will not honour (or blocks
  // something the customer paid for).
  assert.deepEqual(parseLimits(client), parseLimits(server));
});

test("plan limits match the published pricing page", () => {
  const limits = parseLimits(server);
  const pricing = readFileSync("src/components/landing/PricingNew.tsx", "utf8");

  assert.equal(limits.starter.postsPerWeek, 3);
  assert.equal(limits.starter.socialAccounts, 2);
  assert.equal(limits.pro.postsPerWeek, 7);
  assert.equal(limits.pro.socialAccounts, 3);
  assert.equal(limits.enterprise.postsPerWeek, 10);
  assert.equal(limits.enterprise.socialAccounts, 8);

  // What the customer is actually shown before paying.
  assert.match(pricing, /3 posts par semaine/);
  assert.match(pricing, /2 réseaux sociaux/);
  assert.match(pricing, /7\/semaine/);
  assert.match(pricing, /3 réseaux sociaux/);
  assert.match(pricing, /10 posts\/semaine/);
  assert.match(pricing, /8 réseaux sociaux/);

  // AI auto-reply is sold as Enterprise-only.
  assert.equal(limits.starter.aiAutoReply, false);
  assert.equal(limits.pro.aiAutoReply, false);
  assert.equal(limits.enterprise.aiAutoReply, true);
});

test("an unknown or missing plan degrades to the most restrictive tier", () => {
  assert.match(server, /return PLAN_LIMITS\[key as PlanId\] \?\? PLAN_LIMITS\.starter/);
});

test("every advertised limit is enforced server-side, not just in the UI", () => {
  const weekly = readFileSync("supabase/functions/auto-generate-weekly/index.ts", "utf8");
  const text = readFileSync("supabase/functions/generate-content/index.ts", "utf8");
  const image = readFileSync("supabase/functions/generate-image/index.ts", "utf8");
  const connect = readFileSync("supabase/functions/zernio-connect/index.ts", "utf8");
  const comments = readFileSync("supabase/functions/sync-comments/index.ts", "utf8");

  // Weekly volume: post_frequency is client-written, so it must be clamped.
  assert.match(weekly, /limits\.postsPerWeek/);
  assert.match(weekly, /planLimits\(profile\.plan\)/);

  // AI cost ceilings come from the plan, not a flat constant.
  assert.match(text, /limits\.monthlyTextGenerations/);
  assert.match(image, /limits\.monthlyImageGenerations/);
  assert.doesNotMatch(text, /MONTHLY_LIMIT_MAX/);
  assert.doesNotMatch(image, /IMAGE_MONTHLY_MAX/);

  // Connected networks.
  assert.match(connect, /limits\.socialAccounts/);
  assert.match(connect, /plan_limit_reached/);

  // Auto-reply entitlement.
  assert.match(comments, /planLimits\(profile\?\.plan\)\.aiAutoReply/);

  // Each of these reads `plan` from the database with the service role, never
  // from the request body (the column is trigger-protected from client writes).
  for (const [name, source] of [["generate-content", text], ["generate-image", image], ["zernio-connect", connect]]) {
    assert.match(
      source,
      /\.from\("profiles"\)\s*\n?\s*\.select\("plan"\)/,
      `${name} must read the plan server-side`,
    );
  }
});

test("onboarding offers only the volumes a new account will actually receive", () => {
  const onboarding = readFileSync("src/pages/Onboarding.tsx", "utf8");
  // First they were a hardcoded 2/5/10 matching no plan sold; then all three
  // plan volumes, of which two were silently rewritten on save because every
  // signup starts on Starter. Offering a choice and discarding it is worse
  // than not offering it.
  assert.match(onboarding, /PLAN_LIMITS\.starter\.postsPerWeek/);
  assert.doesNotMatch(onboarding, /2 posts\/semaine \(Starter\)/);
  assert.doesNotMatch(onboarding, /Object\.values\(PLAN_LIMITS\)\.map/);
  // And the ceiling is explained rather than left as a silent cap.
  assert.match(onboarding, /Votre compte démarre sur le forfait/);
});

test("the editorial mix can never fill a whole week with advertising", () => {
  const weekly = readFileSync("supabase/functions/auto-generate-weekly/index.ts", "utf8");
  const profile = readFileSync("src/pages/Profile.tsx", "utf8");
  // promo takes its slots first. With promo_posts_per_week equal to the
  // plan-clamped weekly volume, every post that week was an advertisement.
  assert.match(weekly, /const maxPromo = postsNeeded > 1 \? postsNeeded - 1 : postsNeeded/);
  assert.match(weekly, /promoTarget = Math\.min\(\s*Math\.max\(0, profile\.promo_posts_per_week \?\? 1\),\s*maxPromo,/);
  // The UI offers and saves the same ceiling, built from the PLAN-clamped
  // frequency rather than the raw stored value.
  assert.match(profile, /effectivePromoMax/);
  assert.match(profile, /effectiveFrequency = Math\.min\(profile\.post_frequency, limits\.postsPerWeek\)/);
  assert.doesNotMatch(profile, /profile\.post_frequency - profile\.promo_posts_per_week,\s*\) \+ 1/);
});

test("the network limit is visible before it is hit, not only when refused", () => {
  const status = readFileSync("supabase/functions/zernio-status/index.ts", "utf8");
  const ui = readFileSync("src/components/SocialMediaConnect.tsx", "utf8");

  // Discovering your plan's ceiling only when a connection is refused reads
  // like a bug rather than a limit.
  assert.match(status, /planLimits\(planRow\?\.plan\)/);
  assert.match(status, /maxAccounts: limits\.socialAccounts/);
  assert.match(ui, /maxAccounts/);
  assert.match(ui, /réseau/);

  // Already-connected platforms stay clickable (re-authorising is a repair,
  // not a new account); only new ones are blocked at the ceiling.
  assert.match(ui, /disabled=\{zernioLoading \|\| \(atLimit && !connected\)\}/);
});
