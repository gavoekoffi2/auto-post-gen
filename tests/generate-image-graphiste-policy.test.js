import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'supabase/functions/generate-image/index.ts'), 'utf8');

test('generate-image uses Graphiste GPT premium only — no generic/Gemini/OpenRouter providers', () => {
  assert.equal(source.includes('generateImageUrl('), false, 'must not call a generic image generator');
  assert.equal(source.includes('getOpenRouterKey'), false);
  assert.equal(/Gemini|gemini|OPENROUTER/.test(source), false);
  assert.match(source, /quality:\s*"premium"/);
  assert.equal(source.includes('mode: "fast"'), false);
  assert.equal(source.includes('quality: "fast"'), false);
});

test('generate-image sends the documented Graphiste GPT v1.1 contract fields', () => {
  // Fields per https://graphistegpt.pro/docs/api — the API reads `subject`
  // (not a free-form prompt), aspect_ratio/resolution control the format,
  // mode "async" is the recommended Supabase flow, and Idempotency-Key avoids
  // double-charging on retries.
  assert.match(source, /subject:\s*buildGraphisteSubject\(params\)/);
  assert.match(source, /title:\s*titleFromPost\(/);
  assert.match(source, /aspect_ratio:\s*graphisteAspectRatio\(params\.spec\)/);
  assert.match(source, /resolution:\s*"2K"/);
  assert.match(source, /mode:\s*"async"/);
  // Pro Social AI must opt into Graphiste's premium-first raster fallback;
  // otherwise a transient GPT Image 2 timeout leaves every post without media.
  assert.match(source, /reliability_mode:\s*true/);
  assert.match(source, /"Idempotency-Key":\s*crypto\.randomUUID\(\)/);
  assert.match(source, /domain:\s*graphisteDomain\(params\.sector, params\.description, params\.postContent\)/);
  assert.match(source, /requestBody\.colors = colors/);
  assert.match(source, /requestBody\.logo_urls = \[params\.logoUrl\]/);
});

test('aspect_ratio sends the exact supported network ratio (e.g. 1.91:1), never the 9:16 default', () => {
  // v1.1 supports 1.91:1 etc., so we send the spec ratio when supported.
  assert.match(source, /GRAPHISTE_RATIOS\.has\(spec\.aspectRatio\)\s*\)\s*return spec\.aspectRatio/);
  assert.match(source, /"1\.91:1"/);
  assert.match(source, /"5:4"/, 'OpenAPI v1.1 also supports 5:4');
  // and a safe orientation fallback remains for any unsupported ratio.
  assert.match(source, /case "landscape": return "16:9"/);
  assert.match(source, /default: return "1:1"/);
});

test('generate-image no longer sends the undocumented fields the API ignores', () => {
  assert.equal(source.includes('usageType'), false);
  assert.equal(source.includes('waitForCompletion'), false);
  assert.equal(source.includes('returnImage'), false);
  assert.equal(source.includes('returnUrl'), false);
  assert.equal(source.includes('buildGraphistePosterPrompt'), false, 'no free-form prompt builder');
  assert.equal(source.includes('prompt,'), false, 'no prompt field in the request body');
});

test('generate-image parses the v1.1 structured error envelope', () => {
  // { success:false, error:{ code, message, request_id } }
  assert.match(source, /graphisteErrorMessage\(resp\.status, data, text\)/);
  assert.match(source, /envelope\.success === false/);
  assert.match(source, /const apiError = \(body as/);
  assert.match(source, /apiError\.code/);
  assert.match(source, /apiError\.message/);
});

test('generate-image never builds or saves a local SVG poster as a success', () => {
  assert.equal(source.includes('buildProfessionalPosterSvgDataUrl'), false);
  assert.equal(source.includes('professional-poster-fallback'), false);
  assert.equal(source.includes('data:image/svg+xml'), false, 'never emits an SVG data URL');
  assert.match(source, /provider:\s*"graphiste-gpt"/);
  // SVGs/placeholders are actively rejected when extracting/verifying images.
  assert.match(source, /contentType\.includes\("svg"\)/);
  assert.match(source, /reference-templates/);
});

test('generate-image fails with a clear, actionable error instead of saving junk', () => {
  assert.match(source, /code:\s*"missing_api_key"/);
  assert.match(source, /code:\s*"no_final_image"/);
  assert.match(source, /GRAPHISTE_GPT_API_KEY/);
});

test('generate-image surfaces the specific Graphiste failure (credits/key/rate) to the user', () => {
  // On a hard failure, return the precise reason (402/401/429 …) as the primary
  // error, not a generic message with the cause buried in the logs.
  assert.match(source, /code:\s*"graphiste_error"/);
  assert.match(source, /graphiste\.warning\s*\n?\s*\?\s*jsonResponse\(\{ error: graphiste\.warning/);
  // those precise messages exist and stay actionable.
  assert.match(source, /Crédits Graphiste GPT insuffisants \(402\)/);
  assert.match(source, /Clé Graphiste GPT invalide ou manquante \(401\)/);
});

test('generate-image uses the documented business default and async polling', () => {
  assert.match(source, /postContent = ""/);
  assert.equal(source.includes('return "service";'), false);
  assert.match(source, /return "business";/, 'documented generic default domain');
  assert.match(source, /pollGraphisteJob/);
  assert.match(source, /extractGraphisteJobId/);
  assert.match(source, /statusUrl/);
  // A structured non-2xx JOB_TIMEOUT/GENERATION_FAILED envelope is terminal.
  // The body must therefore be parsed before the HTTP status is skipped.
  assert.match(source, /obj\.success === false && obj\.error/);
  assert.match(
    source,
    /const text = await resp\.text\(\);[\s\S]*?graphisteJobFailed\(data\)[\s\S]*?if \(!resp\.ok\) continue;/,
  );
  // stops early when the polled job reports a terminal failure.
  assert.match(source, /graphisteJobFailed/);
});

test('generate-image prioritizes the canonical public poll route over an emitted status URL', () => {
  const fnStart = source.indexOf('function graphisteStatusCandidates');
  const fnEnd = source.indexOf('\n}\n', fnStart);
  const fn = source.slice(fnStart, fnEnd);
  assert.ok(fn.indexOf('if (jobId)') >= 0);
  assert.ok(fn.indexOf('if (statusUrl)') >= 0);
  assert.ok(fn.indexOf('if (jobId)') < fn.indexOf('if (statusUrl)'),
    'canonical job-id route must be tried before potentially stale/internal status_url');
});

test('generate-image extracts the canonical data.job_id, never the trace request_id', () => {
  // The v1.1 envelope has a top-level request_id (trace id) plus data.job_id.
  // Grabbing request_id as the job id makes GET /v1/posters/{id} 404 on resume.
  assert.doesNotMatch(source, /obj\.job_id \|\| obj\.jobId \|\| obj\.request_id/,
    'must not treat the top-level request_id as a job id');
  assert.match(source, /obj\.job_id \|\| obj\.jobId \|\| obj\.task_id \|\| obj\.taskId \|\| obj\.id/);
});

test('generate-image persists the in-flight job on the row so a slow poster is not orphaned', () => {
  // When handing the job back to the client, also save it on the post row, so a
  // poster that finishes after the client gives up can be resumed on next load.
  assert.match(source, /image_job_id: jobId, image_status_url: statusUrl, image_status: "processing"/);
  // and the success path clears the job + stale status url.
  assert.match(source, /image_status: "done", image_job_id: null, image_status_url: null/);
});

test('generate-image is resumable: short bounded polls + job handoff (no 150s blocking call)', () => {
  assert.match(source, /function pollGraphisteJob\(/);
  assert.match(source, /function resumeGraphisteJob\(/);
  assert.match(source, /const stillProcessing =/);
  assert.match(source, /status: "processing"/);
  // each poll window stays well under Supabase's 150s request timeout.
  assert.match(source, /pollGraphisteJob\(candidates, key, 40_000/);
  assert.match(source, /resumeGraphisteJob\(resumeJobId, resumeStatusUrl, 45_000\)/);
  assert.equal(source.includes('110_000'), false, 'no single ~110s blocking poll');
  assert.equal(source.includes('125_000'), false, 'no ~125s blocking controller');
});

test('Graphiste GPT response extractor accepts common final poster URL shapes', () => {
  for (const field of [
    'poster_url',
    'posterUrl',
    'final_image_url',
    'generated_image_url',
    'asset_url',
    'public_url',
    'downloadUrl',
    'secure_url',
    'image_url',
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
