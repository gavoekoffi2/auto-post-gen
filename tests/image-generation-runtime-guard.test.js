import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime guards for the poster pipeline. Inherited from main's parallel fix
// series (client-side invoke timeout, short edge calls, resumable jobs) and
// re-anchored on the unified implementation after the merge: the edge function
// answers { status: "processing", jobId, statusUrl } and persists the job on
// the post row; the dashboard re-polls it and resumes pending jobs on load.

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboard = readFileSync(join(__dirname, '..', 'src/pages/Dashboard.tsx'), 'utf8');
const edge = readFileSync(join(__dirname, '..', 'supabase/functions/generate-image/index.ts'), 'utf8');
const script = readFileSync(join(__dirname, '..', 'scripts/test-image-gen.sh'), 'utf8');

test('dashboard image generation has a client-side timeout and always clears loading state', () => {
  assert.match(dashboard, /IMAGE_GENERATION_TIMEOUT_MS\s*=\s*90_000/);
  assert.match(dashboard, /invokeGenerateImageWithTimeout/);
  assert.match(dashboard, /Promise\.race/);
  assert.match(dashboard, /clearTimeout\(timeoutId\)/);
  // Spinner cleanup runs in finally blocks so no code path leaves it stuck.
  const finallyCleanups = dashboard.match(/finally \{[^}]*setGeneratingImageIds\(\(prev\) => \{/g) || [];
  assert.ok(finallyCleanups.length >= 2, 'image spinner must be cleared in finally blocks');
  assert.match(dashboard, /toast\.dismiss\(loadingToast\)/);
});

test('a timed-out INITIAL call never races a second paid generation', () => {
  // Resume polls (jobId/statusUrl present) are free to retry; the first call
  // may already have started a paid Graphiste job, so we stop and rely on the
  // job persisted on the post row (resumed on the next dashboard load).
  assert.match(dashboard, /if \(raced === "timeout"\)/);
  assert.match(dashboard, /if \(body\.jobId \|\| body\.statusUrl\) continue;/);
});

test('edge keeps calls short and returns job state for slow premium Graphiste posters', () => {
  // Short bounded polls, well under Supabase's request timeout.
  assert.match(edge, /pollGraphisteJob\(candidates, key, 40_000/);
  assert.match(edge, /resumeGraphisteJob\(resumeJobId, resumeStatusUrl, 45_000\)/);
  // No single long blocking poll (previous designs held 110s+ in one call).
  assert.doesNotMatch(edge, /110_000/);
  assert.doesNotMatch(edge, /360_000/);
  assert.doesNotMatch(edge, /390000/);
});

test('edge returns a processing handoff instead of losing a slow Graphiste job', () => {
  assert.match(edge, /status: "processing", jobId, statusUrl/);
  // and persists the in-flight job so even an abandoned client cannot orphan it.
  assert.match(edge, /image_job_id: jobId, image_status_url: statusUrl, image_status: "processing"/);
});

test('dashboard automatically polls an existing Graphiste job without starting a new paid generation', () => {
  assert.match(dashboard, /jobId: data\.jobId/);
  assert.match(dashboard, /statusUrl: data\.statusUrl/);
  assert.match(dashboard, /data\?\.status === "processing"/);
  // Pending jobs saved on the row are resumed on page load.
  assert.match(dashboard, /const resumePendingImage = async \(post: Post\) =>/);
  assert.match(dashboard, /jobId: post\.image_job_id \|\| undefined/);
});

test('E2E image script sends the real Supabase bearer token header', () => {
  assert.ok(
    script.includes('"Authorization": f"Bearer {token}"'),
    'script must pass the access token to the Edge Function',
  );
  assert.doesNotMatch(script, /Authorization: Bearer \*{3}/);
});
