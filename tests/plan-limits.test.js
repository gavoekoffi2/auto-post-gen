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

test("the onboarding frequency choices come from the plan table", () => {
  const onboarding = readFileSync("src/pages/Onboarding.tsx", "utf8");
  // They used to be a hardcoded 2/5/10 that matched no plan actually sold.
  assert.match(onboarding, /Object\.values\(PLAN_LIMITS\)/);
  assert.doesNotMatch(onboarding, /2 posts\/semaine \(Starter\)/);
});
