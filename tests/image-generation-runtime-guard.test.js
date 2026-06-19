import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboard = readFileSync(join(__dirname, '..', 'src/pages/Dashboard.tsx'), 'utf8');
const edge = readFileSync(join(__dirname, '..', 'supabase/functions/generate-image/index.ts'), 'utf8');
const script = readFileSync(join(__dirname, '..', 'scripts/test-image-gen.sh'), 'utf8');

test('dashboard image generation has a client-side timeout and always clears loading state', () => {
  assert.match(dashboard, /IMAGE_GENERATION_TIMEOUT_MS\s*=\s*260000/);
  assert.match(dashboard, /invokeGenerateImageWithTimeout/);
  assert.match(dashboard, /Promise\.race/);
  assert.match(dashboard, /clearTimeout\(timeoutId\)/);
  assert.match(dashboard, /clearGeneratingImage\(savedPost\.id\)/);
  assert.match(dashboard, /clearGeneratingImage\(post\.id\)/);
  assert.match(dashboard, /toast\.dismiss\(loadingToast\)/);
});

test('edge and dashboard allow slow premium Graphiste poster jobs to run for several minutes', () => {
  assert.match(dashboard, /IMAGE_GENERATION_TIMEOUT_MS\s*=\s*260000/);
  assert.match(edge, /GRAPHISTE_TOTAL_TIMEOUT_MS\s*=\s*240_000/);
  assert.match(edge, /GRAPHISTE_POLL_BUDGET_MS\s*=\s*220_000/);
  assert.match(edge, /elapsed_ms/);
  assert.match(edge, /request_id/);
  assert.match(edge, /job_id/);
  assert.doesNotMatch(edge, /55_000/);
  assert.doesNotMatch(edge, /45_000/);
});

test('E2E image script sends the real Supabase bearer token header', () => {
  const tokenExpansion = String.fromCharCode(36) + '{TOKEN}';
  assert.ok(script.includes('Authorization: Bearer ' + tokenExpansion), 'script must pass the access token to the Edge Function');
  assert.doesNotMatch(script, new RegExp('Authorization: Bearer ' + '\\*'.repeat(3)));
});


test('edge returns a processing state with job_id/status_url instead of losing a slow Graphiste job', () => {
  assert.match(edge, /processing:\s*true/);
  assert.match(edge, /code:\s*"graphiste_processing"/);
  assert.match(edge, /status_url/);
  assert.match(edge, /graphisteJobId/);
  assert.match(edge, /graphisteStatusUrl/);
});

test('dashboard automatically polls an existing Graphiste job without starting a new paid generation', () => {
  assert.match(dashboard, /pollGraphisteJobUntilReady/);
  assert.match(dashboard, /MAX_GRAPHISTE_POLL_ATTEMPTS\s*=\s*8/);
  assert.match(dashboard, /graphisteJobId:\s*current\.job_id/);
  assert.match(dashboard, /graphisteStatusUrl:\s*current\.status_url/);
  assert.match(dashboard, /current\?\.processing/);
});
