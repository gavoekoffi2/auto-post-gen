import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const cors = read('supabase/functions/_shared/cors.ts');
const safeFetch = read('supabase/functions/_shared/safeFetch.ts');
const genContent = read('supabase/functions/generate-content/index.ts');
const genImage = read('supabase/functions/generate-image/index.ts');
const publish = read('supabase/functions/publish-post/index.ts');
const deleteAccount = read('supabase/functions/delete-account/index.ts');
const validationEmail = read('supabase/functions/send-validation-email/index.ts');
const settingsDialog = read('src/components/SettingsDialog.tsx');
const deployWorkflow = read('.github/workflows/deploy-functions.yml');
const migration = read('supabase/migrations/20260620000000_senior_audit_hardening.sql');
const adminApi = read('supabase/functions/admin-api/index.ts');
const adminGuard = read('src/components/ProtectedAdminRoute.tsx');
const adminPage = read('src/pages/Admin.tsx');

test('CORS fails closed: no wildcard default, ACAO omitted when origin not allowed', () => {
  assert.equal(cors.includes('"ALLOWED_ORIGINS") || "*"'), false, 'must not default to wildcard');
  assert.match(cors, /Deno\.env\.get\("ALLOWED_ORIGINS"\) \|\| ""/);
  // No inline copy still defaults to wildcard either.
  for (const src of [genContent, genImage, publish]) {
    assert.equal(src.includes('"ALLOWED_ORIGINS") || "*"'), false);
  }
});

test('every function uses the single shared fail-closed CORS helper (no local copies)', () => {
  // Local buildCorsHeaders copies predated the fail-closed hardening (some
  // sent allowedOrigins[0]/undefined as ACAO). They were unified into
  // _shared/cors.ts; this pins that so drift cannot come back. OAuth
  // callbacks are exempt: they are top-level redirects, not CORS calls.
  const dirs = readdirSync(join(__dirname, '..', 'supabase/functions'))
    .filter((d) => !d.startsWith('_') && existsSync(join(__dirname, '..', 'supabase/functions', d, 'index.ts')));
  for (const d of dirs) {
    const src = read(`supabase/functions/${d}/index.ts`);
    assert.equal(
      /function buildCorsHeaders/.test(src),
      false,
      `${d} must import buildCorsHeaders from _shared/cors.ts, not define its own`,
    );
    if (src.includes('Access-Control-Allow-Origin') || src.includes('buildCorsHeaders(')) {
      assert.match(src, /from "\.\.\/_shared\/cors\.ts"/, `${d} must use the shared CORS helper`);
    }
  }
});

test('safeFetch blocks SSRF (non-https + private/metadata hosts) and caps size', () => {
  assert.match(safeFetch, /export function assertSafeImageUrl/);
  assert.match(safeFetch, /export async function fetchImageBytes/);
  assert.match(safeFetch, /protocol !== "https:"/);
  assert.match(safeFetch, /PRIVATE_HOST/);
  assert.match(safeFetch, /cloud metadata/); // 169.254.x.x link-local is blocked
  assert.match(safeFetch, /maxBytes/);
});

test('image re-hosting paths go through the SSRF-guarded fetch', () => {
  assert.match(publish, /from "\.\.\/_shared\/safeFetch\.ts"/);
  assert.match(publish, /fetchImageBytes\(/);
  assert.match(read('supabase/functions/_shared/graphiste.ts'), /fetchImageBytes\(/);
});

test('generation quota is enforced atomically for text and images', () => {
  assert.match(genContent, /consume_generation_quota/);
  assert.equal(genContent.includes('usageCount'), false, 'old non-atomic count check removed');
  assert.match(genImage, /consume_generation_quota/);
  assert.match(genImage, /IMAGE_RATE_LIMIT_MAX/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.consume_generation_quota/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('publish cron batch is bounded', () => {
  assert.match(publish, /CRON_BATCH_SIZE = 12/);
});

test('stuck-publish recovery does not re-publish posts that already have a provider id', () => {
  assert.match(migration, /provider_post_id IS NOT NULL/);
  assert.match(migration, /SET status = 'published'/);
  assert.match(migration, /provider_post_id IS NULL/);
});

test('RLS locks user-writable secret/server columns', () => {
  assert.match(migration, /REVOKE UPDATE ON public\.social_connections FROM authenticated/);
  assert.match(migration, /REVOKE UPDATE ON public\.social_comments FROM authenticated/);
  assert.match(migration, /GRANT UPDATE \(status\) ON public\.social_comments TO authenticated/);
});

test('delete-account is complete and checks errors before removing the auth user', () => {
  assert.match(deleteAccount, /social_comments/);
  assert.match(deleteAccount, /if \(error\) throw new Error\(`Failed to delete/);
});

test('validation email is sent once and does not reset the token TTL', () => {
  assert.match(validationEmail, /validation_email_sent_at/);
  assert.equal(
    validationEmail.includes('validation_token_created_at: new Date().toISOString()'),
    false,
    'must not reset the token TTL on resend',
  );
});

test('quick settings dialog no longer destroys content_types or custom image library', () => {
  assert.equal(settingsDialog.includes('content_types: [formData.contentType]'), false);
  assert.equal(
    settingsDialog.includes('formData.useCustomImages ? formData.customImageUrls : []'),
    false,
  );
});

test('CI deploys all edge functions, not a hand-picked subset', () => {
  assert.match(deployWorkflow, /supabase functions deploy --project-ref/);
  assert.equal(
    deployWorkflow.includes('supabase functions deploy zernio-status'),
    false,
    'should not deploy only a subset',
  );
});

test('super-admin control plane is server-authorized and protects the founder', () => {
  assert.match(adminApi, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(adminApi, /admin\.auth\.getUser\(token\)/);
  assert.match(adminApi, /app_metadata\?\.role/);
  assert.match(adminApi, /actorRole !== "super_admin"/);
  assert.match(adminApi, /targetIsFounder/);
  assert.match(adminApi, /Ce compte ne peut pas être supprimé/);
  assert.equal(adminPage.includes('SUPABASE_SERVICE_ROLE_KEY'), false, 'service role must never reach the browser');
});

test('admin UI is protected and exposes global account operations', () => {
  assert.match(adminGuard, /admin-api/);
  assert.match(adminGuard, /role === "admin" \|\| role === "super_admin"/);
  for (const action of ['create_user', 'set_plan', 'set_role', 'set_blocked', 'reset_password', 'delete_user']) {
    assert.match(adminPage, new RegExp(action));
  }
});

test('public endpoints are IP rate-limited', () => {
  const validatePost = read('supabase/functions/validate-post/index.ts');
  const sendContact = read('supabase/functions/send-contact/index.ts');
  const rlMigration = read('supabase/migrations/20260620010000_public_rate_limit.sql');
  assert.match(validatePost, /hitIpRateLimit\(/);
  assert.match(sendContact, /hitIpRateLimit\(/);
  assert.match(rlMigration, /CREATE OR REPLACE FUNCTION public\.hit_ip_rate_limit/);
  assert.match(rlMigration, /pg_advisory_xact_lock/);
});

test('password change re-authenticates with the current password', () => {
  const account = read('src/components/AccountSettings.tsx');
  assert.match(account, /signInWithPassword\(/);
  assert.match(account, /currentPassword/);
  // re-auth must happen before updateUser
  assert.ok(
    account.indexOf('signInWithPassword') < account.indexOf('updateUser'),
    'must re-authenticate before changing the password',
  );
});

test('email validation requires an explicit click (no auto-validate on load)', () => {
  const validatePage = read('src/pages/ValidatePost.tsx');
  // No useEffect-driven validation on mount.
  assert.equal(validatePage.includes('useEffect'), false);
  assert.match(validatePage, /status === "confirm"/);
  assert.match(validatePage, /onClick=\{validate\}/);
});

test('AI comment auto-reply is gated to the Enterprise plan (server-side)', () => {
  const sync = read('supabase/functions/sync-comments/index.ts');
  const planMig = read('supabase/migrations/20260623000000_user_plan.sql');
  // The executor checks the plan, not just the enabled flag.
  assert.match(sync, /AUTO_REPLY_PLANS/);
  assert.match(sync, /enterprise/);
  assert.match(sync, /canAutoReply/);
  // Both provider paths use the gate; the bare auto_reply_enabled check is gone.
  assert.equal(/if \(profile && \(profile as any\)\.auto_reply_enabled\)/.test(sync), false);
  assert.equal((sync.match(/canAutoReply\(profile as any\)/g) || []).length, 2);
  // The plan column exists and is protected from client self-upgrade.
  assert.match(planMig, /ADD COLUMN IF NOT EXISTS plan/);
  assert.match(planMig, /guard_profile_plan/);
  assert.match(planMig, /current_user IN \('authenticated', 'anon'\)/);
  // The UI locks the toggle for non-Enterprise users.
  const commentsUi = read('src/pages/Comments.tsx');
  assert.match(commentsUi, /isEnterprise/);
  assert.match(commentsUi, /isEnterprise \? autoReply : false/);
});

test('free-beta monthly usage caps exist for text and image generation', () => {
  assert.match(genContent, /MONTHLY_LIMIT_MAX/);
  assert.match(genContent, /Limite mensuelle/);
  assert.match(genImage, /IMAGE_MONTHLY_MAX/);
});

test('TikTok is gated as "coming soon" in the platform pickers', () => {
  for (const p of ['src/pages/Profile.tsx', 'src/pages/Onboarding.tsx', 'src/components/SettingsDialog.tsx']) {
    const src = read(p);
    assert.match(src, /id: 'TikTok', comingSoon: true/);
    assert.match(src, /disabled=\{comingSoon\}/);
  }
});

// =====================================================================
// Senior audit, 2026-08-18
// =====================================================================

test('poster status URLs are pinned to the configured Graphiste origin', () => {
  // The poll is sent with `Authorization: Bearer GRAPHISTE_GPT_API_KEY`, and the
  // status URL used to come straight from a request body / a user-writable
  // posts column — pointing it at any host handed out the poster API key.
  const statusUrls = read('supabase/functions/_shared/graphisteStatusUrls.ts');
  assert.match(statusUrls, /export function isAllowedStatusUrl/);
  assert.match(statusUrls, /candidate\.origin === base\.origin/);
  assert.match(statusUrls, /candidate\.protocol !== "https:"/);
  // Both callers go through the shared builder; neither keeps a local copy.
  for (const p of [
    'supabase/functions/generate-image/index.ts',
    'supabase/functions/_shared/graphiste.ts',
  ]) {
    const src = read(p);
    assert.match(src, /posterStatusCandidates/);
    assert.equal(
      /function (graphisteStatusCandidates|statusCandidates)\(/.test(src),
      false,
      `${p} must not rebuild poll URLs locally`,
    );
  }
});

test('founder bootstrap is one-time and cannot be claimed by a fresh signup', () => {
  // Production runs with mailer_autoconfirm, so matching the founder email is
  // an unverified claim. The promotion must additionally require that no
  // super_admin exists yet, which closes the path once the owner is set up.
  assert.match(adminApi, /async function hasSuperAdmin/);
  assert.match(adminApi, /if \(!\(await hasSuperAdmin\(admin\)\)\)/);
  // Fails closed: an error listing users must not be read as "un-bootstrapped".
  assert.match(adminApi, /if \(error\) return true;/);
  // The owner address is configurable rather than only hardcoded...
  assert.match(adminApi, /ADMIN_FOUNDER_EMAIL/);
  // ...and is no longer shipped in the public browser bundle.
  const auth = read('src/pages/Auth.tsx');
  assert.equal(/c1domefa@gmail\.com/.test(auth), false,
    'the owner address must not be routed on client-side');
});

test('client signup/reset password minimum matches the server-side minimum (8)', () => {
  const auth = read('src/pages/Auth.tsx');
  const reset = read('src/pages/ResetPassword.tsx');
  assert.match(auth, /MIN_PASSWORD_LENGTH = 8/);
  assert.match(auth, /password\.length < MIN_PASSWORD_LENGTH/);
  assert.equal(/minLength=\{6\}/.test(auth), false);
  assert.equal(/minLength=\{6\}/.test(reset), false);
  assert.match(reset, /password\.length < 8/);
  // admin-api already required 8; keep the two in step.
  assert.match(adminApi, /body\.password\.length < 8/);
});

test('server-owned columns are not writable from the browser', () => {
  const mig = read('supabase/migrations/20260818000000_lock_server_owned_columns.sql');
  // profile_key spoofing => publishing through someone else's provider profile.
  assert.match(mig, /REVOKE INSERT ON public\.social_connections FROM authenticated, anon;/);
  assert.match(mig, /guard_post_server_columns/);
  assert.match(mig, /SET search_path = public, pg_temp/);
  // Every publisher-owned column is pinned to its stored value on UPDATE.
  for (const col of [
    'image_job_id',
    'image_status_url',
    'provider_post_id',
    'external_post_ids',
    'validation_token',
    'validation_token_used_at',
    'published_at',
    'auto_publish_attempted_at',
  ]) {
    assert.match(
      mig,
      new RegExp(`NEW\\.${col}\\s+:= OLD\\.${col};`),
      `${col} must be pinned on UPDATE`,
    );
  }
  // A row mid-publish is frozen, so a client cannot re-queue it and double-post.
  assert.match(mig, /OLD\.status = 'publishing'/);
  assert.match(mig, /RAISE EXCEPTION/);
  // And the migration is actually applied by the deploy workflow — this repo
  // applies migrations by explicit name, so an unlisted file never ships.
  assert.match(deployWorkflow, /20260818000000_lock_server_owned_columns\.sql/);
});

test('every user-influenced image fetch goes through the SSRF guard', () => {
  for (const p of [
    'supabase/functions/publish-post/index.ts',
    'supabase/functions/generate-image/index.ts',
    'supabase/functions/_shared/postiz.ts',
    'supabase/functions/_shared/graphiste.ts',
  ]) {
    const src = read(p);
    assert.match(src, /fetchImageBytes/, `${p} must use the guarded fetch`);
    assert.equal(
      /await fetch\(imageUrl\)/.test(src),
      false,
      `${p} still fetches a user-influenced image URL unguarded`,
    );
  }
});

test('internal errors are logged, not returned to the caller', () => {
  assert.match(cors, /export function internalError/);
  assert.match(cors, /Une erreur interne est survenue/);
  const userFacing = [
    'admin-api', 'comment-reply', 'delete-account', 'export-account-data',
    'sync-comments', 'postiz-connect', 'ayrshare-connect', 'ayrshare-status',
    'validate-post', 'generate-image', 'publish-post', 'generate-content',
  ];
  for (const fn of userFacing) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /internalError\(/, `${fn} must use the shared handler`);
  }
  // The cron-only entry points keep detailed errors: their caller is the
  // operator holding CRON_SECRET, not an end user.
  assert.match(validationEmail, /error instanceof Error \? error\.message/);
});

test('cron shared secret is compared in constant time', () => {
  const rateLimit = read('supabase/functions/_shared/rateLimit.ts');
  assert.match(rateLimit, /export function timingSafeEqual/);
  for (const fn of ['auto-generate-weekly', 'send-validation-email', 'publish-post', 'sync-comments']) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.match(src, /timingSafeEqual\(/, `${fn} must not use === on the cron secret`);
    assert.equal(
      /headerCron === cronSecret|provided !== expectedSecret/.test(src),
      false,
      `${fn} still compares the cron secret directly`,
    );
  }
});

test('third-party web snippets are neutralised before entering the LLM prompt', () => {
  // Search results are attacker-authorable and the generated post is published
  // to the user's real accounts, sometimes with no human in the loop.
  const research = read('supabase/functions/_shared/research.ts');
  assert.match(research, /export function sanitizeResearchText/);
  assert.match(research, /INJECTION_PATTERNS/);
  // Newlines are collapsed so a snippet cannot forge a new prompt section.
  assert.match(research, /replace\(\/\[\\r\\n\\t\]\+\/g, " "\)/);
  // Title, snippet and source all go through the sanitiser.
  assert.match(research, /title: sanitizeResearchText\(r\.title/);
  assert.match(research, /snippet: sanitizeResearchText\(r\.snippet/);
  assert.match(research, /source: sanitizeResearchText\(r\.source/);
  // The block tells the model the lines are data, not instructions.
  assert.match(research, /jamais des instructions/);
});

test('the dashboard does not mutate React-owned DOM on image load failure', () => {
  const dashboard = read('src/pages/Dashboard.tsx');
  assert.equal(
    /wrap\.innerHTML/.test(dashboard),
    false,
    'replacing innerHTML destroys nodes React still owns and crashes the next render',
  );
  assert.match(dashboard, /brokenImageUrls/);
});
