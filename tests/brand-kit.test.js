import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The visual identity on posters: the account's real photo in the gesture
// that suits each message, its logo applied as uploaded, its palette imposed.
// Behaviour is tested against Postgres in server/tests/brand-kit.test.ts and
// server/tests/audit-fixes.test.ts; these pin the design.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const keys = (source, marker) => {
  const block = source.slice(source.indexOf(marker));
  return [...block.slice(0, block.indexOf("} as const")).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
};

test("the gestures are the same in the dashboard, the API and the database", () => {
  const ui = keys(read("src/lib/poses.ts"), "export const GESTURES = {");
  const api = keys(read("server/src/services/poses.ts"), "export const GESTURES = {");
  assert.deepEqual(ui, api);
  const migration = read("server/migrations/0008_brand_kit_and_poses.sql");
  const checked = /CHECK \(gesture IN \(([^)]+)\)\)/.exec(migration)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...checked].sort(), [...api].sort());
});

test("the renderer never receives the person's photo nor the logo file", () => {
  const generation = read("server/src/services/generation.ts");
  const start = generation.slice(
    generation.indexOf("export async function startPosterJob"),
    generation.indexOf("async function persistPoster"),
  );
  assert.doesNotMatch(start, /logo_urls|shareableMediaUrl|mediaUrl\(/);
  // Only an explicitly consented leader photo may ever travel (unchanged).
  assert.match(start, /if \(input\.leaderPhotoUrl\) requestBody\.reference_image_urls/);
  assert.match(generation, /Cette personne \$\{GESTURES\[character\.gesture\]\.scene\}/);
});

test("every poster reads the identity in one place, per post", () => {
  const branding = read("server/src/services/branding.ts");
  assert.match(branding, /if \(row\.include_character \?\? row\.poster_character_enabled\)/);
  assert.match(branding, /row\.poster_logo_enabled && row\.logo_url/);
  assert.match(branding, /row\.brand_colors_enabled/);
  for (const file of ["server/src/routes/generations.ts", "server/src/services/weekly.ts"]) {
    assert.doesNotMatch(read(file), /colors: \[|logoUrl:/, `${file} no longer passes its own branding`);
  }
});

test("settings the profile shows are the settings the poster uses", () => {
  const generation = read("server/src/services/generation.ts");
  assert.match(generation, /Style visuel : \$\{IMAGE_STYLES\[branding\.imageStyle\]\}/);
  assert.match(generation, /PEOPLE\[branding\.peopleType \?\? ""\]/);
  assert.match(generation, /Titres dans le style de la police \$\{branding\.font\}/);
});

test("the logo and the palette are saved in one place, never overwritten by another form", () => {
  const profile = read("src/pages/Profile.tsx");
  const save = profile.slice(profile.indexOf("const handleSave"), profile.indexOf("const handleAutoPublishToggle"));
  assert.doesNotMatch(save, /logo_url|brand_primary_color|brand_font/);
  assert.match(profile, /<BrandKitCard/);
  const dialog = read("src/components/SettingsDialog.tsx");
  assert.doesNotMatch(dialog, /logo_url: /);
  const kit = read("src/components/BrandKitCard.tsx");
  assert.match(kit, /Afficher mon logo sur chaque affiche/);
  assert.match(kit, /Appliquer à chaque affiche/);
});

test("each post can take or leave the character", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.match(dashboard, /Mon personnage sur cette affiche/);
  assert.match(dashboard, /postsApi\.update\(post\.id, \{ include_character: include \}\)/);
  const posts = read("server/src/routes/posts.ts");
  assert.match(posts, /set\("include_character", value\)/);
});

test("migration 0008 is additive", () => {
  const sql = read("server/migrations/0008_brand_kit_and_poses.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bRENAME\b|\bALTER\s+COLUMN\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS poster_character_poses/);
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM poster_character_poses/);
});
