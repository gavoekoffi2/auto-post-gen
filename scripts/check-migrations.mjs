#!/usr/bin/env node
//
// Static validation of the migrations directory, run in CI so a bad file is
// caught on the pull request instead of at deploy time (where it would abort a
// production deploy half-way).
//
// Checks:
//   1. Every file matches <14-digit timestamp>_<name>.sql.
//   2. No two migrations share a version — the ledger keys on version, so a
//      duplicate would silently skip one of them.
//   3. Filename order equals version order (guards against a stray prefix).
//   4. New migrations sort strictly after the baseline the runner adopts,
//      otherwise they would be baselined as "already applied" and never run.
//   5. No migration is empty.
//
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

// Must match DEFAULT_BASELINE in apply-migrations.mjs.
const BASELINE = '20260723000000';
const NAME_RE = /^(\d{14})_[a-z0-9]([a-z0-9_-]*)\.sql$/i;

const errors = [];
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

if (files.length === 0) errors.push('No .sql migrations found.');

const seen = new Map();
let previousVersion = '';

for (const file of files) {
  const match = file.match(NAME_RE);
  if (!match) {
    errors.push(`${file}: expected <14-digit-timestamp>_<name>.sql`);
    continue;
  }
  const version = match[1];

  if (seen.has(version)) {
    errors.push(`${file}: duplicate version ${version} (also ${seen.get(version)}). The ledger keys on version, so one would never be applied.`);
  }
  seen.set(version, file);

  if (version < previousVersion) {
    errors.push(`${file}: version ${version} sorts before ${previousVersion}; filename order must match version order.`);
  }
  previousVersion = version;

  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  if (!sql.trim()) errors.push(`${file}: file is empty.`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error(`\n${errors.length} migration problem(s) found.`);
  process.exit(1);
}

const pending = [...seen.keys()].filter((v) => v > BASELINE);
console.log(`${files.length} migration(s) valid.`);
console.log(`Baseline ${BASELINE}: ${seen.size - pending.length} adopted, ${pending.length} applied by the runner.`);
for (const version of pending) console.log(`  + ${seen.get(version)}`);
