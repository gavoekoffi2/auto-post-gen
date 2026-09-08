import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const DOCS = ['README.md', 'docs/HANDOVER.md', 'DEPLOYMENT.md'];

test('the docs point at the Supabase project the pipeline actually deploys to', () => {
  // The docs still named the OLD project (ixinojsmymqovekgkbdg) long after the
  // move, so anyone following them would have deployed to the wrong database.
  const workflow = read('.github/workflows/deploy-functions.yml');
  const ref = workflow.match(/PROJECT_REF:\s*(\S+)/)?.[1];
  assert.ok(ref, 'the deploy workflow must declare PROJECT_REF');

  const config = read('supabase/config.toml');
  assert.ok(
    config.includes(`project_id = "${ref}"`),
    'supabase/config.toml must match the deploy workflow',
  );

  for (const doc of DOCS) {
    const text = read(doc);
    for (const match of text.matchAll(/--project-ref\s+(\S+)/g)) {
      assert.equal(match[1], ref, `${doc} names a stale project ref`);
    }
    assert.ok(
      !text.includes('ixinojsmymqovekgkbdg'),
      `${doc} still references the retired Supabase project`,
    );
  }
});

test('the documented edge-function count matches reality', () => {
  const actual = readdirSync(new URL('../supabase/functions', import.meta.url), {
    withFileTypes: true,
  }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).length;

  for (const doc of DOCS) {
    for (const match of read(doc).matchAll(/(\d+)\s+Edge Functions/gi)) {
      assert.equal(Number(match[1]), actual, `${doc} claims the wrong function count`);
    }
    for (const match of read(doc).matchAll(/Edge Functions \((\d+)\)/g)) {
      assert.equal(Number(match[1]), actual, `${doc} claims the wrong function count`);
    }
  }
});

test('the docs tell contributors to typecheck, since the build does not', () => {
  // `npm run build` is vite, which strips types without checking them. Three
  // type errors reached main precisely because the docs listed only lint+build.
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.typecheck, 'a typecheck script must exist');
  for (const doc of ['README.md', 'docs/HANDOVER.md']) {
    assert.match(read(doc), /npm run typecheck/, `${doc} must document the typecheck step`);
  }
  assert.match(read('.github/workflows/ci.yml'), /npm run typecheck/);
});
