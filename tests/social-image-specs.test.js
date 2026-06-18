import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Behavioural tests run against the real frontend module (Node strips the TS
// types at import time). The edge function ships a byte-identical copy, so the
// dimensions proven here also hold inside the Supabase function.
import { getSocialImageSpec, normalizePlatform } from '../src/lib/socialImageSpecs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendPath = join(__dirname, '..', 'src/lib/socialImageSpecs.ts');
const edgePath = join(__dirname, '..', 'supabase/functions/_shared/socialImageSpecs.ts');

test('the frontend and edge copies of the spec module stay identical', () => {
  const frontend = readFileSync(frontendPath, 'utf8');
  const edge = readFileSync(edgePath, 'utf8');
  assert.equal(frontend, edge, 'src/lib/socialImageSpecs.ts must equal the _shared copy');
});

test('single LinkedIn post gets a LinkedIn landscape format', () => {
  const s = getSocialImageSpec(['LinkedIn']);
  assert.equal(s.width, 1200);
  assert.equal(s.height, 627);
  assert.equal(s.orientation, 'landscape');
  assert.equal(s.label, 'LinkedIn');
});

test('TikTok / Shorts / Story / Reels all produce a 1080x1920 vertical canvas', () => {
  for (const p of ['TikTok', 'YouTube Shorts', 'Shorts', 'Instagram Story', 'Reels']) {
    const s = getSocialImageSpec([p]);
    assert.equal(s.width, 1080, `${p} width`);
    assert.equal(s.height, 1920, `${p} height`);
    assert.equal(s.orientation, 'story', `${p} orientation`);
    assert.equal(s.aspectRatio, '9:16', `${p} ratio`);
  }
});

test('single Instagram feed post is portrait 1080x1350', () => {
  const s = getSocialImageSpec(['Instagram']);
  assert.equal(s.width, 1080);
  assert.equal(s.height, 1350);
  assert.equal(s.orientation, 'portrait');
});

test('single Facebook and X posts get their native landscape formats', () => {
  const fb = getSocialImageSpec(['Facebook']);
  assert.deepEqual([fb.width, fb.height], [1200, 630]);
  const x = getSocialImageSpec(['Twitter']);
  assert.deepEqual([x.width, x.height], [1200, 675]);
});

test('priority 1: any vertical platform wins over feed platforms', () => {
  const s = getSocialImageSpec(['LinkedIn', 'Instagram', 'TikTok']);
  assert.deepEqual([s.width, s.height], [1080, 1920]);
  assert.equal(s.orientation, 'story');
});

test('priority 3: only landscape-pro platforms share a 1200x627 landscape', () => {
  const s = getSocialImageSpec(['LinkedIn', 'Facebook', 'Twitter']);
  assert.deepEqual([s.width, s.height], [1200, 627]);
  assert.equal(s.orientation, 'landscape');
});

test('priority 4: Instagram feed mixed with a pro feed falls back to a 1080x1080 square', () => {
  const s = getSocialImageSpec(['LinkedIn', 'Instagram']);
  assert.deepEqual([s.width, s.height], [1080, 1080]);
  assert.equal(s.orientation, 'square');
});

test('empty / unknown platforms fall back to a safe universal square', () => {
  for (const input of [[], ['totally-unknown'], null, undefined]) {
    const s = getSocialImageSpec(input);
    assert.deepEqual([s.width, s.height], [1080, 1080], `input ${JSON.stringify(input)}`);
  }
});

test('duplicate / mixed-case platforms are de-duplicated to one native format', () => {
  const s = getSocialImageSpec(['Instagram', 'instagram', 'INSTAGRAM']);
  assert.deepEqual([s.width, s.height], [1080, 1350]);
  assert.deepEqual(s.platforms, ['instagram']);
});

test('normalizePlatform maps the common aliases', () => {
  assert.equal(normalizePlatform('IG'), 'instagram');
  assert.equal(normalizePlatform('insta'), 'instagram');
  assert.equal(normalizePlatform('FB'), 'facebook');
  assert.equal(normalizePlatform('X'), 'x');
  assert.equal(normalizePlatform('twitter'), 'x');
  assert.equal(normalizePlatform('YouTube Shorts'), 'youtube-shorts');
  assert.equal(normalizePlatform('Instagram Reels'), 'instagram-reels');
  assert.equal(normalizePlatform('Instagram Story'), 'instagram-story');
  assert.equal(normalizePlatform('LinkedIn'), 'linkedin');
  assert.equal(normalizePlatform('Tik Tok'), 'tiktok');
  assert.equal(normalizePlatform('something else'), '');
});

test('every spec exposes the fields the renderer and UI rely on', () => {
  const s = getSocialImageSpec(['TikTok']);
  for (const key of ['width', 'height', 'aspectRatio', 'label', 'orientation', 'platforms']) {
    assert.ok(key in s, `missing field ${key}`);
  }
  assert.ok(Array.isArray(s.platforms));
});
