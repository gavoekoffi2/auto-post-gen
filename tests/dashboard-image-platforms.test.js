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

test('dashboard waits out long poster jobs and surfaces clear errors', () => {
  // A slow poster comes back as a job to poll, not as a held-open request.
  assert.match(source, /async function generatePosterImage\(/);
  assert.match(source, /async function awaitPosterJob\(/);
  assert.match(source, /generations\.image\(input\)/);
  assert.match(source, /generations\.status\(jobId\)/);
  // Both flows show the provider's actionable error message.
  assert.match(source, /toast\.error\(res\.error\)/);
  // A failed generation is never dressed up as a successful one: there is no
  // local placeholder or "secours" visual standing in for a real poster.
  assert.equal(source.includes('visuel de secours'), false);
  assert.equal(source.includes('affiche professionnelle de secours'), false);
});

test('resuming an in-flight poster job never starts a second paid generation', () => {
  // The post carries the job id the server persisted on it.
  assert.match(source, /image_status\?: string \| null/);
  assert.match(source, /image_job_id\?: string \| null/);
  // On load, posts still "processing" with a saved job are resumed (bounded).
  assert.match(source, /const resumePendingImage = async \(post: Post\) =>/);
  assert.match(source, /p\.image_status === "processing" && p\.image_job_id/);
  assert.match(source, /void resumePendingImage\(p\)/);
  // Resuming POLLS the existing job. It must not call generations.image(),
  // which is what would start — and bill — a second render.
  const resume = source.match(/const resumePendingImage[\s\S]*?\n  \};/)[0];
  assert.match(resume, /await awaitPosterJob\(post\.image_job_id\)/);
  assert.equal(
    /generations\.image\(/.test(resume),
    false,
    'resuming must poll the existing job, never request a new generation',
  );
});
