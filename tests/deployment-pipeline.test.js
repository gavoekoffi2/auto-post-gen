import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const workflow = read(".github/workflows/deploy-functions.yml");
const applyScript = read("scripts/apply-migrations.sh");
const verifyScript = read("scripts/verify-schema.sh");

// Everything up to this file was applied to production before the ledger
// existed; newer migrations are applied automatically and must stay re-runnable.
const BASELINE = "20260723000000_poster_footer_text.sql";

test("deploying applies EVERY pending migration, not a hand-picked list", () => {
  // One hardcoded step per migration meant a forgotten step shipped code that
  // queries columns production does not have.
  assert.doesNotMatch(workflow, /Apply the current editorial-mix migration/);
  assert.doesNotMatch(workflow, /Apply poster footer text migration/);
  assert.match(workflow, /run: \.\/scripts\/apply-migrations\.sh/);
  assert.match(workflow, /run: \.\/scripts\/verify-schema\.sh/);
  // Migrations must be applied before the functions that depend on them.
  assert.ok(
    workflow.indexOf("apply-migrations.sh") < workflow.indexOf("supabase functions deploy"),
  );
});

test("the migration ledger never replays the non-idempotent legacy migrations", () => {
  assert.match(applyScript, /CREATE TABLE IF NOT EXISTS public\.schema_migrations_applied/);
  assert.match(applyScript, /MIGRATION_BASELINE:-20260723000000_poster_footer_text\.sql/);
  assert.match(applyScript, /ON CONFLICT \(name\) DO NOTHING/);
  // Deterministic ordering whatever the runner locale.
  assert.match(applyScript, /export LC_ALL=C/);
});

test("the deploy fails loudly when production lacks a column the code reads", () => {
  for (const column of [
    "profiles:use_poster_person_image",
    "profiles:poster_person_image_url",
    "profiles:auto_generate_enabled",
    "posts:image_job_id",
    "posts:validation_token_created_at",
  ]) {
    assert.ok(verifyScript.includes(`"${column}"`), `verify-schema.sh must check ${column}`);
  }
  assert.match(verifyScript, /Production schema is missing/);
  assert.match(verifyScript, /exit 1/);
});

test("every migration applied by the pipeline is safe to re-run", () => {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const recent = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && name > BASELINE)
    .sort();
  assert.ok(recent.length > 0, "no migration newer than the baseline");

  for (const name of recent) {
    const sql = readFileSync(new URL(name, dir), "utf8");
    for (const [pattern, guard] of [
      [/ADD COLUMN(?! IF NOT EXISTS)/i, "ADD COLUMN IF NOT EXISTS"],
      [/CREATE TABLE(?! IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS"],
      [/CREATE INDEX(?! IF NOT EXISTS)/i, "CREATE INDEX IF NOT EXISTS"],
    ]) {
      assert.doesNotMatch(sql, pattern, `${name} must use ${guard} (the pipeline re-runs nothing, but a retry must be safe)`);
    }
    // A constraint is added only after dropping the previous version.
    const constraintAdds = (sql.match(/ADD CONSTRAINT/gi) || []).length;
    const constraintDrops = (sql.match(/DROP CONSTRAINT IF EXISTS/gi) || []).length;
    assert.ok(
      constraintDrops >= constraintAdds,
      `${name}: each ADD CONSTRAINT needs a matching DROP CONSTRAINT IF EXISTS`,
    );
  }
});
