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
