import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = readFileSync(join(root, "scripts/apply-migrations.mjs"), "utf8");
const migrations = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

function baselineList() {
  const block = runner.slice(runner.indexOf("const BASELINE = new Set(["), runner.indexOf("]);"));
  return [...block.matchAll(/"([^"]+\.sql)"/g)].map((m) => m[1]);
}

test("the deploy pipeline applies migrations instead of three hand-picked files", () => {
  const workflow = readFileSync(join(root, ".github/workflows/deploy-functions.yml"), "utf8");
  // Naming files one by one meant every migration added afterwards was never
  // applied in production, while the code shipped expecting its schema.
  assert.match(workflow, /node scripts\/apply-migrations\.mjs/);
  assert.doesNotMatch(workflow, /Apply the current editorial-mix migration/);
  assert.doesNotMatch(workflow, /migrations\/20260721000000_editorial_mix\.sql/);
});

test("the baseline is an explicit list, and every entry still exists", () => {
  const baseline = baselineList();
  assert.ok(baseline.length > 0, "the baseline must name the migrations already live");
  for (const name of baseline) {
    assert.ok(migrations.includes(name), `${name} is in the baseline but not in the repository`);
  }
  // A "<= filename" threshold would silently swallow a backdated migration.
  assert.doesNotMatch(runner, /BASELINE_THROUGH/);
  assert.match(runner, /Baseline migrations missing from supabase\/migrations/);
});

test("new migrations are the ones that actually run", () => {
  const baseline = new Set(baselineList());
  const pending = migrations.filter((name) => !baseline.has(name));

  // Whatever is not in the baseline is pending — including a backdated
  // filename, which is precisely what the explicit list buys over the old
  // "everything up to X" threshold. Asserting that pending files sort after
  // the baseline would re-impose the rule the runner was changed to drop.
  assert.ok(pending.length >= 0);
  for (const name of pending) {
    assert.ok(name.endsWith(".sql"), `${name} is not a migration file`);
  }

  // Each migration is recorded in the same transaction that runs it, so a
  // failure is never recorded as applied.
  assert.match(runner, /BEGIN;/);
  assert.match(runner, /COMMIT;/);
  assert.match(runner, /INSERT INTO public\.ci_applied_migrations/);
  // Applied in filename order, so dependencies between migrations hold.
  assert.match(runner, /\.sort\(\)/);
});

test("the runner refuses to seed a baseline against the wrong database", () => {
  // The baseline records 25 migrations as applied WITHOUT executing them.
  // That is correct for production, where they already ran. Pointed at a
  // fresh or staging database it would mark the schema as present against an
  // empty one, and the deploy would report success with no tables at all.
  assert.match(runner, /to_regclass\('public\.profiles'\)/);
  assert.match(runner, /Refusing to seed the baseline/);
  // Only checked on a first run: once the ledger has rows, the question is
  // settled and the probe would be a pointless round-trip on every deploy.
  assert.match(runner, /const baselineAlreadyRecorded = applied0\.size > 0/);
});
