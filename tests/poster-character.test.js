import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The poster character (a person or mascot cut out once and laid onto every
// poster). Behaviour is tested in server/tests/character.test.ts against the
// real model and Postgres; these pin the design decisions around it.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the character's photo never travels to the poster provider", () => {
  const generation = read("server/src/services/generation.ts");
  const start = generation.slice(
    generation.indexOf("export async function startPosterJob"),
    generation.indexOf("async function persistPoster"),
  );
  // Only the layout (side, gesture) reaches the prompt; the photo stays local
  // and is composited onto the finished render. A photo handed to the
  // renderer as a "reference" came back as somebody else's face.
  assert.match(start, /buildSubject\(input, spec, branding\)/);
  assert.doesNotMatch(start, /character\.assetId|mediaUrl\(|publicMediaUrl|shareableMediaUrl/);
  assert.doesNotMatch(start, /reference_image_urls = \[.*character/);
  assert.match(generation, /composePoster\(/);
});

test("the render is finished with the character it was started with", () => {
  const migration = read("server/migrations/0007_poster_character.sql");
  const generation = read("server/src/services/generation.ts");
  assert.match(migration, /generation_jobs ADD COLUMN IF NOT EXISTS character_overlay jsonb/);
  assert.match(generation, /asCharacterOverlay\(job\.character_overlay\)/);
  assert.match(generation, /asLogoOverlay\(job\.logo_overlay\)/);
});

test("migration 0006 is additive", () => {
  const migration = read("server/migrations/0007_poster_character.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(migration, /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bRENAME\b/i);
  assert.match(migration, /ON DELETE SET NULL/);
});

test("the segmentation model is pinned to a checksum, never trusted as downloaded", () => {
  const script = read("server/scripts/fetch-bg-model.mjs");
  assert.match(script, /MODEL_SHA256 = "[0-9a-f]{64}"/);
  assert.match(script, /checksum mismatch/);
  const dockerfile = read("server/Dockerfile");
  assert.match(dockerfile, /fetch-bg-model\.mjs/);
  assert.match(read("server/.gitignore"), /^models\/?$/m);
});

test("uploading a person's image requires a recorded rights confirmation", () => {
  const route = read("server/src/routes/character.ts");
  assert.match(route, /"rights_required"/);
  assert.match(route, /poster_character_rights_at = now\(\)/);
  const card = read("src/components/PosterCharacterCard.tsx");
  assert.match(card, /const canPick = !uploading && rights && !full;/);
  assert.match(card, /disabled=\{!canPick\}/);
});

test("nginx lets a character photo through, and the rate limit is answered after the body", () => {
  const nginx = read("nginx.vps.conf");
  const block = nginx.slice(nginx.indexOf("location = /api/profile/poster-character"));
  const size = Number(/client_max_body_size (\d+)m;/.exec(block)?.[1]);
  // CHARACTER_UPLOAD_MAX_BYTES is 12 MB; nginx must accept that plus the envelope.
  assert.ok(size > 12, `client_max_body_size ${size}m must exceed the 12 MB route ceiling`);
  assert.match(block, /proxy_pass http:\/\/api:8080;/);

  const route = read("server/src/routes/character.ts");
  assert.ok(
    route.indexOf("hitRateLimit(") > route.indexOf("request.parts("),
    "answering before the upload is read makes nginx return 502 instead of the message",
  );
});

test("an HTML error page from the proxy never reaches the user verbatim", () => {
  const api = read("src/lib/api.ts");
  assert.match(api, /!\/\^\\s\*<\/\.test\(fallbackText\)/);
  assert.match(api, /status === 502 \|\| status === 503 \|\| status === 504/);
});

test("a failed page chunk shows a way out instead of a blank page", () => {
  const app = read("src/App.tsx");
  assert.match(app, /<AppErrorBoundary>\s*<Suspense/);
  const boundary = read("src/components/AppErrorBoundary.tsx");
  assert.match(boundary, /Failed to fetch dynamically imported module/);
  // Reloads at most once a minute: a broken deployment must not loop.
  assert.match(boundary, /reloadedRecently\(\)/);
});

test("the post text cannot inject replacement patterns into the poster prompt", () => {
  const generation = read("server/src/services/generation.ts");
  assert.match(generation, /lines\.replace\(MESSAGE_MARKER, \(\) => clipped\)/);
});
