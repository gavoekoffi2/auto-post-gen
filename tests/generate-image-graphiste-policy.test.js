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
  assert.match(source, /ALLOW_BRANDED_IMAGE_FALLBACK/);
  assert.match(source, /quality:\s*"premium"/);
  assert.equal(source.includes('mode: "fast"'), false, 'must not use fast mode because it routes to the quick model');
  assert.equal(source.includes('quality: "fast"'), false, 'must not use fast quality because it routes to the quick model');
  assert.equal(source.includes('mode: "quality"'), false, 'do not use the old unsupported mode field for premium generation');
  assert.equal(source.includes('aspectRatio'), false, 'do not send unsupported aspectRatio to Graphiste API');
  assert.equal(source.includes('resolution'), false, 'do not send unsupported resolution to Graphiste API');
  assert.match(source, /prompt,\n\s*usageType: "social"/);
  assert.match(source, /Ne pas générer une image vide/);
  assert.match(source, /titre principal lisible/);
  assert.match(source, /graphisteDomain\(params\.sector, params\.description, params\.postContent\)/);
  assert.match(source, /postContent = ""/);
  assert.equal(source.includes('return "service";'), false, 'broken Graphiste service references must not be the default');
  assert.match(source, /return "formation";/);
  assert.match(source, /pas comme contrainte stricte/);
  assert.match(source, /créer librement une affiche adaptée au message/);
  assert.match(source, /pollGraphisteGptJob/);
  assert.match(source, /extractGraphisteJobId/);
  assert.match(source, /statusUrl/);
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
