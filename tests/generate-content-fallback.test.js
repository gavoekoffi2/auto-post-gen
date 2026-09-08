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

// --- The dashboard must not present a fallback post as a real generation ---
const dashboard = readFileSync(
  join(__dirname, '..', 'src/pages/Dashboard.tsx'),
  'utf8',
);

test('the dashboard tells the truth when generate-content returned canned filler', () => {
  // generate-content answers HTTP 200 with { fallback: true } when the AI
  // provider is down. The dashboard used to show a plain success toast, so
  // the user believed the AI had written their post.
  assert.match(dashboard, /const isFallback = data\.fallback === true/);
  assert.match(dashboard, /Texte de secours/);
  assert.match(dashboard, /toast\.warning\(/);
});

test('a fallback post never triggers a paid poster generation', () => {
  // Each poster is a paid premium 2K render. Spending one on filler text the
  // user is about to regenerate is pure waste, so both generation paths must
  // bail out before kicking the image job.
  const generateBlock = dashboard.slice(
    dashboard.indexOf('const handleGenerate ='),
    dashboard.indexOf('const handleRegenerateImage ='),
  );
  const fallbackIdx = generateBlock.indexOf('if (isFallback)');
  const imageKickIdx = generateBlock.indexOf('setGeneratingImageIds((prev) => new Set(prev).add(savedPost.id))');
  assert.ok(fallbackIdx > 0, 'handleGenerate must check the fallback flag');
  assert.ok(imageKickIdx > 0, 'handleGenerate must kick the poster job');
  assert.ok(
    fallbackIdx < imageKickIdx,
    'the fallback bail-out must come BEFORE the paid poster job is started',
  );

  const regenBlock = dashboard.slice(
    dashboard.indexOf('const handleRegenerateContent ='),
    dashboard.indexOf('const handlePreview ='),
  );
  assert.ok(
    regenBlock.indexOf('if (isFallback)') < regenBlock.indexOf('await handleRegenerateImage(updatedPost)'),
    'regeneration must bail out before chaining a poster onto filler text',
  );
});

test('the dashboard does not claim web research it did not do', () => {
  // The toast used to hardcode "enrichi par recherche web" even when
  // researchInspiration returned nothing.
  assert.match(dashboard, /data\.usedWebInspiration/);
});

test('regenerating the text clears the whole stale poster job, not just the URL', () => {
  const regenBlock = dashboard.slice(
    dashboard.indexOf('const handleRegenerateContent ='),
    dashboard.indexOf('const handlePreview ='),
  );
  for (const column of ['image_url: null', 'image_status: null', 'image_job_id: null', 'image_status_url: null']) {
    assert.ok(
      regenBlock.includes(column),
      `regeneration must reset ${column} so an in-flight poster is not re-attached to new text`,
    );
  }
});
