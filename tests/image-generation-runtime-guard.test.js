import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime guards for the poster pipeline.
//
// These were written against the Supabase edge implementation and are
// re-anchored here on the self-hosted API. The GUARANTEES are unchanged and
// still the point of the file:
//
//   * a slow poster is handed back as a job to poll, never a held-open request;
//   * polling an existing job never starts — or bills — a second generation;
//   * the spinner is always cleared, on every path;
//   * a failed generation is reported as failed, never replaced by a local
//     placeholder passed off as a successful render.
//
// The server-side half (the provider call, the job row, the persisted job id)
// is asserted in the API server's own tests; this file covers the client.

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboard = readFileSync(join(__dirname, '..', 'src/pages/Dashboard.tsx'), 'utf8');
const apiClient = readFileSync(join(__dirname, '..', 'src/lib/api.ts'), 'utf8');

test('every API call is bounded and the image spinner is always cleared', () => {
  // A hung gateway must never freeze the dashboard: the client aborts.
  assert.match(apiClient, /const controller = new AbortController\(\)/);
  assert.match(apiClient, /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
  assert.match(apiClient, /timeoutMs = DEFAULT_TIMEOUT_MS/);

  // Spinner cleanup runs in finally blocks so no code path leaves it stuck.
  const finallyCleanups =
    dashboard.match(/finally \{[^}]*setGeneratingImageIds\(\(prev\) => \{/g) || [];
  assert.ok(finallyCleanups.length >= 2, 'image spinner must be cleared in finally blocks');
  assert.match(dashboard, /toast\.dismiss\(loadingToast\)/);
});

test('a slow poster is handed back as a job to poll, not a held-open request', () => {
  assert.match(apiClient, /export interface GenerationJob/);
  assert.match(apiClient, /status: "processing" \| "completed" \| "failed"/);
  assert.match(dashboard, /async function awaitPosterJob\(/);
  assert.match(dashboard, /generations\.status\(jobId\)/);
  // Polling is bounded too: it gives up and tells the user the render
  // continues server-side, rather than spinning forever.
  assert.match(dashboard, /POSTER_POLL_BUDGET_MS/);
  assert.match(dashboard, /se poursuit côté serveur/);
});

test('polling an existing job never starts a second paid generation', () => {
  // This is the money-losing mistake the whole design exists to prevent.
  const resume = dashboard.match(/const resumePendingImage[\s\S]*?\n  \};/)[0];
  assert.match(resume, /await awaitPosterJob\(post\.image_job_id\)/);
  assert.equal(
    /generations\.image\(/.test(resume),
    false,
    'resuming must poll the existing job, never request a new generation',
  );

  const poller = dashboard.match(/async function awaitPosterJob[\s\S]*?\n\}/)[0];
  assert.equal(
    /generations\.image\(/.test(poller),
    false,
    'the poller must only read job status',
  );

  // And the status read is documented as such in the client contract.
  assert.match(apiClient, /never starts, and\s*\n\s*\* never bills, a second generation/);
});

test('a transient read failure is not treated as a failed job', () => {
  // Only the server saying "failed" is terminal; a 5xx while polling must not
  // throw away a render the user has already paid for.
  const poller = dashboard.match(/async function awaitPosterJob[\s\S]*?\n\}/)[0];
  assert.match(poller, /err instanceof ApiError && err\.status >= 500\) continue/);
  assert.match(poller, /job\.status === "failed"/);
});

test('a poster that was not produced is reported, never faked', () => {
  // No local SVG or "secours" visual is ever presented as a real generation.
  assert.equal(dashboard.includes('visuel de secours'), false);
  assert.equal(dashboard.includes('affiche professionnelle de secours'), false);
  // The provider's own reason is what the user sees.
  assert.match(dashboard, /job\.error \|\| "La génération de l'affiche a échoué\."/);
  assert.match(dashboard, /toast\.error\(res\.error\)/);
});

test('the generation provider is never reachable from the browser', () => {
  // Keys live in the API's environment. The bundle must carry no provider
  // endpoint, no key name and no direct call to a generation service.
  for (const forbidden of [
    'GRAPHISTE_GPT_API_KEY',
    'OPENROUTER_API_KEY',
    'graphistegpt.pro',
    'openrouter.ai',
  ]) {
    assert.equal(
      dashboard.includes(forbidden) || apiClient.includes(forbidden),
      false,
      `${forbidden} must never appear in frontend code`,
    );
  }
});

test('no provider endpoint silently points at a Supabase project', () => {
  // The poster endpoint used to default to a hardcoded *.supabase.co address.
  // An operator who set the API key but not the URL therefore shipped every
  // poster — company name, sector, brand colours, and any consented photo of
  // a real person — to a Supabase project this deployment does not own, while
  // believing the platform had no cloud dependency left.
  const serverDir = join(__dirname, '..', 'server/src');
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(dir, entry.name)]
          : [],
    );

  for (const file of walk(serverDir)) {
    const source = readFileSync(file, 'utf8');
    // Prose may explain the migration; a URL is a dependency.
    const urls = source.match(/https?:\/\/[^\s"'`)]+/g) || [];
    for (const url of urls) {
      assert.doesNotMatch(
        url,
        /supabase\.(co|in)/,
        `${file.replace(join(__dirname, '..') + '/', '')} still reaches a Supabase host: ${url}`,
      );
    }
  }
});

test('poster generation is refused outright when its endpoint is unconfigured', () => {
  const generation = readFileSync(
    join(__dirname, '..', 'server/src/services/generation.ts'),
    'utf8',
  );
  // Refused with the variable named, rather than falling back to any default.
  assert.match(generation, /if \(!env\.graphisteUrl\) \{/);
  assert.match(generation, /GRAPHISTE_GPT_API_URL/);
  assert.doesNotMatch(generation, /env\.graphisteUrl \?\?/);
});
