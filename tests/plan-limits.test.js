import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Node strips the TypeScript annotations, so the policy is tested by running
// the real code rather than by pattern-matching it.
import {
  PLAN_LIMITS,
  PLAN_PRICES_FCFA,
  TRIAL_DAYS,
  isPlanId,
  priceFor,
  resolveEntitlement,
} from "../src/lib/plans.ts";

const server = readFileSync("supabase/functions/_shared/plans.ts", "utf8");
const client = readFileSync("src/lib/plans.ts", "utf8");

test("the browser mirror of the plan limits never drifts from the server copy", () => {
  // The UI copy labels, prices and pre-constrains; the server copy enforces.
  // If they disagree, the product promises a limit it will not honour, shows
  // a price it will not charge, or calls an account expired that the server
  // still serves. Everything after the marker must be byte-identical.
  const marker = "// ───── Everything below this line is shared verbatim with its mirror. ─────";
  const shared = (source) => {
    const at = source.indexOf(marker);
    assert.ok(at >= 0, "shared-body marker missing");
    return source.slice(at);
  };
  assert.equal(shared(client), shared(server));
});

test("plan limits match the published pricing page", () => {
  const limits = PLAN_LIMITS;
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
  assert.match(weekly, /resolveEntitlement\(profile\)/);

  // AI cost ceilings come from the plan, not a flat constant.
  assert.match(text, /limits\.monthlyTextGenerations/);
  assert.match(image, /limits\.monthlyImageGenerations/);
  assert.doesNotMatch(text, /MONTHLY_LIMIT_MAX/);
  assert.doesNotMatch(image, /IMAGE_MONTHLY_MAX/);

  // Connected networks.
  assert.match(connect, /limits\.socialAccounts/);
  assert.match(connect, /plan_limit_reached/);

  // Auto-reply entitlement.
  assert.match(comments, /entitlement\.limits\.aiAutoReply/);

  // Each of these reads the subscription from the database with the service
  // role, never from the request body (the columns are trigger-protected from
  // client writes), and derives limits through resolveEntitlement.
  for (const [name, source] of [["generate-content", text], ["generate-image", image], ["zernio-connect", connect]]) {
    assert.match(
      source,
      /\.from\("profiles"\)\s*\n?\s*\.select\(ENTITLEMENT_COLUMNS\)/,
      `${name} must read the subscription server-side`,
    );
    assert.match(source, /const limits = entitlement\.limits/, `${name} must use the entitlement's limits`);
  }
});

test("onboarding offers only the volumes a new account will actually receive", () => {
  const onboarding = readFileSync("src/pages/Onboarding.tsx", "utf8");
  // First they were a hardcoded 2/5/10 matching no plan sold; then all three
  // plan volumes, of which two were silently rewritten on save because every
  // signup starts on Starter. Offering a choice and discarding it is worse
  // than not offering it.
  // Since the free trial, a new account is entitled to the plan it picked on
  // the pricing page, so the ceiling comes from its entitlement.
  assert.match(onboarding, /resolveEntitlement\(profile\)/);
  assert.match(onboarding, /\{ length: limits\.postsPerWeek \}/);
  assert.match(onboarding, /parseInt\(formData\.frequency\),\s*limits\.postsPerWeek/);
  assert.doesNotMatch(onboarding, /2 posts\/semaine \(Starter\)/);
  assert.doesNotMatch(onboarding, /Object\.values\(PLAN_LIMITS\)\.map/);
  // And the ceiling is explained rather than left as a silent cap.
  assert.match(onboarding, /inclut jusqu'à \$\{limits\.postsPerWeek\} posts\/semaine/);
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
  assert.match(status, /resolveEntitlement\(planRow\)/);
  assert.match(status, /maxAccounts: limits\.socialAccounts/);
  assert.match(ui, /maxAccounts/);
  assert.match(ui, /réseau/);

  // Already-connected platforms stay clickable (re-authorising is a repair,
  // not a new account); only new ones are blocked at the ceiling.
  assert.match(ui, /disabled=\{zernioLoading \|\| \(atLimit && !connected\)\}/);
});

test("the pricing page only claims differences the code enforces", () => {
  // Comments stripped: the fix is explained in one, and a test that matched
  // the explanation would assert the opposite of what it means to check.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const pricing = stripComments(readFileSync("src/components/landing/PricingNew.tsx", "utf8"));
  const stats = stripComments(readFileSync("src/pages/Statistics.tsx", "utf8"));

  // Starter was sold without "Analytics avancés" and "Posts personnalisables",
  // and Pro with "Analytics détaillés" — but the statistics screen does not
  // read `plan` at all and the editor is the same for everyone. Someone
  // upgrading for those would have received exactly what they already had.
  assert.equal(stats.includes("plan"), false, "Statistics does not vary by plan");
  for (const claim of ["Analytics avancés", "Analytics détaillés", "Analytics & rapports avancés", "Posts personnalisables"]) {
    assert.doesNotMatch(pricing, new RegExp(claim), `pricing still claims "${claim}"`);
  }

  // The real differentiators, and only those.
  assert.match(pricing, /Quota IA mensuel étendu/);
  assert.match(pricing, /Quota IA mensuel maximal/);
  assert.match(pricing, /Réponses auto aux commentaires \(IA\)", included: false/);
  assert.match(pricing, /Réponses automatiques aux commentaires \(IA\)", included: true/);
});
