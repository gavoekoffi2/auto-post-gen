import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Public marketing surfaces: the pages a prospective customer sees before
// signing up, where a factual claim is a commercial representation.
const PUBLIC_PAGES = [
  ...readdirSync(join(root, "src/components/landing")).map((f) => `src/components/landing/${f}`),
  "src/pages/About.tsx",
  "src/pages/Index.tsx",
  "src/components/Footer.tsx",
];

test("no customer testimonial or headline figure is hardcoded into a page", () => {
  // Presenting fabricated consumer endorsements is unfair in all circumstances
  // under Annex I of Directive 2005/29/EC, and false claims about the
  // customer base are a "pratique commerciale trompeuse" (C. conso. L121-2).
  // Both must come from src/lib/testimonials.ts, which ships empty, so nothing
  // untrue can be published by accident.
  const store = read("src/lib/testimonials.ts");
  assert.match(store, /export const TESTIMONIALS: Testimonial\[\] = \[\]/);
  assert.match(store, /export const PLATFORM_STATS: PlatformStat\[\] = \[\]/);

  for (const page of PUBLIC_PAGES) {
    const source = read(page);
    assert.doesNotMatch(source, /rating:\s*\d/, `${page} hardcodes a testimonial rating`);
    assert.doesNotMatch(source, /images\.unsplash\.com/, `${page} uses a stock photo of a real person as a customer`);
  }
});

test("no invented user count or satisfaction rate is claimed anywhere", () => {
  const forbidden = [
    /10\s?000 créateurs/i,
    /milliers de créateurs/i,
    /10K\+/,
    /500K\+/,
    /500\+/,
    /98\s?%/,
    /\+\s?300\s?%/,
  ];
  for (const page of PUBLIC_PAGES) {
    const source = read(page);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${page} still claims ${pattern}`);
    }
  }
});

test("the legal pages state a fixed revision date, not today's", () => {
  const config = read("src/lib/appConfig.ts");
  // Both pages rendered new Date(), so they always claimed to have been
  // revised today. On a legal document that field is how a user knows whether
  // the terms changed since they accepted them; one that recomputes daily
  // says nothing.
  assert.match(config, /LEGAL_LAST_UPDATED = "\d{4}-\d{2}-\d{2}"/);
  for (const page of ["src/pages/Privacy.tsx", "src/pages/Terms.tsx"]) {
    const source = read(page);
    assert.match(source, /formatLegalDate\(\)/, `${page} must use the fixed date`);
    assert.doesNotMatch(
      source,
      /Dernière mise à jour : \{new Date\(\)/,
      `${page} still recomputes its revision date`,
    );
  }
});

test("the privacy policy names the processors that actually receive data", () => {
  const privacy = read("src/pages/Privacy.tsx");
  // GDPR art. 13 requires informing about recipients and transfers outside
  // the EU. "des prestataires de services" does not, least of all for a
  // product that sends the customer's business description to third-party AI.
  for (const processor of ["Supabase", "OpenRouter", "Graphiste GPT", "Zernio", "Resend"]) {
    assert.match(privacy, new RegExp(processor), `the policy must disclose ${processor}`);
  }
  assert.match(privacy, /hors de l'Union européenne/);
});

test("the FAQ describes the product that exists", () => {
  const faq = read("src/pages/FAQ.tsx");

  // It promised cancelling a subscription "depuis votre espace client".
  // There is no billing in the product at all, so that page does not exist.
  assert.doesNotMatch(faq, /annuler à tout moment depuis votre espace client/);
  assert.doesNotMatch(faq, /période de facturation/);

  // It quoted "de 1 à 7 posts par semaine", matching no plan that is sold.
  assert.doesNotMatch(faq, /de 1 à 7 posts par semaine/);
  assert.match(faq, /PLAN_LIMITS\.starter\.postsPerWeek/);
  assert.match(faq, /PLAN_LIMITS\.enterprise\.postsPerWeek/);
});
