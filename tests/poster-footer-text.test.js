import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("profiles persist one optional footer message for every poster", () => {
  const schema = read("server/migrations/0001_core_schema.sql");
  // The field is declared once on the server's Profile and once on the API
  // client's, which is what the dashboard types against.
  const apiTypes = read("src/lib/api.ts");

  assert.match(schema, /poster_footer_text\s+text/i);
  assert.match(schema, /char_length\(poster_footer_text\) <= 120/i);
  assert.match(apiTypes, /poster_footer_text: string \| null/);
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
  const generation = read("server/src/services/generation.ts");
  const generationRoutes = read("server/src/routes/generations.ts");
  const weekly = read("server/src/services/weekly.ts");

  // One renderer builds the brief, so the manual and the weekly path cannot
  // drift into placing the user's message differently.
  assert.match(generation, /footerText/);
  assert.match(generation, /angle inférieur gauche/);
  assert.match(generation, /texte exact/);
  // Reformulating it would silently rewrite a user's own words.
  assert.match(generation, /Ne le reformule pas/);

  // Both callers pass the SAVED message, not something they compose.
  assert.match(generationRoutes, /poster_footer_text/);
  assert.match(generationRoutes, /footerText: profile\.poster_footer_text/);
  assert.match(weekly, /poster_footer_text/);
  assert.match(weekly, /footerText: profile\.poster_footer_text/);
});

test("empty footer message stays optional and does not invent a replacement", () => {
  const generation = read("server/src/services/generation.ts");
  assert.match(generation, /input\.footerText\.trim\(\)/);
  // No message means no cartouche — not a default slogan the user never wrote.
  assert.match(generation, /n'ajoute aucun texte dans l'angle inférieur gauche/);
});

test("the saved message is capped where it is stored and where it is sent", () => {
  // 120 characters in the schema, in the form, and again in the brief: a
  // longer one would be silently truncated by the renderer instead.
  assert.match(read("server/migrations/0001_core_schema.sql"), /char_length\(poster_footer_text\) <= 120/);
  assert.match(read("server/src/routes/profile.ts"), /poster_footer_text", \{ max: 120/);
  assert.match(read("server/src/services/generation.ts"), /slice\(0, 120\)/);
});
