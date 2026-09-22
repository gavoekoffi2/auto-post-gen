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
