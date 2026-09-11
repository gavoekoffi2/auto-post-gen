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

// dist/src/migrate.js → up two levels to the package root, where
// migrations/ lives. The SQL is not compiled, so it is read from source.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
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
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip     ${file} (already applied)`);
        continue;
      }
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
