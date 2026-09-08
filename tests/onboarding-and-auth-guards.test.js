import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const auth = read('src/pages/Auth.tsx');
const onboarding = read('src/pages/Onboarding.tsx');
const admin = read('src/pages/Admin.tsx');
const adminApi = read('supabase/functions/admin-api/index.ts');
const detectAudiences = read('supabase/functions/detect-audiences/index.ts');

test('signup requires a confirmed password so a typo cannot lock a user out', () => {
  assert.match(auth, /confirmPassword/);
  assert.match(auth, /Les deux mots de passe ne correspondent pas/);
  assert.match(auth, /id="signup-password-confirm"/);
});

test('the signup password minimum is stricter than Supabase’s 6-character default', () => {
  const declared = auth.match(/const MIN_PASSWORD_LENGTH = (\d+);/);
  assert.ok(declared, 'MIN_PASSWORD_LENGTH must be declared');
  assert.ok(Number(declared[1]) >= 8, 'accounts hold social tokens; require 8+');
  // The literal 6 must be gone from the form.
  assert.doesNotMatch(auth, /minLength=\{6\}/);
});

test('no owner email is shipped in the client bundle', () => {
  // Routing and the admin UI used to hardcode the founder address, publishing
  // it to every visitor. The rule now lives server-side only.
  for (const [name, source] of [['Auth.tsx', auth], ['Admin.tsx', admin]]) {
    assert.doesNotMatch(source, /@gmail\.com/, `${name} must not embed a personal email`);
  }
  assert.match(admin, /user\.protected/);
  assert.match(adminApi, /protected: isFounder\(user\)/);
});

test('admin-api still enforces owner protection server-side', () => {
  // The client flag is a UI affordance only; these are the real guards.
  assert.match(adminApi, /targetIsFounder && body\.role !== "super_admin"/);
  assert.match(adminApi, /if \(targetIsFounder \|\| targetId === actor\.id\)/);
});

test('onboarding gates the description at the same length detect-audiences requires', () => {
  const clientMin = onboarding.match(/const MIN_DESCRIPTION_LENGTH = (\d+);/);
  assert.ok(clientMin, 'MIN_DESCRIPTION_LENGTH must be declared');
  const serverMin = detectAudiences.match(/description\.length < (\d+)/);
  assert.ok(serverMin, 'detect-audiences must state its minimum');
  assert.equal(
    Number(clientMin[1]),
    Number(serverMin[1]),
    'a client threshold below the server one lets the user submit into a refusal',
  );
  assert.match(onboarding, /formData\.description\.trim\(\)\.length >= MIN_DESCRIPTION_LENGTH/);
});

test('editing the description re-runs the audience analysis instead of keeping stale targets', () => {
  assert.match(onboarding, /analyzedFrom/);
  assert.match(onboarding, /analyzedFrom !== audienceInputsKey/);
});
