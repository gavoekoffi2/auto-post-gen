import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("all editorial text generation defaults to Anthropic Claude Sonnet", () => {
  const text = read("server/src/services/text.ts");
  assert.match(text, /anthropic\/claude-sonnet-5/);
  assert.match(text, /configured\.startsWith\("anthropic\/claude-"\)/);
  // Any non-Claude vendor here would quietly break the product's promise.
  assert.doesNotMatch(text, /["']google\/gemini/);
  assert.doesNotMatch(text, /["']openai\//);
});

test("audience analysis is authenticated, Claude-powered and returns several actionable segments", () => {
  const route = read("server/src/routes/profile.ts");
  const service = read("server/src/services/audiences.ts");

  // The identity comes from the verified session, never from the request body.
  assert.match(route, /app\.post\("\/profile\/audiences\/detect"/);
  assert.match(route, /requireTenant\(request, reply\)/);
  assert.match(route, /detectAudiences\(ctx\.profileId\)/);

  assert.match(service, /callClaude\(/);
  assert.match(service, /3 à 6 segments/);
  for (const field of ["pain_points", "goals", "content_topics", "buying_triggers"]) {
    assert.match(service, new RegExp(field));
  }
});

test("a failed analysis gives the hourly reservation back", () => {
  const route = read("server/src/routes/profile.ts");
  // Otherwise a provider outage burns the user's ten hourly attempts during
  // onboarding, where there is nothing else for them to do.
  assert.match(route, /releaseQuota\(ctx\.profileId, "detect-audiences"\)/);
});

test("the analysis only ever proposes: a human still has to select the targets", () => {
  const route = read("server/src/routes/profile.ts");
  // It writes audience_suggestions. Writing target_audiences here would turn a
  // machine proposal into a confirmed target without anyone agreeing to it.
  assert.match(route, /UPDATE profiles SET audience_suggestions/);
  const detectBlock = route.slice(route.indexOf('/profile/audiences/detect'));
  assert.doesNotMatch(detectBlock, /UPDATE profiles SET target_audiences/);
});

test("database persists AI suggestions and explicit human-approved targets", () => {
  const migration = read("server/migrations/0001_core_schema.sql");
  assert.match(migration, /audience_suggestions\s+jsonb/i);
  assert.match(migration, /target_audiences\s+jsonb/i);
  assert.match(migration, /audiences_confirmed_at\s+timestamptz/i);
});

test("generated posts are explicitly written for approved audiences", () => {
  const source = read("server/src/services/text.ts");
  assert.match(source, /target_audiences/);
  assert.match(source, /buildAudiencePrompt/);
  const prompt = read("server/src/shared/audience.ts");
  assert.match(prompt, /DOULEURS|pain_points/);
  assert.match(prompt, /OBJECTIFS|goals/);
  assert.match(prompt, /UNE CIBLE PRIORITAIRE/i);
});

test("onboarding proposes targets automatically and requires human validation", () => {
  const onboarding = read("src/pages/Onboarding.tsx");
  assert.match(onboarding, /profileApi\.detectAudiences\(\)/);
  assert.match(onboarding, /Cibles recommandées/);
  assert.match(onboarding, /target_audiences/);
  assert.match(onboarding, /audiences_confirmed_at/);
  assert.match(onboarding, /Sélectionnez au moins une cible/);
});

test("profile lets users re-analyse, select and edit multiple audiences", () => {
  const profile = read("src/pages/Profile.tsx") + read("src/components/AudienceEditor.tsx");
  assert.match(profile, /profileApi\.detectAudiences\(\)/);
  assert.match(profile, /Analyser à nouveau/);
  assert.match(profile, /target_audiences/);
  assert.match(profile, /audience_suggestions/);
  assert.match(profile, /Cibles de communication/);
});
