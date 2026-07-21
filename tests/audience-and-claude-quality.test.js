import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("all editorial text generation defaults to Anthropic Claude Sonnet", () => {
  const ai = read("supabase/functions/_shared/ai.ts");
  assert.match(ai, /anthropic\/claude-sonnet-5/);
  assert.match(ai, /configured\.startsWith\("anthropic\/claude-"\)/);
  assert.doesNotMatch(ai, /return\s+["']google\/gemini-2\.5-flash["']/);
});

test("audience analysis is authenticated, Claude-powered and returns several actionable segments", () => {
  const fn = read("supabase/functions/detect-audiences/index.ts");
  assert.match(fn, /supabase\.auth\.getUser\(jwt\)/);
  assert.match(fn, /getTextModel\(\)/);
  assert.match(fn, /3 à 6 segments/);
  for (const field of ["pain_points", "goals", "content_topics", "buying_triggers"]) {
    assert.match(fn, new RegExp(field));
  }
});

test("database persists AI suggestions and explicit human-approved targets", () => {
  const migration = read("supabase/migrations/20260722000000_target_audiences.sql");
  assert.match(migration, /audience_suggestions jsonb/i);
  assert.match(migration, /target_audiences jsonb/i);
  assert.match(migration, /audiences_confirmed_at timestamptz/i);
});

test("manual and scheduled posts are explicitly written for approved audiences", () => {
  for (const path of [
    "supabase/functions/generate-content/index.ts",
    "supabase/functions/auto-generate-weekly/index.ts",
  ]) {
    const source = read(path);
    assert.match(source, /target_audiences/);
    assert.match(source, /buildAudiencePrompt/);
    assert.match(source, /DOULEURS|pain_points/);
    assert.match(source, /OBJECTIFS|goals/);
    assert.match(source, /UNE CIBLE PRIORITAIRE/i);
  }
});

test("onboarding proposes targets automatically and requires human validation", () => {
  const onboarding = read("src/pages/Onboarding.tsx");
  assert.match(onboarding, /detect-audiences/);
  assert.match(onboarding, /Cibles recommandées/);
  assert.match(onboarding, /target_audiences/);
  assert.match(onboarding, /audiences_confirmed_at/);
  assert.match(onboarding, /Sélectionnez au moins une cible/);
});

test("profile lets users re-analyse, select and edit multiple audiences", () => {
  const profile = read("src/pages/Profile.tsx") + read("src/components/AudienceEditor.tsx");
  assert.match(profile, /detect-audiences/);
  assert.match(profile, /Analyser à nouveau/);
  assert.match(profile, /target_audiences/);
  assert.match(profile, /audience_suggestions/);
  assert.match(profile, /Cibles de communication/);
});
