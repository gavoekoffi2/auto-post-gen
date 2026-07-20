import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const weekly = read('supabase/functions/auto-generate-weekly/index.ts');
const publish = read('supabase/functions/publish-post/index.ts');
const graphiste = read('supabase/functions/_shared/graphiste.ts');

test('auto-generate-weekly attaches a custom-library image when the profile has one', () => {
  assert.match(weekly, /profile\.use_custom_images/);
  assert.match(weekly, /profile\.custom_image_urls/);
  // The post is inserted with the chosen image and its id is read back.
  assert.match(weekly, /image_url: customImage/);
  assert.match(weekly, /\.select\("id"\)/);
  assert.match(weekly, /\.single\(\)/);
});

test('auto-generate-weekly kicks an async Graphiste GPT poster job when there is no custom image', () => {
  assert.match(weekly, /from "\.\.\/_shared\/graphiste\.ts"/);
  assert.match(weekly, /startPosterJob\(/);
  assert.match(weekly, /GRAPHISTE_GPT_API_KEY/);
  // Pending jobs are persisted so publish-post can resume them later.
  assert.match(weekly, /image_job_id: poster\.jobId/);
  assert.match(weekly, /image_status: "processing"/);
  // A fast poster is re-hosted to our own bucket for a stable URL.
  assert.match(weekly, /rehostToUserAssets\(/);
});

test('publish-post resumes a pending poster job and attaches it before publishing', () => {
  assert.match(publish, /from "\.\.\/_shared\/graphiste\.ts"/);
  assert.match(publish, /resumePosterJob\(/);
  assert.match(publish, /!post\.image_url &&\s+post\.image_job_id/);
  assert.match(publish, /image_status: "done"/);
  assert.match(publish, /image_status: "failed"/);
});

test('shared Graphiste client honours the documented v1.1 async contract', () => {
  assert.match(graphiste, /export async function startPosterJob/);
  assert.match(graphiste, /export async function resumePosterJob/);
  assert.match(graphiste, /export async function rehostToUserAssets/);
  assert.match(graphiste, /mode: "async"/);
  assert.match(graphiste, /quality: "premium"/);
  assert.match(graphiste, /reliability_mode: true/);
  assert.match(graphiste, /"Idempotency-Key": crypto\.randomUUID\(\)/);
  // Never persist an SVG/placeholder as a real poster.
  assert.match(graphiste, /refusing SVG data URL/);
  assert.match(graphiste, /user-assets/);
});

test('shared Graphiste client uses the single shared response parser (no duplicated job-id logic)', () => {
  // job-id / status-url / failure parsing lives in one tested module so the
  // request_id-vs-job_id fix cannot drift between the cron and interactive paths.
  assert.match(graphiste, /from "\.\/graphisteParse\.ts"/);
  assert.match(graphiste, /extractJobId/);
  assert.match(graphiste, /extractStatusUrl/);
  // the buggy local getter that accepted request_id must be gone from here.
  assert.doesNotMatch(graphiste, /o\.request_id \|\| o\.requestId/);
});
