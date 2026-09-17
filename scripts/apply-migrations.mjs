#!/usr/bin/env node
//
// Applies pending SQL migrations to the production Supabase Postgres database
// through the Management API, and records what it applied.
//
// Why this exists: the deploy workflow used to `curl` three migration files
// chosen by hand. Every migration added after those three was silently NEVER
// applied in production — the code shipped expecting columns that did not
// exist. Hardcoding was itself a fix for the opposite bug (blindly replaying
// every migration on each deploy, which is destructive for the non-idempotent
// early ones).
//
// This script fixes both: a ledger table records which files ran, migrations
// already live in production are seeded into it once (BASELINE below), and only
// genuinely new files are executed — in filename order, one statement batch per
// file, each recorded in the same transaction that runs it.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=... PROJECT_REF=... node scripts/apply-migrations.mjs [--dry-run]
//
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

// Migrations that were already applied to production before this script
// existed. They are recorded as applied on the first run and never re-executed.
// NEVER add to this list to skip a migration — add it only if you applied the
// file to production by hand.
const BASELINE_THROUGH = "20260723000000_poster_footer_text.sql";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.PROJECT_REF;
const dryRun = process.argv.includes("--dry-run");

if (!token || !projectRef) {
  console.error("SUPABASE_ACCESS_TOKEN and PROJECT_REF are required.");
  process.exit(1);
}

async function query(sql) {
  const resp = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Management API ${resp.status}: ${text.slice(0, 600)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    return;
  }

  // 1. Ledger table.
  await query(`
    CREATE TABLE IF NOT EXISTS public.ci_applied_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.ci_applied_migrations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.ci_applied_migrations FROM anon, authenticated;
  `);

  // 2. Seed the baseline once: everything up to BASELINE_THROUGH is already
  //    live in production, so record it without executing it.
  const baseline = files.filter((name) => name <= BASELINE_THROUGH);
  if (baseline.length > 0) {
    await query(
      `INSERT INTO public.ci_applied_migrations (filename) VALUES ${baseline
        .map((name) => `(${sqlLiteral(name)})`)
        .join(", ")} ON CONFLICT (filename) DO NOTHING;`,
    );
  }

  // 3. Work out what is left.
  const applied = new Set(
    ((await query("SELECT filename FROM public.ci_applied_migrations;")) || []).map(
      (row) => row.filename,
    ),
  );
  const pending = files.filter((name) => !applied.has(name));

  if (pending.length === 0) {
    console.log(`Schema is up to date (${applied.size} migration(s) recorded).`);
    return;
  }

  console.log(`Pending migration(s): ${pending.join(", ")}`);
  if (dryRun) {
    console.log("--dry-run: nothing was executed.");
    return;
  }

  // 4. Apply each one atomically with its ledger entry, so a failed migration
  //    is never recorded as applied.
  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    console.log(`Applying ${name}...`);
    await query(
      `BEGIN;\n${sql}\nINSERT INTO public.ci_applied_migrations (filename) VALUES (${sqlLiteral(
        name,
      )}) ON CONFLICT (filename) DO NOTHING;\nCOMMIT;`,
    );
    console.log(`Applied ${name}.`);
  }

  console.log(`Done: ${pending.length} migration(s) applied.`);
}

main().catch((err) => {
  console.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
