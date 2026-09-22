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
// existed. They are recorded as applied on the first run and never executed.
//
// This is an explicit LIST, not a "everything up to this filename" threshold.
// With a threshold, a migration added later but named with an earlier
// timestamp — a backdated file, or a rebase that reorders work — would be
// silently classified as already-applied and never run, and the first sign of
// it would be production code querying a column that does not exist.
//
// NEVER add a filename here to make a deploy pass. Add one only when you have
// applied that exact file to production by hand.
const BASELINE = new Set([
  "20251101103554_95b6170a-789f-4bb8-8ef5-709cbf4b93b4.sql",
  "20251103064444_2b238250-0ff8-4b81-b462-a8cfef3ee595.sql",
  "20251103070400_134d2ecc-aa74-4f38-9bc3-0fa7a920c47d.sql",
  "20251106073142_ad99d5d1-1073-4b68-8012-07804f61a3b2.sql",
  "20251107225010_484163d9-4009-45f6-9220-45cf49bc0346.sql",
  "20251108085617_fa99f632-4f23-4e41-b85b-49c4711cf5e6.sql",
  "20251203152440_1f15767a-410b-441e-b5d4-046b55308120.sql",
  "20251204080803_b5d1ce96-86c2-4ef5-9686-22ba379aa3f0.sql",
  "20251205153332_aba7442a-99cf-481c-9966-85c2926a95a6.sql",
  "20251207223633_e59cac22-7547-44d9-ac7a-796816b2be52.sql",
  "20260520000000_audit_fixes_and_oauth.sql",
  "20260520000100_production_hardening.sql",
  "20260520000200_brand_identity.sql",
  "20260520000300_style_lib_and_ayrshare.sql",
  "20260603000000_engagement_inbox.sql",
  "20260603010000_zernio_provider.sql",
  "20260616000000_security_hardening_rls.sql",
  "20260619000000_scheduling_time_and_promo.sql",
  "20260619010000_auto_post_images.sql",
  "20260620000000_senior_audit_hardening.sql",
  "20260620010000_public_rate_limit.sql",
  "20260623000000_user_plan.sql",
  "20260721000000_editorial_mix.sql",
  "20260722000000_target_audiences.sql",
  "20260723000000_poster_footer_text.sql",
]);

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

  // 2. Every baseline file must still exist: a missing one means the list and
  //    the repository have diverged, and we would rather stop than guess.
  const missing = [...BASELINE].filter((name) => !files.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Baseline migrations missing from supabase/migrations: ${missing.join(", ")}`,
    );
  }

  // 3. Seed the baseline once: these are already live in production, so they
  //    are recorded without being executed.
  const baseline = files.filter((name) => BASELINE.has(name));
  if (baseline.length > 0) {
    await query(
      `INSERT INTO public.ci_applied_migrations (filename) VALUES ${baseline
        .map((name) => `(${sqlLiteral(name)})`)
        .join(", ")} ON CONFLICT (filename) DO NOTHING;`,
    );
  }

  // 4. Work out what is left.
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

  // 5. Apply each one atomically with its ledger entry, so a failed migration
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
