import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const client = read('supabase/functions/_shared/moneyprinter.ts');
const generate = read('supabase/functions/generate-video/index.ts');
const status = read('supabase/functions/video-status/index.ts');
const migration = read('supabase/migrations/20260707000000_video_jobs.sql');
const config = read('supabase/config.toml');
const videosPage = read('src/pages/Videos.tsx');
const app = read('src/App.tsx');
const types = read('src/integrations/supabase/types.ts');

test('MoneyPrinterTurbo client targets the documented REST endpoints', () => {
  assert.match(client, /\/api\/v1\/videos/, 'POST /api/v1/videos to submit');
  assert.match(client, /\/api\/v1\/tasks\//, 'GET /api/v1/tasks/{id} to poll');
  assert.match(client, /\/api\/v1\/download\//, 'download the finished file');
  assert.match(client, /MONEYPRINTER_API_URL/);
});

test('buildVideoParams sends the documented VideoParams fields', () => {
  assert.match(client, /video_subject:/);
  assert.match(client, /video_aspect:/);
  assert.match(client, /video_clip_duration:/);
  assert.match(client, /video_source:/);
  assert.match(client, /subtitle_enabled:/);
  // aspect ratios match the MoneyPrinterTurbo VideoAspect enum.
  assert.match(client, /"9:16"/);
  assert.match(client, /"16:9"/);
  assert.match(client, /"1:1"/);
});

test('generate-video is asynchronous: creates a job row and returns immediately', () => {
  // Creates a pending video_jobs row, submits, then returns the job id.
  assert.match(generate, /\.from\("video_jobs"\)/);
  assert.match(generate, /status:\s*"pending"/);
  assert.match(generate, /submitVideoJob/);
  assert.match(generate, /external_task_id:\s*submit\.taskId/);
  assert.match(generate, /status:\s*"processing"/);
  assert.match(generate, /jobId:\s*job\.id/);
  // Never waits for the render to complete inside the function.
  assert.doesNotMatch(generate, /downloadVideo/);
});

test('generate-video fails clearly when the microservice URL is missing', () => {
  assert.match(generate, /getMoneyPrinterBaseUrl\(\)/);
  assert.match(generate, /missing_service_url/);
  assert.match(generate, /MONEYPRINTER_API_URL/);
});

test('video-status downloads the file and stores it in Supabase Storage on done', () => {
  assert.match(status, /getVideoJobStatus/);
  assert.match(status, /downloadVideo/);
  assert.match(status, /storage\s*\n?\s*\.from\("user-assets"\)/);
  assert.match(status, /status:\s*"done"/);
  assert.match(status, /video_url:/);
  // Terminal states are never re-polled / overwritten.
  assert.match(status, /job\.status === "done" \|\| job\.status === "failed"/);
});

test('video-status supports both a user JWT and a CRON_SECRET batch sweep', () => {
  assert.match(status, /getUserIdFromAuthHeader/);
  assert.match(status, /CRON_SECRET/);
  assert.match(status, /x-cron-secret/);
  assert.match(status, /\.in\("status",\s*\["pending",\s*"processing"\]\)/);
});

test('video_jobs migration has the required columns, RLS and no user INSERT policy', () => {
  for (const col of ['id', 'user_id', 'status', 'external_task_id', 'video_url', 'error_message', 'created_at', 'updated_at', 'params', 'progress']) {
    assert.match(migration, new RegExp(`\\b${col}\\b`), `missing column ${col}`);
  }
  assert.match(migration, /CHECK \(status IN \('pending', 'processing', 'done', 'failed'\)\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FOR SELECT\s+USING \(auth\.uid\(\) = user_id\)/);
  // Inserts come from the service role only — no end-user INSERT policy.
  assert.doesNotMatch(migration, /FOR INSERT/);
});

test('edge functions are registered with the right JWT policy', () => {
  assert.match(config, /\[functions\.generate-video\]\nverify_jwt = true/);
  // video-status verifies auth in-function (user JWT or cron secret).
  assert.match(config, /\[functions\.video-status\]\nverify_jwt = false/);
});

test('frontend subscribes to Realtime so cron-driven job updates appear live', () => {
  assert.match(videosPage, /supabase\s*\n?\s*\.channel\(/);
  assert.match(videosPage, /postgres_changes/);
  assert.match(videosPage, /table:\s*"video_jobs"/);
  assert.match(videosPage, /filter:\s*`user_id=eq\.\$\{session\.user\.id\}`/);
  assert.match(videosPage, /removeChannel/);
});

test('frontend exposes a real video generation UI (not a coming-soon placeholder)', () => {
  assert.match(app, /path="\/videos"/);
  assert.match(videosPage, /generate-video/);
  assert.match(videosPage, /video-status/);
  // form fields
  assert.match(videosPage, /Sujet|subject/);
  assert.match(videosPage, /9:16/);
  // polls until done and previews the result
  assert.match(videosPage, /pollJob/);
  assert.match(videosPage, /<video/);
  // the video_jobs table is typed for the strongly-typed supabase client
  assert.match(types, /video_jobs:/);
});
