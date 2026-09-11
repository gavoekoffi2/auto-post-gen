import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The security guarantees, asserted against the self-hosted stack.
//
// These used to point at the Supabase Edge Functions. The functions are gone;
// every guarantee they covered had to land somewhere in server/ before this
// file could be re-pointed, and each test below names where.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const index = read('server/src/index.ts');
const session = read('server/src/lib/session.ts');
const tenant = read('server/src/lib/tenant.ts');
const password = read('server/src/lib/password.ts');
const validate = read('server/src/lib/validate.ts');
const media = read('server/src/lib/media.ts');
const schema = read('server/migrations/0001_core_schema.sql');
const authRoutes = read('server/src/routes/auth.ts');
const profileRoutes = read('server/src/routes/profile.ts');
const postRoutes = read('server/src/routes/posts.ts');
const generationRoutes = read('server/src/routes/generations.ts');
const generation = read('server/src/services/generation.ts');
const misc = read('server/src/routes/misc.ts');
const publish = read('server/src/services/publish.ts');
const adminGuard = read('src/components/ProtectedAdminRoute.tsx');
const adminPage = read('src/pages/Admin.tsx');

test('the API is same-origin only: no CORS surface to get wrong', () => {
  // The dashboard is served from the same host and calls relative /api paths,
  // so a cross-origin request is never legitimate. The old fail-closed CORS
  // helper existed because the functions lived on another origin; here the
  // correct configuration is none at all.
  assert.match(index, /No CORS plugin, deliberately/);
  assert.doesNotMatch(index, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(index, /@fastify\/cors/);
});

test('the session cookie cannot be read or sent cross-site', () => {
  assert.match(session, /httpOnly: true/);
  assert.match(session, /sameSite: "lax"/);
  assert.match(session, /secure: env\.isProduction/);
  // Only a hash is stored: a database dump must not hand over live sessions.
  assert.match(session, /INSERT INTO sessions \(profile_id, token_hash,/);
  assert.match(session, /hashToken\(token\)/);
  // …and the sessions table has no column that could hold the raw token.
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS sessions[\s\S]*?^\s*token\s+text/m);
});

test('the browser never states who it is', () => {
  // Every authenticated route derives the tenant from the verified session.
  // A profileId or userId taken from a request body would make every row in
  // the product reachable by guessing an id.
  assert.match(tenant, /export async function requireTenant/);
  assert.match(tenant, /readSession\(request\)/);
  for (const [name, src] of [
    ['profile', profileRoutes],
    ['posts', postRoutes],
    ['generations', generationRoutes],
  ]) {
    assert.doesNotMatch(src, /body\.profileId|body\.userId|body\.profile_id|body\.user_id/,
      `${name} must not read an identity from the request body`);
  }
});

test('passwords are salted, stretched and compared in constant time', () => {
  assert.match(password, /scrypt/);
  assert.match(password, /timingSafeEqual/);
  assert.match(password, /const SALT_LENGTH = 16;/);
  assert.match(password, /randomBytes\(SALT_LENGTH\)/);
  // An unknown address must not answer faster than a wrong password, or the
  // login endpoint becomes an account-enumeration oracle.
  assert.match(password, /export async function fakeVerifyDelay/);
  assert.match(authRoutes, /await fakeVerifyDelay\(\)/);
  assert.match(authRoutes, /throw unauthorized\("Email ou mot de passe incorrect\."\)/);
});

test('password reset never reveals whether an address has an account', () => {
  const block = authRoutes.slice(authRoutes.indexOf('/auth/password-reset/request'));
  assert.match(block.slice(0, 2500), /return \{ ok: true \}/);
  // Only a hash of the token is stored, and it can only be claimed once.
  assert.match(authRoutes, /hashOneTimeToken\(token\)/);
  assert.match(authRoutes, /used_at IS NULL/);
});

test('image URLs handed to an external renderer cannot probe a private network', () => {
  // logo_url, custom_image_urls and a post's image_url are all fetched by
  // somebody else's server. A link-local or RFC1918 host there is an SSRF
  // probe whose result comes back rendered into a poster.
  assert.match(validate, /export function asImageUrl/);
  assert.match(validate, /const PRIVATE_HOST =/);
  // The link-local range is where cloud instance metadata lives.
  assert.ok(validate.includes(String.raw`169\.254`), 'link-local must be refused');
  assert.ok(validate.includes(String.raw`127\.`), 'loopback must be refused');
  assert.ok(validate.includes('localhost'));
  assert.match(validate, /protocol !== "https:"/);
  assert.match(profileRoutes, /logo_url: \(v: unknown\) => asImageUrl\(v, "logo_url"\)/);
  assert.match(profileRoutes, /asImageUrl\(url, "custom_image_urls\[\]"\)/);
  assert.match(postRoutes, /asImageUrl\(body\.imageUrl, "imageUrl"\)/);
  assert.match(postRoutes, /asImageUrl\(body\.image_url, "image_url"\)/);
});

test('uploads are bounded and cannot be written outside the media volume', () => {
  assert.match(media, /export const MAX_UPLOAD_BYTES/);
  // Enforced WHILE streaming: checking the length after buffering means the
  // oversized upload has already been written before it is rejected.
  assert.match(media, /written > maxBytes|written \+ chunk|maxBytes/);
  // The path is composed from the session's profile id and a fresh UUID, and
  // the resolver refuses anything that escapes the root anyway.
  assert.match(media, /export function resolveMediaPath/);
  assert.match(media, /!absolute\.startsWith\(root \+ sep\)/);
  assert.match(media, /randomUUID\(\)/);
  // SVG is refused: it is a document that can carry <script>, served from the
  // app's own origin.
  assert.doesNotMatch(media, /"image\/svg\+xml"/);
  assert.match(media, /le SVG n'est pas accepté/);
});

test('generation quota is enforced atomically, under a lock', () => {
  assert.match(schema, /CREATE OR REPLACE FUNCTION consume_generation_quota/);
  assert.match(schema, /pg_advisory_xact_lock/);
  // Parallel requests all reading the same count and all passing is the
  // classic way a "limit" turns out not to be one.
  assert.match(generationRoutes, /consumeQuota\(ctx\.profileId, "generate-image"/);
  assert.match(generationRoutes, /consumeQuota\(ctx\.profileId, "generate-text"/);
  assert.match(profileRoutes, /consumeQuota\(ctx\.profileId, "detect-audiences"/);
});

test('a generation that produced nothing gives the reservation back', () => {
  assert.match(generationRoutes, /releaseQuota\(ctx\.profileId, "generate-text"\)/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION release_generation_quota/);
});

test('no fabricated image is ever presented as a successful generation', () => {
  // A locally drawn SVG placeholder returned as a poster is the product
  // lying about what it did. Missing configuration is said out loud instead.
  assert.doesNotMatch(generation, /<svg|image\/svg/i);
  assert.match(generation, /GRAPHISTE_GPT_API_KEY/);
  assert.match(generation, /notConfigured\(/);
});

test('a slow poster render answers with a job id rather than blocking', () => {
  assert.match(generation, /"processing"/);
  assert.match(generation, /export async function readJob/);
  // Polling is a pure status read: it must never start — or bill — a second
  // render for a job that is already running.
  assert.match(generation, /This is a STATUS READ/);
  const readJobBlock = generation.slice(generation.indexOf('export async function readJob'));
  assert.doesNotMatch(readJobBlock, /startPosterJob\(/);
  assert.doesNotMatch(readJobBlock, /consumeQuota\(/);
});

test('a photo of a real person needs recorded consent before it leaves the server', () => {
  assert.match(generation, /leader_photo_consent_at/);
  assert.match(generation, /consent_required/);
  // The check sits where the image would be transmitted, not in the UI, so
  // no caller can skip it.
  const start = generation.indexOf('export async function startPosterJob');
  const send = generation.indexOf('reference_image_urls');
  assert.ok(generation.slice(start, send).includes('leader_photo_consent_at'));
});

test('the publish queue is bounded and backs off', () => {
  assert.match(publish, /MAX_PUBLISH_ATTEMPTS/);
  assert.match(publish, /RETRY_BACKOFF_MINUTES/);
  assert.match(schema, /next_publish_attempt_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(schema, /posts_attempts_nonneg/);
});

test('a crashed publish that already reached the provider is not re-posted', () => {
  assert.match(schema, /CREATE OR REPLACE FUNCTION recover_stuck_publishing/);
  assert.match(schema, /provider_post_id IS NOT NULL/);
  assert.match(schema, /provider_post_id IS NULL/);
});

test('privileges are never writable by the account that would gain them', () => {
  // WRITABLE is the whole point of the profile route: plan, role, blocked_at
  // and the consent timestamp are absent from it on purpose.
  const writable = profileRoutes.slice(
    profileRoutes.indexOf('const WRITABLE = {'),
    profileRoutes.indexOf('function asHexColor'),
  );
  for (const column of ['plan:', 'role:', 'blocked_at:', 'leader_photo_consent_at:', 'email:']) {
    assert.equal(writable.includes(column), false, `${column} must not be user-writable`);
  }
  // The one plan-gated feature is resolved from the session's plan, never
  // from what the request claims.
  assert.match(profileRoutes, /ctx\.user\.plan === "enterprise"/);
});

test('the admin control plane is authorised server-side', () => {
  assert.match(misc, /requireAdmin\(request, reply\)/);
  assert.match(tenant, /export async function requireAdmin/);
  // The userId inside an action names the account being acted ON, never who
  // is calling.
  assert.match(misc, /never who is calling/);
  // The role is asked of the SERVER, never read from anything the browser holds.
  assert.match(adminGuard, /admin\.me\(\)/);
  assert.match(adminGuard, /me\.role === "admin" \|\| me\.role === "super_admin"/);
  for (const action of ['create_user', 'set_plan', 'set_role', 'set_blocked', 'reset_password', 'delete_user']) {
    assert.match(adminPage, new RegExp(action));
  }
});

test('no provider secret can reach the browser', () => {
  // Every key is read from the server's env and used server-side. A VITE_
  // prefixed secret would be compiled into the bundle.
  for (const [name, src] of [['admin page', adminPage], ['dashboard', read('src/pages/Dashboard.tsx')]]) {
    assert.doesNotMatch(src, /GRAPHISTE_GPT_API_KEY|OPENROUTER_API_KEY|ZERNIO_API_KEY|SERVICE_ROLE/,
      `${name} must not name a server secret`);
  }
  assert.doesNotMatch(read('src/lib/api.ts'), /import\.meta\.env\.VITE_/);
});

test('public endpoints are IP rate-limited', () => {
  assert.match(schema, /CREATE OR REPLACE FUNCTION hit_ip_rate_limit/);
  assert.match(schema, /pg_advisory_xact_lock/);
  assert.match(authRoutes, /hitRateLimit\(`login:\$\{clientIp\(request\)\}`/);
  assert.match(authRoutes, /hitRateLimit\(`register:\$\{clientIp\(request\)\}`/);
  assert.match(authRoutes, /hitRateLimit\(`reset:\$\{clientIp\(request\)\}`/);
  assert.match(postRoutes, /hitRateLimit\(`validate-token:\$\{clientIp\(request\)\}`/);
  assert.match(misc, /hitRateLimit\(`contact:\$\{clientIp\(request\)\}`/);
  // The client IP comes from Fastify's trustProxy handling, never from a
  // header a caller can set for itself.
  assert.match(index, /trustProxy: true/);
  assert.match(tenant, /export function clientIp/);
});

test('password change is verified with the current password, server-side', () => {
  const account = read('src/components/AccountSettings.tsx');
  // Both passwords travel together so the server verifies the old one before
  // accepting the new one. Verifying in a separate round trip would leave a
  // window between the check and the change.
  assert.match(account, /auth\.changePassword\(currentPassword, newPassword\)/);
  assert.match(authRoutes, /verifyPassword\(currentPassword/);
  // And every other session dies with the old password.
  assert.match(authRoutes, /destroyAllSessions\(ctx\.profileId\)/);
});

test('deleting an account requires the password, in its own field', () => {
  const account = read('src/components/AccountSettings.tsx');
  // Irreversible, so a session left open on a shared machine is not enough.
  assert.match(account, /account\.remove\(deletePassword\)/);
  // Its own field: reusing the "change password" input above would mean
  // typing your password into an unrelated form to delete your account.
  assert.match(account, /const \[deletePassword, setDeletePassword\]/);
  assert.match(account, /disabled=\{deleting \|\| confirmText !== CONFIRM_WORD \|\| !deletePassword\}/);
  assert.match(misc, /verifyPassword\(password/);
});

test('an export is the user\'s data, not the server\'s secrets', () => {
  assert.match(misc, /delete \(safeProfile as Record<string, unknown>\)\.password_hash/);
  assert.match(misc, /delete \(safeProfile as Record<string, unknown>\)\.password_salt/);
});

test('email validation requires an explicit click (no auto-validate on load)', () => {
  const validatePage = read('src/pages/ValidatePost.tsx');
  // No useEffect-driven validation on mount.
  assert.equal(validatePage.includes('useEffect'), false);
  assert.match(validatePage, /status === "confirm"/);
  assert.match(validatePage, /onClick=\{validate\}/);
});

test('a validation link cannot roll back a post that is already published', () => {
  assert.match(postRoutes, /AND status = 'pending'/);
  assert.match(postRoutes, /purpose = 'post_validation'/);
});

test('AI comment auto-reply is gated to the Enterprise plan (server-side)', () => {
  assert.match(profileRoutes, /wanted && ctx\.user\.plan === "enterprise"/);
  // The UI locks the toggle too, but the server is what decides.
  const commentsUi = read('src/pages/Comments.tsx');
  assert.match(commentsUi, /isEnterprise/);
  assert.match(commentsUi, /isEnterprise \? autoReply : false/);
});

test('quick settings dialog no longer destroys content_types or custom image library', () => {
  const settingsDialog = read('src/components/SettingsDialog.tsx');
  assert.equal(settingsDialog.includes('content_types: [formData.contentType]'), false);
  assert.equal(
    settingsDialog.includes('formData.useCustomImages ? formData.customImageUrls : []'),
    false,
  );
});

test('TikTok is gated as "coming soon" in the platform pickers', () => {
  for (const p of ['src/pages/Profile.tsx', 'src/pages/Onboarding.tsx', 'src/components/SettingsDialog.tsx']) {
    const src = read(p);
    assert.match(src, /id: 'TikTok', comingSoon: true/);
    assert.match(src, /disabled=\{comingSoon\}/);
  }
});
