import test from 'node:test';
import assert from 'node:assert/strict';

// Behavioral tests for the pure Graphiste GPT response parsers. Node strips the
// TypeScript types on import (supported since v22.6), so we exercise the real
// extraction logic — not just the source text.
import {
  extractJobId,
  extractStatusUrl,
  jobFailed,
} from '../supabase/functions/_shared/graphisteParse.ts';

// The canonical v1.1 async response (POST /v1/posters/generate, HTTP 202), per
// the published OpenAPI spec: the JOB id is data.job_id; request_id at the top
// level is only an API trace id. GET /v1/posters/{request_id} 404s, so mistaking
// the trace id for the job id silently breaks every later resume/poll.
const ASYNC_ACCEPTED = {
  success: true,
  data: {
    job_id: 'job-REAL-123',
    status: 'processing',
    image_url: null,
    status_url: 'https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/job-REAL-123',
  },
  warnings: [],
  request_id: 'trace-DO-NOT-USE-456',
};

test('extractJobId returns data.job_id, never the top-level request_id', () => {
  assert.equal(extractJobId(ASYNC_ACCEPTED), 'job-REAL-123');
  assert.notEqual(extractJobId(ASYNC_ACCEPTED), 'trace-DO-NOT-USE-456');
});

test('extractJobId never treats a bare request_id as a job id', () => {
  // An envelope that only carries a trace id must yield no job id (so the caller
  // hands back null and does not poll a 404 URL forever).
  assert.equal(extractJobId({ success: true, request_id: 'trace-only', data: {} }), null);
  assert.equal(extractJobId({ request_id: 'trace-only' }), null);
});

test('extractJobId accepts direct and aliased shapes, including numeric ids', () => {
  assert.equal(extractJobId({ job_id: 'abc' }), 'abc');
  assert.equal(extractJobId({ data: { jobId: 'def' } }), 'def');
  assert.equal(extractJobId({ task_id: 'ghi' }), 'ghi');
  assert.equal(extractJobId({ data: { id: 'jkl' } }), 'jkl');
  assert.equal(extractJobId({ data: { job_id: 42 } }), '42');
});

test('extractStatusUrl returns the absolute canonical poll URL', () => {
  assert.equal(
    extractStatusUrl(ASYNC_ACCEPTED),
    'https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/job-REAL-123',
  );
  assert.equal(extractStatusUrl({ data: { poll_url: 'https://x/y' } }), 'https://x/y');
  assert.equal(extractStatusUrl({ data: {} }), null);
});

test('jobFailed flags terminal states and non-2xx Graphiste error envelopes', () => {
  assert.equal(jobFailed({ data: { status: 'failed' } }), true);
  assert.equal(jobFailed({ data: { status: 'error' } }), true);
  assert.equal(jobFailed({ data: { status: 'cancelled' } }), true);
  assert.equal(jobFailed({ success: false, error: { code: 'JOB_TIMEOUT', message: 'safe to retry' } }), true);
  assert.equal(jobFailed({ success: false, error: 'GENERATION_FAILED' }), true);
  assert.equal(jobFailed({ data: { status: 'processing' } }), false);
  assert.equal(jobFailed({ data: { status: 'completed' } }), false);
  assert.equal(jobFailed(ASYNC_ACCEPTED), false);
});
