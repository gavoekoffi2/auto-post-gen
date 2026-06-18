import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'supabase/functions/generate-image/index.ts'), 'utf8');

test('generate-image uses Graphiste GPT posters, not generic OpenRouter/Gemini image fallback', () => {
  assert.equal(source.includes('generateImageUrl('), false, 'must not call generic image generator');
  assert.equal(source.includes('getOpenRouterKey'), false, 'must not require OpenRouter for image generation');
  assert.equal(/Gemini|gemini|OPENROUTER/.test(source), false, 'must not reference Gemini/OpenRouter in poster function');
  assert.match(source, /provider:\s*usedFallback \? "branded-fallback" : "graphiste-gpt"/);
});

test('Graphiste GPT response extractor accepts common final poster URL shapes', () => {
  for (const field of [
    'poster_url',
    'posterUrl',
    'final_image_url',
    'finalImageUrl',
    'generated_image_url',
    'generatedImageUrl',
    'asset_url',
    'assetUrl',
    'public_url',
    'downloadUrl',
    'secure_url',
    'poster',
    'image',
    'data',
    'outputs',
    'results',
    'base64',
    'b64_json',
  ]) {
    assert.match(source, new RegExp(`obj\\.${field}`), `missing extractor field ${field}`);
  }
});
