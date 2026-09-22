import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

test("the validation link actually expires", () => {
  const migration = read("supabase/migrations/20260922000000_validation_token_expiry.sql");
  const validate = read("supabase/functions/validate-post/index.ts");

  // posts.validation_token has always had a default, but
  // validation_token_created_at had none — so it was NULL on every new post
  // and validate-post skipped the TTL entirely. Those links never expired.
  assert.match(migration, /ALTER COLUMN validation_token_created_at SET DEFAULT now\(\)/);
  assert.match(migration, /SET validation_token_created_at = created_at/);

  // The lifetime runs from when the email was sent, so a link cannot expire
  // before it reaches the person it was sent to.
  assert.match(validate, /validation_email_sent_at \|\| post\.validation_token_created_at/);
  assert.match(validate, /TOKEN_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
});

test("validation errors are shown to the user in French, unwrapped", () => {
  const validate = read("supabase/functions/validate-post/index.ts");
  const ui = read("src/pages/ValidatePost.tsx");

  for (const english of ["Token expired", "Token already used", "Invalid token", "cannot be validated via email link"]) {
    assert.doesNotMatch(validate, new RegExp(english), `"${english}" reaches a French-only UI`);
  }
  assert.match(validate, /Ce lien de validation a expiré/);
  // Otherwise the user only ever sees "non-2xx status code".
  assert.match(ui, /functionErrorMessage\(error/);
});

test("deleting an account empties its folder in the PUBLIC bucket", () => {
  const del = read("supabase/functions/delete-account/index.ts");
  // A single list() caps at 1000 objects; anything left stays downloadable by
  // URL after the account is gone.
  assert.match(del, /for \(let page = 0/);
  assert.match(del, /\.remove\(paths\)/);
  assert.match(del, /if \(removeError\) throw removeError/);
});

test("uploads name objects from the verified MIME type, not the user's filename", () => {
  const helpers = read("src/lib/userAssets.ts");
  assert.match(helpers, /export function buildAssetPath/);
  assert.match(helpers, /assetExtension\(mimeType\)/);
  // SVG can carry script and must never be accepted into a public bucket.
  assert.doesNotMatch(helpers, /image\/svg/);

  for (const file of [
    "src/components/LogoUpload.tsx",
    "src/components/CustomImageLibrary.tsx",
    "src/components/SettingsDialog.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /buildAssetPath\(/, `${file} must build its object key from the MIME type`);
    assert.doesNotMatch(
      source,
      /file\.name\.split\(['"]\.['"]\)\.pop\(\)/,
      `${file} must not derive the extension from the user's filename`,
    );
  }
});

test("replacing or removing an image deletes the object it replaced", () => {
  // The bucket is public: an orphan stays reachable by URL forever.
  for (const file of [
    "src/components/LogoUpload.tsx",
    "src/components/CustomImageLibrary.tsx",
    "src/components/SettingsDialog.tsx",
  ]) {
    assert.match(read(file), /deleteAssetByUrl\(/, `${file} must clean up the previous object`);
  }
});

test("one password policy applies everywhere a password is set", () => {
  const policy = read("src/lib/password.ts");
  assert.match(policy, /MIN_PASSWORD_LENGTH = 8/);

  for (const file of ["src/pages/Auth.tsx", "src/pages/ResetPassword.tsx", "src/components/AccountSettings.tsx"]) {
    const source = read(file);
    assert.match(source, /validatePassword\(/, `${file} must use the shared policy`);
    assert.doesNotMatch(source, /length < 6/, `${file} still enforces the old 6-character minimum`);
  }

  // Enforced by the auth service too, not only in the browser.
  assert.match(read(".github/workflows/deploy-functions.yml"), /password_min_length: 8/);
});

test("the support address has a single source of truth", () => {
  assert.match(read("src/lib/appConfig.ts"), /VITE_SUPPORT_EMAIL/);
  for (const file of ["src/pages/Contact.tsx", "src/pages/Privacy.tsx", "src/pages/Terms.tsx"]) {
    const source = read(file);
    assert.match(source, /SUPPORT_EMAIL/, `${file} must read the shared address`);
    assert.doesNotMatch(source, /contact@prosocialai\.com/, `${file} still hardcodes the address`);
  }
});
