import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const generation = read('server/src/services/generation.ts');
const routes = read('server/src/routes/generations.ts');

test('posters come from Graphiste GPT premium only — no generic image provider', () => {
  assert.doesNotMatch(generation, /gemini|Gemini/);
  assert.doesNotMatch(generation, /OPENROUTER|openRouterKey/);
  assert.match(generation, /quality: "premium"/);
  assert.doesNotMatch(generation, /mode: "fast"/);
  assert.doesNotMatch(generation, /quality: "fast"/);
});

test('an unconfigured server says so instead of inventing an image', () => {
  // The old failure mode was a locally drawn SVG placeholder returned as if
  // it were a generated poster. Missing configuration is named instead, so an
  // operator can fix it and the user is not shown a fake.
  assert.match(generation, /GRAPHISTE_GPT_API_KEY/);
  assert.match(generation, /notConfigured\(/);
  assert.doesNotMatch(generation, /<svg/i);
  assert.doesNotMatch(generation, /image\/svg/i);
});

test('an SVG is never accepted as a finished poster, even from the provider', () => {
  const parse = read('server/src/shared/graphisteParse.ts');
  assert.match(parse, /data:image\\\/svg/i);
  assert.match(parse, /Raster image URLs only/);
});

test('the request sends the documented v1.1 contract fields', () => {
  assert.match(generation, /subject: buildSubject\(input, spec, character\?\.position \?\? null\)/);
  assert.match(generation, /title:/);
  assert.match(generation, /aspect_ratio: aspectRatio\(spec\)/);
  assert.match(generation, /resolution: "2K"/);
  assert.match(generation, /mode: "async"/);
  // reliability_mode opts into the premium-first raster fallback; without it
  // one transient renderer timeout leaves every post without media.
  assert.match(generation, /reliability_mode: true/);
  assert.match(generation, /"Idempotency-Key": crypto\.randomUUID\(\)/);
  assert.match(generation, /requestBody\.colors = input\.colors/);
  assert.match(generation, /requestBody\.logo_urls = \[input\.logoUrl\]/);
});

test('a provider error reaches the user as a message they can act on', () => {
  assert.match(generation, /export function graphisteErrorMessage/);
  assert.match(generation, /n'a pas répondu dans le délai imparti/);
  assert.match(generation, /Graphiste GPT inaccessible/);
});

test('the poster is generated for the post the caller actually owns', () => {
  // Looked up by id AND profile id, so a caller cannot spend its own quota
  // rendering a poster onto somebody else's post.
  assert.match(routes, /FROM posts WHERE id = \$1 AND profile_id = \$2/);
  assert.match(routes, /requireTenant\(request, reply\)/);
});
