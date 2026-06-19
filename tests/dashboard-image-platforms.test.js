import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'src/pages/Dashboard.tsx'), 'utf8');

test('dashboard passes the post platforms to generate-image so the format matches', () => {
  assert.match(source, /from "@\/lib\/socialImageSpecs"/);
  // both the initial generation and the regenerate action forward platforms.
  assert.ok(source.includes('platforms: defaultPlatforms,'), 'initial generation sends platforms');
  assert.ok(source.includes('platforms: regenPlatforms,'), 'regenerate sends platforms');
  assert.match(source, /const regenPlatforms = post\.platforms \|\| /);
});

test('dashboard tells the user which format was produced', () => {
  assert.match(source, /getSocialImageSpec\(defaultPlatforms\)/);
  assert.match(source, /getSocialImageSpec\(regenPlatforms\)/);
  assert.ok(source.includes('${imageSpec.label}, ${imageSpec.aspectRatio}'));
});

test('dashboard resumes long poster jobs and surfaces clear errors', () => {
  // resumable helper that re-calls generate-image with the returned job id.
  assert.match(source, /async function generatePosterImage\(/);
  assert.match(source, /data\?\.status === "processing"/);
  assert.match(source, /jobId: data\.jobId/);
  assert.match(source, /statusUrl: data\.statusUrl/);
  // both flows use the helper and show the actionable error message.
  assert.match(source, /toast\.error\(res\.error\)/);
  // and never claim a "secours"/SVG fallback success anymore.
  assert.equal(source.includes('visuel de secours'), false);
  assert.equal(source.includes('affiche professionnelle de secours'), false);
});
