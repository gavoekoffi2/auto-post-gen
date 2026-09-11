import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const weekly = read('server/src/services/weekly.ts');
const publish = read('server/src/services/publish.ts');
const generation = read('server/src/services/generation.ts');
const media = read('server/src/lib/media.ts');

test('weekly generation attaches a custom-library image when the profile has one', () => {
  assert.match(weekly, /profile\.use_custom_images/);
  assert.match(weekly, /profile\.custom_image_urls/);
  assert.match(weekly, /image_url\b/);
  // The row's id is read back, because the poster job attaches to that post.
  assert.match(weekly, /RETURNING id/);
});

test('weekly generation starts a poster job when there is no custom image', () => {
  assert.match(weekly, /if \(!customImage && env\.graphisteKey\)/);
  assert.match(weekly, /startPosterJob\(/);
  // Best-effort: a poster failure must not lose the text just generated.
  assert.match(weekly, /\[weekly\] poster failed/);
});

test('publishing resumes a poster that was still rendering', () => {
  // Without this a scheduled post goes out text-only — and fails outright on
  // a network that requires media — while a finished poster sits unattached
  // in its job row.
  assert.match(publish, /if \(!imageUrl && claimed\.image_job_id\)/);
  assert.match(publish, /readJob\(profileId, claimed\.image_job_id\)/);
  assert.match(publish, /job\?\.status === "completed" && job\.result_url/);
});

test('a finished poster is copied into our own storage, not linked', () => {
  // The renderer's URLs expire. Persisting one meant the poster silently
  // vanished from the dashboard and from posts scheduled for later.
  assert.match(generation, /async function persistPoster/);
  assert.match(generation, /rehostRemoteImage\(profileId, remoteUrl\)/);
  assert.match(generation, /INSERT INTO media_assets/);
  // Best-effort: keeping the provider URL is worse than owning the file, but
  // better than losing a render that was already paid for.
  assert.match(generation, /return remoteUrl;/);
});

test('re-hosting validates the URL, the type and the size before writing', () => {
  assert.match(media, /export async function rehostRemoteImage/);
  assert.match(media, /asImageUrl\(url, "image_url"\)/);
  // A redirect can land anywhere, so the type and size checks — not the
  // initial URL — are what actually bound this.
  assert.match(media, /extensionForType\(declared\)/);
  assert.match(media, /declaredLength > MAX_UPLOAD_BYTES/);
  assert.match(media, /maxBytes/);
});

test('a locally stored poster is published through a capability URL', () => {
  // /api/media/:id/file needs a session, which the provider does not have.
  assert.match(publish, /async function publishableUrl/);
  assert.match(publish, /mediaAssetIdFromUrl\(url\)/);
  assert.match(publish, /encode\(gen_random_bytes\(32\), 'hex'\)/);
  // Minted once and reused: regenerating it would break a provider that
  // re-fetches the image later.
  assert.match(publish, /COALESCE\(public_token,/);
  // Scoped to the owner, like every other row access.
  assert.match(publish, /WHERE id = \$1 AND profile_id = \$2/);
  // Silently sending a relative path the provider drops would look like a
  // successful publish with no image.
  assert.match(publish, /APP_PUBLIC_URL is required/);
});

test('the poster request honours the documented Graphiste GPT async contract', () => {
  assert.match(generation, /mode: "async"/);
  assert.match(generation, /quality: "premium"/);
  assert.match(generation, /reliability_mode: true/);
  // Avoids double-charging when a request is retried.
  assert.match(generation, /"Idempotency-Key": crypto\.randomUUID\(\)/);
  assert.match(generation, /resolution: "2K"/);
  assert.match(generation, /aspect_ratio/);
});

test('job-id parsing lives in one tested module, not duplicated per call site', () => {
  // The request_id-vs-job_id distinction must not drift between the weekly
  // path and the interactive one.
  assert.match(generation, /from "\.\.\/shared\/graphisteParse\.js"/);
  assert.match(generation, /extractJobId/);
  assert.match(generation, /extractStatusUrl/);
  assert.doesNotMatch(generation, /o\.request_id \|\| o\.requestId/);
});
