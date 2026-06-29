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

test('dashboard resumes in-flight poster jobs persisted on the row, on page load', () => {
  // The Post type carries the persisted job fields read back from the row.
  assert.match(source, /image_status\?: string \| null/);
  assert.match(source, /image_job_id\?: string \| null/);
  assert.match(source, /image_status_url\?: string \| null/);
  // On load, posts still "processing" with a saved job are resumed (bounded).
  assert.match(source, /const resumePendingImage = async \(post: Post\) =>/);
  assert.match(source, /p\.image_status === "processing" && \(p\.image_job_id \|\| p\.image_status_url\)/);
  assert.match(source, /void resumePendingImage\(p\)/);
  // resume forwards the saved job id / status url so no new (paid) job starts.
  assert.match(source, /jobId: post\.image_job_id \|\| undefined/);
  assert.match(source, /statusUrl: post\.image_status_url \|\| undefined/);
});
