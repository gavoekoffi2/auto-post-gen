import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateImageFile, MAX_IMAGE_BYTES } from '../src/lib/imageUpload.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Minimal File stand-in: the validator only reads type, size and name.
const fakeFile = (type, size = 1024, name = 'x') => ({ type, size, name });

test('SVG uploads are rejected', () => {
  // Every other stage of the poster pipeline refuses SVG, and an SVG is an
  // executable document. Accepting it here let a user store a logo that the
  // renderer would then reject.
  assert.match(validateImageFile(fakeFile('image/svg+xml')).error, /SVG/);
  assert.match(validateImageFile(fakeFile('image/svg')).error, /SVG/);
});

test('the extension comes from the MIME type, never from the filename', () => {
  // `file.name.split(".").pop()` returned the whole name for an extension-less
  // file ("logo" -> "…/logo-123.logo") and let the user pick the extension.
  assert.equal(validateImageFile(fakeFile('image/png', 10, 'no-extension')).extension, 'png');
  assert.equal(validateImageFile(fakeFile('image/jpeg', 10, 'a.PNG')).extension, 'jpg');
  assert.equal(validateImageFile(fakeFile('image/webp', 10, '../../evil')).extension, 'webp');
});

test('only formats the app can actually render are accepted', () => {
  for (const [mime, ext] of [
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/avif', 'avif'],
  ]) {
    const result = validateImageFile(fakeFile(mime));
    assert.equal(result.error, null, `${mime} should be accepted`);
    assert.equal(result.extension, ext);
  }
  assert.ok(validateImageFile(fakeFile('image/tiff')).error);
  assert.ok(validateImageFile(fakeFile('application/pdf')).error);
  assert.ok(validateImageFile(fakeFile('')).error);
});

test('size limits are enforced at both ends', () => {
  assert.equal(validateImageFile(fakeFile('image/png', MAX_IMAGE_BYTES)).error, null);
  assert.match(validateImageFile(fakeFile('image/png', MAX_IMAGE_BYTES + 1)).error, /5 Mo/);
  assert.match(validateImageFile(fakeFile('image/png', 0)).error, /vide/);
});

test('all four upload sites share the validator', () => {
  // The logic was duplicated in four places with three slightly different
  // behaviours; a fix in one never reached the others.
  for (const path of [
    'src/components/LogoUpload.tsx',
    'src/components/CustomImageLibrary.tsx',
    'src/components/SettingsDialog.tsx',
  ]) {
    const source = read(path);
    assert.match(source, /validateImageFile\(/, `${path} must use the shared validator`);
    assert.doesNotMatch(source, /file\.name\.split\(/, `${path} must not trust the filename`);
    assert.doesNotMatch(source, /file\.type\.startsWith\("image\/"\)/, `${path} has a stale check`);
  }
});

test('uploads declare their real content type', () => {
  // Without contentType the CDN can serve the object as application/octet-stream,
  // which breaks <img> rendering and the Graphiste logo fetch.
  for (const path of [
    'src/components/LogoUpload.tsx',
    'src/components/CustomImageLibrary.tsx',
    'src/components/SettingsDialog.tsx',
  ]) {
    assert.match(read(path), /contentType: file\.type/, `${path} must set contentType`);
  }
});

test('TypeScript strict mode is enabled', () => {
  // It was off, so nullable Supabase columns typed as `| undefined` never
  // failed to compile and discriminated unions did not narrow.
  const app = JSON.parse(read('tsconfig.app.json'));
  assert.equal(app.compilerOptions.strict, true);
  assert.equal(app.compilerOptions.noFallthroughCasesInSwitch, true);
  assert.ok(!('noImplicitAny' in app.compilerOptions), 'noImplicitAny:false would undo strict');

  const root = JSON.parse(read('tsconfig.json'));
  assert.equal(root.compilerOptions.strict, true);
  assert.ok(!('strictNullChecks' in root.compilerOptions));
  assert.ok(!('noImplicitAny' in root.compilerOptions));
});
