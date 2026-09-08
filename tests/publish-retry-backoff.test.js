import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const publish = read('supabase/functions/publish-post/index.ts');
const migration = read('supabase/migrations/20260725000000_publish_retry_backoff.sql');
const dashboard = read('src/pages/Dashboard.tsx');

test('a post that cannot publish stops being retried instead of starving the queue', () => {
  // The cron batch is ordered by scheduled_for and capped at 12. A post that
  // reverts to 'validated' with a past scheduled_for is due again instantly
  // and sorts first, so a handful of them (a user who never connected a
  // network — the default state of a new account) permanently occupied every
  // batch and no newer post ever published.
  assert.match(publish, /MAX_PUBLISH_ATTEMPTS/);
  assert.match(publish, /const exhausted = attemptNumber >= MAX_PUBLISH_ATTEMPTS/);
  assert.match(publish, /allErrors \|\| exhausted\s*\n?\s*\?\s*"failed"/);
});

test('the attempt counter is incremented as part of the atomic claim', () => {
  // Incrementing outside the conditional claim would count attempts for posts
  // another worker already took.
  const claim = publish.slice(
    publish.indexOf('const { data: claimed, error: claimError }'),
    publish.indexOf('if (claimError) throw claimError'),
  );
  assert.match(claim, /publish_attempts: attemptNumber/);
  assert.match(claim, /\.eq\("status", "validated"\)/);
});

test('the cron selection uses the backoff-aware RPC with a safe fallback', () => {
  assert.match(publish, /supabase\.rpc\("due_posts_for_publishing"/);
  assert.match(publish, /p_max_attempts: MAX_PUBLISH_ATTEMPTS/);
  // If the migration has not landed yet the publisher must still run.
  assert.match(publish, /using fallback query/);
  // The fallback must not resurrect unscheduled posts.
  assert.match(publish, /\.not\("scheduled_for", "is", null\)/);
});

test('the SQL give-up threshold matches the function constant', () => {
  const sqlDefault = migration.match(/p_max_attempts integer DEFAULT (\d+)/);
  const tsMax = publish.match(/const MAX_PUBLISH_ATTEMPTS = (\d+)/);
  assert.ok(sqlDefault && tsMax);
  assert.equal(
    Number(sqlDefault[1]),
    Number(tsMax[1]),
    'a mismatch would either loop forever or give up early',
  );
});

test('the backoff is bounded and grows', () => {
  // 15, 30, 60, 120, then capped at 240 minutes.
  assert.match(migration, /LEAST\(240, 15 \* \(2 \^ LEAST\(p\.publish_attempts - 1, 4\)\)::integer\)/);
  // Posts at or over the threshold must not be returned at all.
  assert.match(migration, /p\.publish_attempts < p_max_attempts/);
  // Unscheduled posts must never be auto-published.
  assert.match(migration, /p\.scheduled_for IS NOT NULL/);
});

test('an explicit user retry resets the counter', () => {
  // Otherwise "Réessayer" would appear to work but the publisher would keep
  // skipping the post as exhausted.
  const retry = dashboard.slice(
    dashboard.indexOf('const handleRetry ='),
    dashboard.indexOf('const handleEdit ='),
  );
  assert.match(retry, /publish_attempts: 0/);
  assert.match(retry, /status: 'validated'/);
});

test('a failed publish always records why', () => {
  // publish_error used to be cleared whenever the status was not one of a
  // narrow set, hiding per-platform failures from the dashboard.
  assert.match(publish, /publish_error: anyOk && !anyPending \? null : JSON\.stringify\(results\)/);
});

test('the migration is idempotent and ships in the deploy pipeline', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS publish_attempts/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION/);
  assert.match(
    read('.github/workflows/deploy-functions.yml'),
    /20260725000000_publish_retry_backoff\.sql/,
    'the deploy workflow must apply the retry-backoff migration',
  );
});
