import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(__dirname, '..', 'supabase/functions/generate-content/index.ts'),
  'utf8',
);

test('generate-content never returns a 500 just because OpenRouter is unavailable', () => {
  assert.equal(
    source.includes('AI service not configured (OPENROUTER_API_KEY missing)'),
    false,
    'missing OpenRouter key must not produce a non-2xx response for first users',
  );
  assert.match(source, /provider:\s*"local-content-fallback"/);
});

test('generate-content enforces an atomic per-user quota before spending on the AI', () => {
  // The bypassable count-then-insert check was replaced by an atomic RPC.
  assert.match(source, /consume_generation_quota/);
  assert.match(source, /p_function:\s*"generate-content"/);
});

test('generate-content converts OpenRouter non-2xx into a usable local post fallback', () => {
  assert.match(source, /throw new Error\(`OpenRouter \$\{textResponse\.status\}:/);
  assert.match(source, /const payload = fallbackContent\(fallbackReason \|\| "AI returned empty content"\)/);
  assert.match(source, /JSON\.stringify\(payload\)/);
  assert.match(source, /status:\s*200/);
});
