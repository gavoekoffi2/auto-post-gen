import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// --- Migrations actually reach production ---------------------------------

test('the deploy workflow applies migrations by ledger, not by hardcoded name', () => {
  const deploy = read('.github/workflows/deploy-functions.yml');
  assert.match(deploy, /node scripts\/apply-migrations\.mjs/);
  // The previous shape named individual files, so every new migration had to
  // be added by hand — and any that was forgotten silently never ran.
  assert.equal(
    /supabase\/migrations\/\d+_[a-z0-9_-]+\.sql/.test(deploy),
    false,
    'no migration may be referenced by filename in the workflow',
  );
});

test('every migration on disk is either baselined or scheduled to be applied', () => {
  const runner = read('scripts/apply-migrations.mjs');
  const checker = read('scripts/check-migrations.mjs');
  const baseline = runner.match(/DEFAULT_BASELINE = '(\d+)'/)?.[1];
  const checkerBaseline = checker.match(/BASELINE = '(\d+)'/)?.[1];
  assert.ok(baseline, 'runner must declare a baseline');
  assert.equal(
    checkerBaseline,
    baseline,
    'the validator and the runner must agree on the baseline, or CI validates a different plan than the deploy runs',
  );

  const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
  const versions = files.map((f) => f.match(/^(\d+)/)[1]);
  // Nothing may be lost between the two buckets.
  const baselined = versions.filter((v) => v <= baseline);
  const pending = versions.filter((v) => v > baseline);
  assert.equal(baselined.length + pending.length, versions.length);
  assert.ok(pending.length > 0, 'the fixes added in this work must be in the pending set');
});

test('the migration validator rejects a malformed filename', () => {
  const out = execFileSync('node', [join(root, 'scripts/check-migrations.mjs')], {
    encoding: 'utf8',
  });
  assert.match(out, /migration\(s\) valid/);
});

test('migration versions are unique', () => {
  const versions = readdirSync(join(root, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.match(/^(\d+)/)[1]);
  assert.equal(new Set(versions).size, versions.length, 'duplicate version would skip a migration');
});

// --- CI actually gates what it claims to --------------------------------

test('CI type-checks both the frontend and the edge functions', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run typecheck/, 'frontend types must be gated');
  assert.match(ci, /deno check/, 'edge functions are Deno and tsc never sees them');
  assert.match(ci, /npm audit/, 'dependency advisories must be surfaced');
  assert.match(ci, /check-migrations\.mjs/, 'migration plan must be validated on PRs');
});

test('the Node version is pinned in one place', () => {
  const nvmrc = read('.nvmrc').trim();
  assert.match(nvmrc, /^\d+$/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.engines?.node, 'package.json must declare the supported Node range');
  for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/deploy-functions.yml']) {
    const src = read(workflow);
    if (!src.includes('setup-node')) continue;
    assert.match(
      src,
      /node-version-file: \.nvmrc/,
      `${workflow} must read the pinned version rather than restating it`,
    );
  }
});

// --- Operational safety nets --------------------------------------------

test('housekeeping runs on a schedule instead of growing forever', () => {
  const migration = read('supabase/migrations/20260817000200_retention_and_indexes.sql');
  assert.match(migration, /gc_generation_usage/);
  assert.match(migration, /run_maintenance/);
  // ...and something actually calls it.
  const publish = read('supabase/functions/publish-post/index.ts');
  assert.match(publish, /rpc\("run_maintenance"\)/);
});

test('the quota ledger has an index matching how it is queried', () => {
  const migration = read('supabase/migrations/20260817000200_retention_and_indexes.sql');
  // consume_generation_quota filters on (user_id, function_name, created_at).
  assert.match(migration, /idx_generation_usage_user_function_created[\s\S]*user_id, function_name, created_at/);
});

test('every rate-limited function is counted under its own quota name', () => {
  const functionsDir = join(root, 'supabase/functions');
  const dirs = readdirSync(functionsDir)
    .filter((d) => !d.startsWith('_') && existsSync(join(functionsDir, d, 'index.ts')));
  const quotaNames = new Set();
  for (const d of dirs) {
    const src = read(`supabase/functions/${d}/index.ts`);
    for (const m of src.matchAll(/consumeQuota\([^)]*?"([a-z-]+)"/gs)) quotaNames.add(m[1]);
    for (const m of src.matchAll(/p_function: "([a-z-]+)"/g)) quotaNames.add(m[1]);
  }
  // The endpoints that spend money or scan tables must all be represented.
  for (const expected of ['generate-content', 'generate-image', 'comment-reply', 'sync-comments', 'admin-api']) {
    assert.ok(quotaNames.has(expected), `${expected} must consume a quota`);
  }
});

test('admin stats count content generations, not every quota row', () => {
  // consume_generation_quota writes to generation_usage for EVERY rate-limited
  // function, so an unfiltered count would report quota rows as "AI generations".
  const adminApi = read('supabase/functions/admin-api/index.ts');
  assert.match(adminApi, /CONTENT_GENERATION_FUNCTIONS/);
  assert.match(adminApi, /\.in\("function_name", CONTENT_GENERATION_FUNCTIONS\)/);
});

// --- Frontend resilience --------------------------------------------------

test('the app is wrapped in an error boundary', () => {
  const app = read('src/App.tsx');
  assert.match(app, /<ErrorBoundary>/);
  const boundary = read('src/components/ErrorBoundary.tsx');
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
});

// --- Public surface -------------------------------------------------------

test('authenticated routes are excluded from crawling', () => {
  const robots = read('public/robots.txt');
  for (const path of ['/dashboard', '/admin', '/profile', '/validate-post']) {
    assert.match(robots, new RegExp(`Disallow: ${path}`), `${path} must not be indexed`);
  }
  assert.match(robots, /Sitemap: https:\/\//);
  const sitemap = read('public/sitemap.xml');
  assert.match(sitemap, /<urlset/);
  // Only public marketing pages belong in the sitemap.
  for (const path of ['/dashboard', '/admin', '/profile']) {
    assert.equal(sitemap.includes(`${path}<`), false, `${path} must not be advertised`);
  }
});

test('the repository documents how to report a vulnerability', () => {
  const security = read('SECURITY.md');
  assert.match(security, /issue publique/i, 'must tell reporters not to file publicly');
  assert.match(security, /72 heures/, 'must state an acknowledgement window');
  assert.match(security, /RLS/);
});
