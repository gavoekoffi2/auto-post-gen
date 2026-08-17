import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesSharedSecret, timingSafeEqual } from '../supabase/functions/_shared/secret.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const functionsDir = join(__dirname, '..', 'supabase/functions');
const functionDirs = readdirSync(functionsDir)
  .filter((d) => !d.startsWith('_') && existsSync(join(functionsDir, d, 'index.ts')));

// --- Constant-time shared-secret comparison -------------------------------

test('timingSafeEqual matches === semantics without short-circuiting', () => {
  assert.equal(timingSafeEqual('secret', 'secret'), true);
  assert.equal(timingSafeEqual('secret', 'secrey'), false);
  assert.equal(timingSafeEqual('secret', 'secret-longer'), false);
  assert.equal(timingSafeEqual('', ''), true);
  // Multi-byte input must compare by encoded bytes, not by code unit.
  assert.equal(timingSafeEqual('clé-é', 'clé-é'), true);
  assert.equal(timingSafeEqual('clé-é', 'cle-e'), false);
});

test('matchesSharedSecret fails closed on an unset or absent secret', () => {
  assert.equal(matchesSharedSecret(undefined, 'anything'), false);
  assert.equal(matchesSharedSecret('', ''), false, 'an empty CRON_SECRET must never authorise');
  assert.equal(matchesSharedSecret('expected', null), false);
  assert.equal(matchesSharedSecret('expected', 'expected'), true);
});

test('every cron-secret check goes through the constant-time helper', () => {
  for (const d of functionDirs) {
    const src = read(`supabase/functions/${d}/index.ts`);
    if (!src.includes(`Deno.env.get("CRON_SECRET")`)) continue;
    assert.match(
      src,
      /matchesSharedSecret\(/,
      `${d} compares CRON_SECRET and must use matchesSharedSecret`,
    );
    // The short-circuiting comparisons this replaced must not come back.
    assert.equal(
      /provided !== expectedSecret|headerCron === cronSecret/.test(src),
      false,
      `${d} still has a short-circuiting secret comparison`,
    );
  }
});

// --- SSRF-guarded image fetching ------------------------------------------

test('safeFetch re-validates every redirect hop', () => {
  const safeFetch = read('supabase/functions/_shared/safeFetch.ts');
  assert.match(safeFetch, /redirect: "manual"/);
  assert.match(safeFetch, /MAX_REDIRECTS/);
  // Each hop's Location is resolved and re-asserted, not blindly followed.
  assert.match(safeFetch, /assertSafeImageUrl\(new URL\(location, current\)/);
  assert.equal(
    safeFetch.includes('redirect: "follow"'),
    false,
    'following redirects blindly skips the host guard on every hop but the first',
  );
});

test('no image re-host path uses a bare fetch of a user-influenced URL', () => {
  const sources = [
    'supabase/functions/generate-image/index.ts',
    'supabase/functions/publish-post/index.ts',
    'supabase/functions/_shared/graphiste.ts',
    'supabase/functions/_shared/postiz.ts',
  ];
  for (const path of sources) {
    const src = read(path);
    assert.match(src, /fetchImageBytes/, `${path} must fetch images through the SSRF guard`);
    assert.equal(
      /await fetch\(imageUrl\)/.test(src),
      false,
      `${path} still fetches an image URL without the SSRF guard`,
    );
  }
});

// --- Real request-body size enforcement -----------------------------------

test('payload caps are enforced on the stream, not just the content-length header', () => {
  for (const path of [
    'supabase/functions/generate-content/index.ts',
    'supabase/functions/generate-image/index.ts',
    'supabase/functions/detect-audiences/index.ts',
    'supabase/functions/send-contact/index.ts',
  ]) {
    const src = read(path);
    assert.match(src, /readJsonBody(<[^(]*>)?\(\s*req,\s*MAX_PAYLOAD_BYTES\s*\)/, `${path} must read a bounded body`);
    assert.match(src, /PayloadTooLargeError/, `${path} must answer 413 on an oversized body`);
    assert.equal(
      /const contentLength = parseInt\(req\.headers\.get\("content-length"\)/.test(src),
      false,
      `${path} still trusts the optional content-length header as the only cap`,
    );
  }
});

// --- OAuth state expiry ----------------------------------------------------

test('OAuth state without a numeric timestamp is rejected instead of never expiring', () => {
  const oauth = read('supabase/functions/_shared/oauth.ts');
  assert.match(oauth, /Number\.isFinite\(payload\.ts\)/);
  assert.match(oauth, /Invalid state timestamp/);
  assert.equal(
    oauth.includes('if (Date.now() - payload.ts > maxAgeMs)'),
    false,
    'NaN > maxAgeMs is false, so a state with no ts never expired',
  );
});

// --- Input validation ------------------------------------------------------

test('publish-post only accepts a UUID postId', () => {
  const publish = read('supabase/functions/publish-post/index.ts');
  assert.match(publish, /UUID_RE\.test\(rawPostId\)/);
  assert.match(publish, /postId invalide/);
});

test('admin-api validates the role on create_user, not just set_role', () => {
  const adminApi = read('supabase/functions/admin-api/index.ts');
  assert.match(adminApi, /VALID_ROLES/);
  // create_user must reject an unknown role before it reaches app_metadata.
  const createBlock = adminApi.slice(adminApi.indexOf('action === "create_user"'));
  assert.match(createBlock.slice(0, 900), /VALID_ROLES\.has\(role\)/);
});

test('the IP rate-limit bucket cannot be rotated with a forged header', () => {
  const rateLimit = read('supabase/functions/_shared/rateLimit.ts');
  // x-real-ip is written by the gateway; the first x-forwarded-for hop is not.
  assert.match(rateLimit, /x-real-ip/);
  assert.equal(
    /xff\.split\(","\)\[0\]/.test(rateLimit),
    false,
    'the first x-forwarded-for entry is caller-supplied and must not key the bucket',
  );
});

// --- Database-level guards -------------------------------------------------

test('server-owned posts columns are not writable by the browser', () => {
  const migration = read('supabase/migrations/20260817000000_poster_columns_and_rate_limit_fixes.sql');
  assert.match(migration, /REVOKE UPDATE ON public\.posts FROM authenticated/);
  const granted = migration.slice(
    migration.indexOf('GRANT UPDATE ('),
    migration.indexOf('ON public.posts TO authenticated'),
  );
  // The dashboard's own writes must keep working...
  for (const col of ['title', 'content', 'platforms', 'scheduled_for', 'image_url', 'status', 'publish_error']) {
    assert.match(granted, new RegExp(`\\b${col}\\b`), `client column ${col} must stay writable`);
  }
  // ...but the poster job handles and publish bookkeeping must not.
  for (const col of [
    'image_status_url',
    'image_job_id',
    'provider_post_id',
    'validation_token',
    'published_at',
    'user_id',
  ]) {
    assert.equal(
      new RegExp(`\\b${col}\\b`).test(granted),
      false,
      `server-owned column ${col} must not be granted to authenticated`,
    );
  }
});

test('rate-limit GC is scoped to its own bucket', () => {
  const migration = read('supabase/migrations/20260817000000_poster_columns_and_rate_limit_fixes.sql');
  const gc = migration.slice(
    migration.indexOf('Opportunistic GC, scoped to this bucket only.'),
    migration.indexOf('SELECT count(*) INTO used'),
  );
  assert.match(gc, /WHERE bucket = p_bucket/, 'GC must not delete other buckets’ events');
});

test('recover_stuck_publishing counts both recovery branches', () => {
  const migration = read('supabase/migrations/20260817000000_poster_columns_and_rate_limit_fixes.sql');
  assert.match(migration, /RETURN marked_published \+ requeued;/);
});
