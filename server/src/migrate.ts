import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./lib/db.js";

// Migration runner.
//
// Applies every file in migrations/ in filename order, inside a transaction,
// and records what it applied. Re-running is safe twice over: applied files
// are skipped by the ledger, and each file is itself idempotent — so a
// database that already carries some objects (the existing deployment)
// converges rather than failing.
//
// Two things a real migration on a populated database needs, and that this
// runner therefore does:
//
//   * It PRINTS the database's own NOTICE/WARNING output. 0000 reports what
//     it found and repaired that way (accounts without an address, passwords
//     that must be reset, rows it could not attach). Swallowing those lines
//     would turn a migration with caveats into one that looks perfect.
//
//   * It can REHEARSE. `--dry-run` applies every pending migration in one
//     transaction and then rolls it back, so a restored copy of production
//     answers "would this work?" without being changed and without the ledger
//     being written.

// dist/src/migrate.js → up two levels to the package root, where
// migrations/ lives. The SQL is not compiled, so it is read from source.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const dryRun = process.argv.includes("--dry-run") || process.env.MIGRATE_DRY_RUN === "1";

async function main(): Promise<void> {
  const client = await pool.connect();

  // The server's own reports. `notice` carries NOTICE, WARNING and the rest;
  // the severity is kept so a warning does not read like a progress line.
  client.on("notice", (msg) => {
    const severity = msg.severity ?? "NOTICE";
    const text = [msg.message, msg.detail, msg.hint].filter(Boolean).join(" | ");
    console.log(`  [${severity}] ${text}`);
  });

  try {
    if (dryRun) {
      console.log("DRY RUN — every pending migration is applied and then rolled back.\n");
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>(`SELECT filename FROM schema_migrations`))
        .rows.map((r) => r.filename),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const pending = files.filter((f) => !applied.has(f));
    for (const file of files) {
      if (applied.has(file)) console.log(`skip     ${file} (already applied)`);
    }

    if (pending.length === 0) {
      console.log("Schema already up to date.");
      return;
    }

    if (dryRun) {
      // One transaction for the whole rehearsal: a later migration that
      // depends on an earlier one still sees it, and the ROLLBACK at the end
      // undoes everything — including the ledger rows.
      await client.query("BEGIN");
      try {
        for (const file of pending) {
          console.log(`would apply  ${file}`);
          await client.query(await readFile(join(migrationsDir, file), "utf8"));
          await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        }
        console.log(`\nDRY RUN OK — ${pending.length} migration(s) would apply cleanly.`);
      } catch (err) {
        console.error(`DRY RUN FAILED: ${(err as Error).message}`);
        throw err;
      } finally {
        // Always. A rehearsal that committed would be a deployment.
        await client.query("ROLLBACK");
        console.log("Rolled back: the database is unchanged.");
      }
      return;
    }

    let count = 0;
    for (const file of pending) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      // One transaction per file: a migration either lands completely or not
      // at all, so a failure never leaves the schema half-changed.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        console.log(`applied  ${file}`);
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`FAILED   ${file}: ${(err as Error).message}`);
        throw err;
      }
    }

    console.log(count === 0 ? "Schema already up to date." : `Applied ${count} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
