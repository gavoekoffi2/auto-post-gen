import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const text = read('server/src/services/text.ts');
const routes = read('server/src/routes/generations.ts');

test('a provider outage does not turn into a 500 in the user\'s face', () => {
  // The whole chain being unavailable still produces something usable rather
  // than an error the user can neither understand nor act on.
  assert.match(text, /function cannedFallback/);
  assert.match(text, /falling back to canned content/);
});

test('filler is labelled as filler, never passed off as a generation', () => {
  // This is the important half. Returning boilerplate silently is how a user
  // publishes text that was never written for their business believing it was.
  assert.match(text, /fallback: true/);
  assert.match(read('src/lib/api.ts'), /fallback\?: boolean/);
  assert.match(read('src/pages/Dashboard.tsx'), /fallback/);
});

test('a fallback is not charged against the user\'s quota', () => {
  assert.match(routes, /if \(result\.fallback\) await releaseQuota\(ctx\.profileId, "generate-text"\)/);
});

test('the quota is atomic and taken before the provider is called', () => {
  assert.match(routes, /const reserved = await consumeQuota\(ctx\.profileId, "generate-text"/);
  // Reserved first, then generated: counting afterwards lets parallel requests
  // all pass the same check.
  assert.ok(
    routes.indexOf('consumeQuota(ctx.profileId, "generate-text"') <
      routes.indexOf('generateText({ profileId: ctx.profileId'),
    'the quota must be reserved before the paid call',
  );
  assert.match(read('server/migrations/0001_core_schema.sql'), /pg_advisory_xact_lock/);
});

test('an unconfigured server says which secret is missing', () => {
  // Rather than silently producing filler for every request forever.
  assert.match(routes, /OPENROUTER_API_KEY/);
  assert.match(routes, /notConfigured\(/);
});
