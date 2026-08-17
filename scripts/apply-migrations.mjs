#!/usr/bin/env node
//
// Apply pending Supabase migrations, exactly once each.
//
// History: the deploy workflow used to `for`-loop over every .sql file on each
// run, replaying the whole directory against production. That was removed
// (commit 773383e) and replaced with hand-written steps naming three specific
// migrations — so from then on ANY new migration was silently never applied.
// Both failure modes come from the same missing piece: a ledger of what has
// already run.
//
// This script keeps that ledger in public.applied_migrations and applies only
// what is missing, in filename order, recording each one as it succeeds.
//
// BASELINE: the migrations that predate this ledger are already live in
// production. On the very first run (empty ledger) everything up to and
// including MIGRATION_BASELINE is recorded as applied WITHOUT being executed,
// so nothing is replayed. Later migrations are applied normally.
//
// Checksums are stored so that editing an already-applied migration is caught
// instead of silently diverging from what production actually ran.
//
// Env:
//   SUPABASE_ACCESS_TOKEN  required — Supabase Management API token
//   PROJECT_REF            required — Supabase project ref
//   MIGRATION_BASELINE     optional — last version considered already applied
//   DRY_RUN=1              optional — report the plan, change nothing
//
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

// Last migration that was applied to production by the old hand-written deploy
// steps. Anything at or below this is baselined, never re-executed.
const DEFAULT_BASELINE = '20260723000000';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.PROJECT_REF;
const BASELINE = process.env.MIGRATION_BASELINE || DEFAULT_BASELINE;
const DRY_RUN = process.env.DRY_RUN === '1';

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS public.applied_migrations (
  version     text PRIMARY KEY,
  name        text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  baselined   boolean NOT NULL DEFAULT false
);
ALTER TABLE public.applied_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.applied_migrations FROM anon, authenticated;
`;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// Management API query endpoint — the same one the workflow already used, so
// this needs no credential the deploy did not already have.
async function runSql(sql, { attempts = 3 } = {}) {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      });
      const text = await resp.text();
      if (!resp.ok) {
        // 4xx is a real SQL/permission error: retrying cannot help.
        if (resp.status >= 400 && resp.status < 500) {
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 800)}`);
        }
        lastError = new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
      } else {
        try {
          return JSON.parse(text);
        } catch {
          return [];
        }
      }
    } catch (err) {
      if (String(err.message).startsWith('HTTP 4')) throw err;
      lastError = err;
    }
    if (attempt < attempts) {
      const backoff = 2000 * 2 ** (attempt - 1);
      console.log(`  retrying in ${backoff}ms (${lastError.message})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      return {
        file,
        // Leading timestamp is the version; the rest is a human label.
        version: (file.match(/^(\d+)/) || [null, file])[1],
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    });
}

async function main() {
  if (!TOKEN) fail('SUPABASE_ACCESS_TOKEN is not set.');
  if (!PROJECT_REF) fail('PROJECT_REF is not set.');

  const migrations = loadMigrations();
  if (migrations.length === 0) fail(`No migrations found in ${MIGRATIONS_DIR}`);
  console.log(`Found ${migrations.length} migration file(s). Baseline: ${BASELINE}`);

  await runSql(LEDGER_DDL);

  const rows = await runSql(
    'SELECT version, checksum, baselined FROM public.applied_migrations;',
  );
  const applied = new Map((rows || []).map((r) => [r.version, r]));
  console.log(`Ledger currently records ${applied.size} applied migration(s).`);

  // First run: adopt the existing production schema instead of replaying it.
  if (applied.size === 0) {
    const toBaseline = migrations.filter((m) => m.version <= BASELINE);
    if (toBaseline.length > 0) {
      console.log(`Baselining ${toBaseline.length} migration(s) already live in production:`);
      for (const m of toBaseline) console.log(`  = ${m.file}`);
      if (!DRY_RUN) {
        const values = toBaseline
          .map((m) => `(${sqlLiteral(m.version)}, ${sqlLiteral(m.file)}, ${sqlLiteral(m.checksum)}, true)`)
          .join(',\n    ');
        await runSql(
          `INSERT INTO public.applied_migrations (version, name, checksum, baselined)
           VALUES\n    ${values}
           ON CONFLICT (version) DO NOTHING;`,
        );
      }
      for (const m of toBaseline) applied.set(m.version, { version: m.version, checksum: m.checksum, baselined: true });
    }
  }

  // An already-applied migration whose content changed means the repo no longer
  // describes what production ran. Stop rather than paper over the divergence.
  const drifted = migrations.filter(
    (m) => applied.has(m.version) && applied.get(m.version).checksum !== m.checksum,
  );
  if (drifted.length > 0) {
    for (const m of drifted) {
      console.error(`::error::${m.file} was modified after it was applied.`);
    }
    fail(
      'Edit history diverged from production. Write a NEW migration instead of ' +
        'editing an applied one (or update the ledger checksum deliberately).',
    );
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    console.log('Everything is already applied. Nothing to do.');
    return;
  }

  console.log(`Applying ${pending.length} pending migration(s):`);
  for (const m of pending) console.log(`  + ${m.file}`);
  if (DRY_RUN) {
    console.log('DRY_RUN=1 — stopping before any change.');
    return;
  }

  for (const m of pending) {
    console.log(`Applying ${m.file}...`);
    try {
      await runSql(m.sql);
    } catch (err) {
      fail(`${m.file} failed to apply: ${err.message}`);
    }
    await runSql(
      `INSERT INTO public.applied_migrations (version, name, checksum, baselined)
       VALUES (${sqlLiteral(m.version)}, ${sqlLiteral(m.file)}, ${sqlLiteral(m.checksum)}, false)
       ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();`,
    );
    console.log(`  ok ${m.file}`);
  }
  console.log(`Applied ${pending.length} migration(s).`);
}

main().catch((err) => fail(err.stack || err.message));
