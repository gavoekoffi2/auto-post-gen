import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(__dirname, '..', 'supabase/functions/generate-image/index.ts'),
  'utf8',
);

test('generate-image derives the output format from the post platforms', () => {
  assert.match(source, /from "\.\.\/_shared\/socialImageSpecs\.ts"/);
  assert.match(source, /const spec = getSocialImageSpec\(platforms\)/);
  // platforms come from the request body, or from the post row as a fallback.
  assert.ok(source.includes('Array.isArray(body?.platforms)'), 'reads platforms from body');
  assert.ok(source.includes('.select("platforms")'), 'reads platforms from the post row');
  // the chosen format is returned to the caller so the UI can label it.
  assert.ok(source.includes('format: {'), 'returns the chosen format');
  assert.ok(source.includes('width: spec.width'));
  assert.ok(source.includes('height: spec.height'));
});

test('the fallback poster renderer is premium and dimension-aware', () => {
  assert.match(source, /function posterLayout\(spec: SocialImageSpec\)/);
  assert.ok(source.includes('const W = spec.width;'));
  assert.ok(source.includes('const H = spec.height;'));
  // viewBox follows the spec dimensions, not a hard-coded square/16:9 canvas.
  assert.ok(source.includes('viewBox="0 0 ${W} ${H}"'), 'viewBox uses spec dimensions');
  assert.ok(source.includes('width="${W}" height="${H}"'), 'svg sized to the spec');
  // real composition: gradient, badges, eyebrow, headline, accent rule, CTA.
  assert.match(source, /linearGradient id="bg"/);
  assert.match(source, /formatBadge/);
  assert.match(source, /titleNodes/);
  assert.match(source, /ctaTop/);
});

test('every clamped font size stays readable (no tiny illegible text)', () => {
  const mins = [...source.matchAll(/px\(0\.\d+,\s*(\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(mins.length >= 8, 'layout defines clamped sizes for each orientation');
  assert.ok(
    mins.every((n) => n >= 20),
    `all font minimums must be >= 20px, got ${mins.join(', ')}`,
  );
  // body copy is word-capped so it never collapses into a wall of small text.
  assert.ok(source.includes('L.bodyWords'), 'body text is word-capped');
  assert.match(source, /bodyWords:/);
});

test('the AI prompt demands a premium, correctly-formatted poster', () => {
  // format is communicated in natural language (not unsupported API params).
  assert.ok(source.includes('FORMAT CIBLE'), 'prompt states the target format');
  assert.ok(source.includes('${spec.width}×${spec.height}'), 'prompt embeds the dimensions');
  assert.ok(source.includes('Aucun petit texte illisible'), 'prompt forbids tiny text (FR)');
  assert.ok(
    source.includes('no tiny unreadable text, no random letters, no watermark, no UI elements'),
    'prompt forbids tiny/garbage text (EN direction)',
  );
  assert.ok(source.includes('éclairage cinématographique'));
  assert.ok(source.includes('cinematic lighting'));
});

test('unsupported sizing params are still never sent to the Graphiste API', () => {
  // The spec object carries an aspectRatio field, but this function must keep
  // using width/height/orientation and never leak those keys to the API.
  assert.equal(source.includes('aspectRatio'), false);
  assert.equal(source.includes('resolution'), false);
  assert.match(source, /quality:\s*"premium"/);
});
