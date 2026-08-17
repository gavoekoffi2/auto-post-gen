import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Behavioural tests for the poll-target guard. Every Graphiste status poll is
// sent with `Authorization: Bearer GRAPHISTE_GPT_API_KEY`, and both inputs that
// reach it are attacker-controlled:
//   * generate-image reads jobId/statusUrl from the request body;
//   * publish-post reads them from posts.image_job_id / posts.image_status_url,
//     columns the row owner could write through PostgREST.
// An unvalidated target therefore leaked the API key to any host the caller
// named (and was an SSRF from the service-role runtime).
import {
  graphisteStatusCandidates,
  isAllowedGraphisteStatusUrl,
  sanitizeJobId,
} from '../supabase/functions/_shared/graphisteParse.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const ENDPOINT =
  'https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate';

test('a status URL on the Graphiste origin is accepted', () => {
  assert.equal(
    isAllowedGraphisteStatusUrl(
      'https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/job-1',
      ENDPOINT,
    ),
    true,
  );
  // Relative status URLs resolve against the endpoint and stay on-origin.
  assert.equal(isAllowedGraphisteStatusUrl('/functions/v1/api-v1/v1/posters/job-1', ENDPOINT), true);
});

test('a status URL pointing anywhere else is rejected', () => {
  for (const hostile of [
    'https://attacker.example/collect',            // key exfiltration
    'https://bbfzfgcdioewzbmlgaqy.supabase.co.evil.example/x', // suffix look-alike
    'http://bbfzfgcdioewzbmlgaqy.supabase.co/x',   // downgraded to cleartext
    'http://169.254.169.254/latest/meta-data/',    // cloud metadata (SSRF)
    'http://127.0.0.1:8000/',
    'file:///etc/passwd',
  ]) {
    assert.equal(
      isAllowedGraphisteStatusUrl(hostile, ENDPOINT),
      false,
      `${hostile} must not be polled with the Graphiste API key`,
    );
  }
});

test('graphisteStatusCandidates drops an off-origin status URL but keeps job routes', () => {
  const candidates = graphisteStatusCandidates(ENDPOINT, 'https://attacker.example/steal', 'job-9');
  assert.ok(candidates.length > 0, 'canonical job routes still derived from the endpoint');
  for (const url of candidates) {
    assert.equal(
      new URL(url).origin,
      new URL(ENDPOINT).origin,
      `candidate ${url} escaped the Graphiste origin`,
    );
  }
  assert.equal(candidates.some((u) => u.includes('attacker.example')), false);
});

test('graphisteStatusCandidates keeps a legitimate same-origin status URL', () => {
  const statusUrl =
    'https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/status/job-9';
  const candidates = graphisteStatusCandidates(ENDPOINT, statusUrl, 'job-9');
  assert.ok(candidates.includes(statusUrl));
});

test('a job id alone can never redirect the poll off-origin', () => {
  // No job id and no usable status URL → nothing to poll at all.
  assert.deepEqual(graphisteStatusCandidates(ENDPOINT, 'https://attacker.example/', null), []);
  // A URL-shaped job id is rejected outright rather than concatenated.
  assert.equal(sanitizeJobId('https://attacker.example/'), null);
  assert.equal(sanitizeJobId('../../../../admin'), null);
  assert.equal(sanitizeJobId('..'), null);
  assert.equal(sanitizeJobId('job with spaces'), null);
  assert.equal(sanitizeJobId(''), null);
  assert.equal(sanitizeJobId(null), null);
  assert.equal(sanitizeJobId(42), null);
  // Real ids survive.
  assert.equal(sanitizeJobId(' job-REAL-123 '), 'job-REAL-123');
  assert.equal(sanitizeJobId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
});

test('a traversal job id cannot walk out of the posters route', () => {
  const candidates = graphisteStatusCandidates(ENDPOINT, null, '../../secrets');
  assert.deepEqual(candidates, [], 'a traversal job id yields no poll target');
});

test('both poller call sites use the shared guarded candidate builder', () => {
  const genImage = read('supabase/functions/generate-image/index.ts');
  const sharedGraphiste = read('supabase/functions/_shared/graphiste.ts');
  for (const [name, src] of [['generate-image', genImage], ['_shared/graphiste', sharedGraphiste]]) {
    assert.match(
      src,
      /graphisteStatusCandidates/,
      `${name} must build poll targets through the shared guard`,
    );
    assert.equal(
      /function (graphisteStatusCandidates|statusCandidates)\(/.test(src),
      false,
      `${name} must not keep a local, unguarded copy of the candidate builder`,
    );
  }
  // The request body's job id is validated before it is used.
  assert.match(genImage, /sanitizeJobId\(body\?\.jobId\)/);
});

test('a resume request never falls through into a new (paid) generation', () => {
  const genImage = read('supabase/functions/generate-image/index.ts');
  // Resume mode is decided by what the CALLER sent, not by whether the job id
  // survived validation. Keying the branch on the sanitized id instead would
  // send a rejected handle down the generate path and mint a second poster.
  assert.match(genImage, /const resumeRequested = Boolean\(body\?\.jobId \|\| resumeStatusUrl\)/);
  assert.match(genImage, /if \(resumeRequested\) \{/);
  assert.match(genImage, /if \(!resumeJobId\) \{\s*\n\s*return noFinalImage\("unusable job reference"\)/);
});
