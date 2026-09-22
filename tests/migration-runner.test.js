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
  // Everything added after the baseline must be left for the runner to apply.
  for (const name of pending) {
    assert.ok(name > [...baseline].sort().pop(), `${name} sorts before the baseline and would never run`);
  }
  // Each migration is recorded in the same transaction that runs it, so a
  // failure is never recorded as applied.
  assert.match(runner, /BEGIN;/);
  assert.match(runner, /COMMIT;/);
  assert.match(runner, /INSERT INTO public\.ci_applied_migrations/);
});
