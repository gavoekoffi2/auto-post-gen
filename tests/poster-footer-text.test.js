import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("profiles persist one optional footer message for every poster", () => {
  const migration = read("supabase/migrations/20260723000000_poster_footer_text.sql");
  const types = read("src/integrations/supabase/types.ts");

  assert.match(migration, /poster_footer_text text/i);
  assert.match(migration, /char_length\(poster_footer_text\) <= 120/i);
  assert.match(types, /poster_footer_text: string \| null/);
  assert.match(types, /poster_footer_text\?: string \| null/);
});

test("profile and onboarding let the user choose and preview the footer message", () => {
  const profile = read("src/pages/Profile.tsx");
  const onboarding = read("src/pages/Onboarding.tsx");

  for (const source of [profile, onboarding]) {
    assert.match(source, /poster_footer_text|posterFooterText/);
    assert.match(source, /Texte permanent sur vos affiches/);
    assert.match(source, /maxLength=\{120\}/);
    assert.match(source, /Abonnez-vous pour plus de conseils/);
  }
  assert.match(profile, /Aperçu sur l’affiche/);
  assert.match(profile, /angle inférieur gauche/);
});

test("manual and automatic poster generation place the exact saved message bottom-left", () => {
  const manual = read("supabase/functions/generate-image/index.ts");
  const shared = read("supabase/functions/_shared/graphiste.ts");
  const weekly = read("supabase/functions/auto-generate-weekly/index.ts");

  for (const source of [manual, shared]) {
    assert.match(source, /footerText/);
    assert.match(source, /angle inférieur gauche/);
    assert.match(source, /texte exact/);
    assert.match(source, /angle inférieur droit/);
  }

  assert.match(manual, /poster_footer_text/);
  assert.match(manual, /footerText: profile\?\.poster_footer_text/);
  assert.match(weekly, /poster_footer_text/);
  assert.match(weekly, /footerText: profile\.poster_footer_text/);
});

test("empty footer message stays optional and does not invent a replacement", () => {
  const manual = read("supabase/functions/generate-image/index.ts");
  const shared = read("supabase/functions/_shared/graphiste.ts");

  assert.match(manual, /params\.footerText\.trim\(\)/);
  assert.match(shared, /params\.footerText\.trim\(\)/);
  assert.match(manual, /n'ajoute aucun texte permanent dans l'angle inférieur gauche/);
  assert.match(shared, /n'ajoute aucun texte permanent dans l'angle inférieur gauche/);
});
