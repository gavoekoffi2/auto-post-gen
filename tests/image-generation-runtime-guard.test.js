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
  assert.match(dashboard, /IMAGE_GENERATION_TIMEOUT_MS\s*=\s*65000/);
  assert.match(dashboard, /invokeGenerateImageWithTimeout/);
  assert.match(dashboard, /Promise\.race/);
  assert.match(dashboard, /clearTimeout\(timeoutId\)/);
  assert.match(dashboard, /clearGeneratingImage\(savedPost\.id\)/);
  assert.match(dashboard, /clearGeneratingImage\(post\.id\)/);
  assert.match(dashboard, /toast\.dismiss\(loadingToast\)/);
});

test('edge function keeps Graphiste polling below platform/browser timeout and reports elapsed diagnostics', () => {
  assert.match(edge, /GRAPHISTE_TOTAL_TIMEOUT_MS\s*=\s*55_000/);
  assert.match(edge, /GRAPHISTE_POLL_BUDGET_MS\s*=\s*45_000/);
  assert.match(edge, /elapsed_ms/);
  assert.match(edge, /request_id/);
  assert.match(edge, /job_id/);
  assert.doesNotMatch(edge, /110_000/);
  assert.doesNotMatch(edge, /125_000/);
});

test('E2E image script sends the real Supabase bearer token header', () => {
  const tokenExpansion = String.fromCharCode(36) + '{TOKEN}';
  assert.ok(script.includes('Authorization: Bearer ' + tokenExpansion), 'script must pass the access token to the Edge Function');
  assert.doesNotMatch(script, new RegExp('Authorization: Bearer ' + '\\*'.repeat(3)));
});
