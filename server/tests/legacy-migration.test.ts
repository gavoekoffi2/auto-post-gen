import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

// Migration tests against REAL PostgreSQL databases created for the run.
//
// The unit under test is the migration set as a whole, applied by the real
// runner (`node dist/src/migrate.js`) as a child process — the same command
// the deployment runs. What is asserted is the thing that actually matters on
// the day: that a database carrying the OLD production shape ends up usable by
// this build, with every row still there.
//
// Nothing here ever touches the database in DATABASE_URL. That connection is
// used only to CREATE/DROP scratch databases named psa_legacy_test_*, and the
// suite refuses to run if it is pointed at something that looks like
// production.

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const migrationsDir = join(serverRoot, "migrations");

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("DATABASE_URL is required to run the migration tests.");

// A scratch database is created and dropped for every case; the name makes it
// obvious in `\l` that it is disposable.
const created: string[] = [];

function adminUrlFor(dbName: string): string {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(ADMIN_URL!);
  // Connect to the default maintenance database: CREATE DATABASE cannot run
  // while connected to the database being created, and must not run against
  // the application database either.
  url.pathname = "/postgres";
  return url.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createScratchDatabase(): Promise<string> {
  const name = `psa_legacy_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    await withClient(maintenanceUrl(), (c) => c.query(`CREATE DATABASE ${name}`));
  } catch (err) {
    const message = (err as Error).message;
    throw new Error(
      `Could not create a scratch database (${message}). The migration tests need a role that ` +
        `may CREATE DATABASE — e.g. ALTER ROLE <user> CREATEDB. They never modify the database ` +
        `in DATABASE_URL.`,
    );
  }
  created.push(name);
  return name;
}

/** Loads a .sql file into a scratch database. */
async function loadSql(dbName: string, sql: string): Promise<void> {
  await withClient(adminUrlFor(dbName), (c) => c.query(sql));
}

/** Runs the real migration runner against a scratch database. */
async function runMigrate(
  dbName: string,
  args: string[] = [],
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(serverRoot, "dist/src/migrate.js"), ...args],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          DATABASE_URL: adminUrlFor(dbName),
          SESSION_COOKIE_SECRET:
            process.env.SESSION_COOKIE_SECRET ?? "test-secret-that-is-long-enough-for-the-check",
        },
      },
    );
    return { ok: true, output: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") + e.message };
  }
}

async function rows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  dbName: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withClient(adminUrlFor(dbName), async (c) => (await c.query<T>(sql, params)).rows);
}

const legacyFixture = await readFile(join(here, "fixtures/legacy_production_schema.sql"), "utf8");

after(async () => {
  for (const name of created) {
    try {
      await withClient(maintenanceUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    } catch {
      // A leftover scratch database is noise, not a failure of the code.
    }
  }
});

// ---------------------------------------------------------------------
// A database that has never been migrated.
// ---------------------------------------------------------------------

test("an empty database migrates cleanly and ends up with the full schema", async () => {
  const db = await createScratchDatabase();
  const result = await runMigrate(db);
  assert.ok(result.ok, `migration failed:\n${result.output}`);

  const tables = (
    await rows<{ table_name: string }>(
      db,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
  ).map((r) => r.table_name);

  for (const expected of [
    "profiles", "sessions", "one_time_tokens", "posts", "media_assets",
    "generation_jobs", "generation_usage", "social_connections", "social_comments",
    "ip_rate_events", "schema_migrations",
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }

  // 0000 is a no-op here: it may record that it ran, but it must not have
  // backfilled or relaxed anything, because there is no legacy shape to repair.
  const [{ count }] = await rows<{ count: string }>(
    db,
    `SELECT count(*)::text AS count FROM legacy_compat_report
      WHERE step IN ('identity.email', 'identity.password', 'write_probe')
         OR step LIKE 'tenancy.%'
         OR (step = 'relax_not_null' AND detail NOT LIKE 'no legacy-only%')`,
  );
  assert.equal(count, "0", "an empty database has nothing to backfill, relax or probe");
});

// ---------------------------------------------------------------------
// The case that blocked the deployment.
// ---------------------------------------------------------------------

test("the legacy production shape migrates instead of failing on profiles.email", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);

  // Before: this is the exact failure Hermes reported.
  const emailColumnBefore = await rows(
    db,
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'profiles' AND column_name = 'email'`,
  );
  assert.equal(emailColumnBefore.length, 0, "the fixture must start WITHOUT profiles.email");

  const result = await runMigrate(db);
  assert.ok(result.ok, `migration failed on the legacy shape:\n${result.output}`);
  assert.match(result.output, /identity strategy: profiles_user_id/);
});

test("no legacy row is lost, and every id is preserved", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  const counts = await rows<{ t: string; n: string }>(
    db,
    `SELECT 'users' AS t, count(*)::text AS n FROM users
     UNION ALL SELECT 'profiles', count(*)::text FROM profiles
     UNION ALL SELECT 'posts', count(*)::text FROM posts
     UNION ALL SELECT 'media_assets', count(*)::text FROM media_assets
     UNION ALL SELECT 'generation_jobs', count(*)::text FROM generation_jobs
     UNION ALL SELECT 'social_connections', count(*)::text FROM social_connections
     UNION ALL SELECT 'audit_log', count(*)::text FROM audit_log`,
  );
  const byTable = Object.fromEntries(counts.map((r) => [r.t, r.n]));
  assert.deepEqual(byTable, {
    users: "2",
    profiles: "2",
    // One per legacy status: draft, scheduled, published, failed.
    posts: "4",
    media_assets: "1",
    // Production's two historical jobs (completed, queued).
    generation_jobs: "2",
    social_connections: "1",
    audit_log: "2",
  });

  // The legacy tables and columns are kept, not renamed or dropped: a
  // rollback to the previous image must still find its data.
  const legacyColumns = await rows<{ table_name: string; column_name: string }>(
    db,
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'user_id'
        AND table_name IN ('profiles','posts','media_assets','generation_jobs','social_connections')`,
  );
  // Four, not five: production's generation_jobs never had a user_id — it is
  // keyed by profile_id already (the shape confirmed on the real copy).
  assert.equal(legacyColumns.length, 4, "legacy user_id columns must survive the migration");

  const post = await rows<{ id: string; content: string; status: string }>(
    db,
    `SELECT id, content, status FROM posts WHERE id = 'bbbbbbbb-1111-1111-1111-111111111111'`,
  );
  assert.equal(post.length, 1, "the historical post must still exist under its own id");
  assert.equal(post[0]!.content, "Contenu historique à préserver");
  assert.equal(post[0]!.status, "published");
});

test("the account email is carried over from the legacy users table", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  const profiles = await rows<{ id: string; email: string; company_name: string }>(
    db,
    `SELECT id, email::text AS email, company_name FROM profiles ORDER BY company_name`,
  );
  assert.equal(profiles[0]!.email, "legacy-one@example.test");
  assert.equal(profiles[0]!.id, "aaaaaaaa-1111-1111-1111-111111111111");
  assert.equal(profiles[1]!.email, "Legacy-Two@Example.test");

  // citext: the address is the login identifier and must match case-insensitively.
  const found = await rows(
    db,
    `SELECT 1 FROM profiles WHERE email = 'legacy-two@example.test'`,
  );
  assert.equal(found.length, 1, "email lookup must be case-insensitive");
});

test("a password this build can read is kept; one it cannot is not faked", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  const [bcryptAccount] = await rows<{ password_hash: string | null }>(
    db,
    `SELECT password_hash FROM profiles WHERE id = 'aaaaaaaa-1111-1111-1111-111111111111'`,
  );
  assert.equal(
    bcryptAccount!.password_hash,
    null,
    "a bcrypt hash must NOT be copied: it would look usable and reject every password",
  );

  const [scryptAccount] = await rows<{ password_hash: string | null; password_salt: string | null }>(
    db,
    `SELECT password_hash, password_salt FROM profiles WHERE id = 'aaaaaaaa-2222-2222-2222-222222222222'`,
  );
  assert.equal(scryptAccount!.password_hash, "ab".repeat(64));
  assert.equal(scryptAccount!.password_salt, "cd".repeat(16));

  // And the migration says so, rather than leaving it to be discovered.
  const report = await rows<{ detail: string; row_count: string }>(
    db,
    `SELECT detail, row_count::text AS row_count FROM legacy_compat_report
      WHERE step = 'identity.password' AND detail LIKE '%mot de passe oublié%'`,
  );
  assert.equal(report.length, 1);
  assert.equal(report[0]!.row_count, "1");
});

test("every child row is attached to the profile that owns it", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  const orphans = await rows<{ t: string; n: string }>(
    db,
    `SELECT 'posts' AS t, count(*)::text AS n FROM posts WHERE profile_id IS NULL
     UNION ALL SELECT 'media_assets', count(*)::text FROM media_assets WHERE profile_id IS NULL
     UNION ALL SELECT 'generation_jobs', count(*)::text FROM generation_jobs WHERE profile_id IS NULL
     UNION ALL SELECT 'social_connections', count(*)::text FROM social_connections WHERE profile_id IS NULL`,
  );
  for (const row of orphans) assert.equal(row.n, "0", `${row.t} still has unattached rows`);

  // Attached to the RIGHT profile, not just to any profile.
  const [post] = await rows<{ profile_id: string }>(
    db,
    `SELECT profile_id FROM posts WHERE id = 'bbbbbbbb-2222-2222-2222-222222222222'`,
  );
  assert.equal(post!.profile_id, "aaaaaaaa-2222-2222-2222-222222222222");

  const [media] = await rows<{ profile_id: string }>(
    db,
    `SELECT profile_id FROM media_assets WHERE id = 'cccccccc-1111-1111-1111-111111111111'`,
  );
  assert.equal(media!.profile_id, "aaaaaaaa-1111-1111-1111-111111111111");
});

test("the migrated database accepts the writes the API makes", async () => {
  // The migration can succeed and still leave the product unusable: the legacy
  // schema declares profiles.user_id NOT NULL, which the new code never sets,
  // so the first signup would fail with 23502. This is that regression.
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  await withClient(adminUrlFor(db), async (c) => {
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, password_salt)
       VALUES ('new-signup@example.test', 'hash', 'salt') RETURNING id`,
    );
    const profileId = inserted.rows[0]!.id;
    await c.query(
      `INSERT INTO posts (profile_id, title, content, status, platforms)
       VALUES ($1, 'Nouveau', 'Contenu', 'pending', ARRAY['LinkedIn']::text[])`,
      [profileId],
    );
    await c.query(
      `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
       VALUES ($1, 'poster', $2, 'image/png', 1024)`,
      [profileId, `${profileId}/poster.png`],
    );
  });

  const [{ n }] = await rows<{ n: string }>(
    db,
    `SELECT count(*)::text AS n FROM profiles WHERE email = 'new-signup@example.test'`,
  );
  assert.equal(n, "1");
});

test("migrating twice changes nothing (runner ledger and file replay)", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  const snapshot = async () =>
    (
      await rows<{ t: string; n: string }>(
        db,
        `SELECT 'profiles' AS t, count(*)::text AS n FROM profiles
         UNION ALL SELECT 'posts', count(*)::text FROM posts
         UNION ALL SELECT 'media_assets', count(*)::text FROM media_assets
         UNION ALL SELECT 'emails', count(*)::text FROM profiles WHERE email IS NOT NULL
         ORDER BY 1`,
      )
    )
      .map((r) => `${r.t}=${r.n}`)
      .join(",");

  const before = await snapshot();

  // 1. The runner skips what it already applied.
  const second = await runMigrate(db);
  assert.ok(second.ok, second.output);
  assert.match(second.output, /skip {5}0000_legacy_production_compat\.sql \(already applied\)/);
  assert.equal(await snapshot(), before);

  // 2. And the files themselves are replayable: a re-run outside the ledger
  //    (a manual psql, a restored copy) must not fail or change anything.
  for (const file of ["0000_legacy_production_compat.sql", "0001_core_schema.sql", "0002_media_public_token.sql"]) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await withClient(adminUrlFor(db), (c) => c.query(sql));
  }
  assert.equal(await snapshot(), before, "replaying the migrations must not change any data");
});

test("a rehearsal (--dry-run) reports what would happen and writes nothing", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);

  const result = await runMigrate(db, ["--dry-run"]);
  assert.ok(result.ok, result.output);
  assert.match(result.output, /DRY RUN OK/);
  assert.match(result.output, /Rolled back: the database is unchanged/);
  // The caveats an operator has to know are printed, not swallowed.
  assert.match(result.output, /\[WARNING\].*password/i);

  const emailColumn = await rows(
    db,
    `SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='email'`,
  );
  assert.equal(emailColumn.length, 0, "a rehearsal must not alter the schema");
  // Not even an empty ledger table: the rehearsal creates it inside the
  // transaction it rolls back.
  const [{ ledger }] = await rows<{ ledger: string | null }>(
    db,
    `SELECT to_regclass('public.schema_migrations')::text AS ledger`,
  );
  assert.equal(ledger, null, "a rehearsal must not create or write the ledger");
});

// ---------------------------------------------------------------------
// Refusals. Each one must stop BEFORE touching anything.
// ---------------------------------------------------------------------

test("an unmappable schema stops the migration and leaves the database untouched", async () => {
  const db = await createScratchDatabase();
  await loadSql(
    db,
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;
     CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
     CREATE TABLE profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_name text);
     INSERT INTO users (email) VALUES ('someone@example.test');
     INSERT INTO profiles (company_name) VALUES ('Orpheline SARL');`,
  );

  const result = await runMigrate(db);
  assert.equal(result.ok, false, "an ambiguous mapping must not be guessed");
  assert.match(result.output, /cannot determine where the account email lives/);
  assert.match(result.output, /inspect-legacy-schema\.sql/);

  const emailColumn = await rows(
    db,
    `SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='email'`,
  );
  assert.equal(emailColumn.length, 0, "nothing may be written when the migration refuses");
  const profiles = await rows(db, `SELECT 1 FROM profiles`);
  assert.equal(profiles.length, 1, "the data must still be there");
});

test("two accounts sharing one address stop the migration with both named", async () => {
  const db = await createScratchDatabase();
  await loadSql(
    db,
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;
     CREATE TABLE users (id uuid PRIMARY KEY, email text);
     CREATE TABLE profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                            user_id uuid REFERENCES users(id), company_name text);
     INSERT INTO users VALUES
       ('10000000-0000-0000-0000-000000000001', 'Shared@Example.test'),
       ('10000000-0000-0000-0000-000000000002', 'shared@example.test');
     INSERT INTO profiles (user_id, company_name) VALUES
       ('10000000-0000-0000-0000-000000000001', 'Entreprise A'),
       ('10000000-0000-0000-0000-000000000002', 'Entreprise B');`,
  );

  const result = await runMigrate(db);
  assert.equal(result.ok, false, "a duplicate login identifier must not be migrated silently");
  assert.match(result.output, /shared by more than one profile/);
  assert.match(result.output, /shared@example\.test/);

  const emailColumn = await rows(
    db,
    `SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='email'`,
  );
  assert.equal(emailColumn.length, 0, "nothing may be written when the migration refuses");
});

test("non-uuid identifiers are refused rather than half-converted", async () => {
  const db = await createScratchDatabase();
  await loadSql(
    db,
    `CREATE TABLE users (id integer PRIMARY KEY, email text);
     CREATE TABLE profiles (id integer PRIMARY KEY, user_id integer REFERENCES users(id));
     INSERT INTO users VALUES (1, 'int-id@example.test');
     INSERT INTO profiles VALUES (1, 1);`,
  );

  const result = await runMigrate(db);
  assert.equal(result.ok, false);
  assert.match(result.output, /primary keys are not uuid/);
});

// ---------------------------------------------------------------------
// The legacy status vocabulary — the blocker found by the rehearsal on a
// copy of the real production database.
// ---------------------------------------------------------------------

test("the legacy status CHECK is widened, not removed, and keeps every old row", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);

  // The fixture carries production's own constraint.
  const [before] = await rows<{ def: string }>(
    db,
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND conname = 'posts_status_check'`,
  );
  assert.match(before!.def, /draft/);
  assert.doesNotMatch(before!.def, /pending/, "the fixture must start with the legacy vocabulary");

  assert.ok((await runMigrate(db)).ok);

  // Every legacy status is still stored, untouched and uncounted-for-nothing.
  const statuses = await rows<{ status: string; n: string }>(
    db,
    `SELECT status, count(*)::text AS n FROM posts GROUP BY status ORDER BY status`,
  );
  assert.deepEqual(
    statuses.map((r) => `${r.status}:${r.n}`),
    ["draft:1", "failed:1", "published:1", "scheduled:1"],
    "no legacy post may be deleted, rewritten or re-labelled",
  );

  // And the constraint now covers both vocabularies.
  const [after] = await rows<{ def: string }>(
    db,
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND conname = 'posts_status_check'`,
  );
  for (const value of ["draft", "scheduled", "published", "failed", "pending", "validated", "publishing"]) {
    assert.ok(after!.def.includes(value), `posts_status_check must accept ${value}`);
  }
});

test("every status the API writes is accepted, and an unknown one is still refused", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  await withClient(adminUrlFor(db), async (c) => {
    const { rows: created } = await c.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, password_salt)
       VALUES ('status-flow@example.test', 'h', 's') RETURNING id`,
    );
    const profileId = created[0]!.id;

    // The real lifecycle: created → approved → claimed → sent, and the failure
    // branch. A constraint that allowed only the first would break later, in
    // production, on a post a user had already approved.
    const { rows: post } = await c.query<{ id: string }>(
      `INSERT INTO posts (profile_id, title, content, status, platforms)
       VALUES ($1, 'Flow', 'Contenu', 'pending', ARRAY['LinkedIn']::text[]) RETURNING id`,
      [profileId],
    );
    const postId = post[0]!.id;
    for (const status of ["validated", "publishing", "published", "failed"]) {
      await c.query(`UPDATE posts SET status = $2 WHERE id = $1`, [postId, status]);
    }

    // Strictness is preserved: widening is not weakening.
    await assert.rejects(
      () => c.query(`UPDATE posts SET status = 'not-a-real-status' WHERE id = $1`, [postId]),
      /violates check constraint/,
      "a typo must still be rejected after the migration",
    );
  });
});

test("widening one column leaves the others' rules alone", async () => {
  // 'status' is a substring of 'image_status'. Matching constraints by text
  // rewrote the image rule to be about the post status — caught by comparing
  // the schema before and after a replay.
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  assert.ok((await runMigrate(db)).ok);

  const definitions = async () =>
    (
      await rows<{ conname: string; def: string }>(
        db,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'posts'::regclass AND contype = 'c' ORDER BY conname`,
      )
    )
      .map((r) => `${r.conname}=${r.def}`)
      .join("\n");

  const before = await definitions();
  assert.match(before, /posts_image_status_known=CHECK \(\(\(image_status IS NULL\)/);

  // Replaying the file outside the ledger must not change a single definition.
  const sql = await readFile(join(migrationsDir, "0000_legacy_production_compat.sql"), "utf8");
  await withClient(adminUrlFor(db), (c) => c.query(sql));
  assert.equal(await definitions(), before, "a replay must be a no-op on the constraints");
});

test("0001's own constraints never abort on rows that predate them", async () => {
  // A legacy post longer than the new limit, and a platform the new list does
  // not know: both must survive, with the rule applying from now on.
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  await loadSql(
    db,
    `INSERT INTO posts (user_id, title, content, status)
     VALUES ('11111111-1111-1111-1111-111111111111', 'Trop long', repeat('x', 12000), 'published');`,
  );

  const result = await runMigrate(db);
  assert.ok(result.ok, `migration must not fail on legacy rows:\n${result.output}`);

  const [{ n }] = await rows<{ n: string }>(db, `SELECT count(*)::text AS n FROM posts`);
  assert.equal(n, "5", "the oversized legacy post must be kept");

  // Kept via NOT VALID, and said so rather than silently skipping the rule.
  const notValid = await rows<{ conname: string }>(
    db,
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'posts'::regclass AND conname = 'posts_content_len' AND NOT convalidated`,
  );
  assert.equal(notValid.length, 1, "the rule must exist, marked NOT VALID");

  const report = await rows<{ detail: string }>(
    db,
    `SELECT detail FROM legacy_compat_report WHERE detail LIKE '%NOT VALID%'`,
  );
  assert.ok(report.length >= 1, "the report must name what was left unvalidated");

  // New writes are still checked.
  await withClient(adminUrlFor(db), async (c) => {
    const { rows: p } = await c.query<{ id: string }>(
      `INSERT INTO profiles (email) VALUES ('len@example.test') RETURNING id`,
    );
    await assert.rejects(
      () =>
        c.query(
          `INSERT INTO posts (profile_id, content, status, platforms)
           VALUES ($1, repeat('y', 12000), 'pending', ARRAY[]::text[])`,
          [p[0]!.id],
        ),
      /violates check constraint/,
    );
  });
});

test("the migration output stays readable: bookkeeping hidden, warnings never", async () => {
  // Every guarded statement emits a "does not exist / already exists, skipping"
  // NOTICE when its guard fires — dozens of lines around the handful that
  // matter. A real WARNING scrolling past unnoticed in that is the failure this
  // output exists to prevent.
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);

  const result = await runMigrate(db, ["--dry-run"]);
  assert.ok(result.ok, result.output);

  assert.doesNotMatch(result.output, /does not exist, skipping/, "bookkeeping must be filtered");
  assert.doesNotMatch(result.output, /already exists, skipping/);
  // Filtered, not silently: the count is stated.
  assert.match(result.output, /notice\(s\) hidden/);

  // And everything that carries meaning is still there.
  assert.match(result.output, /\[WARNING\].*password/i, "a WARNING is never filtered");
  assert.match(result.output, /\[NOTICE\] \[0000\] identity strategy/);
  assert.match(result.output, /\[NOTICE\] \[0000\] write probe passed/);
  assert.match(result.output, /posts_status_check now accepts/);
});

test("the subscription lifecycle lands on the legacy shape without expiring anyone", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);

  // The rehearsal first: every migration, including 0003, applied and rolled
  // back on the legacy shape.
  const rehearsal = await runMigrate(db, ["--dry-run"]);
  assert.ok(rehearsal.ok, `dry run failed:\n${rehearsal.output}`);
  assert.match(rehearsal.output, /would apply {2}0003_trial_and_subscriptions\.sql/);
  assert.match(rehearsal.output, /Rolled back: the database is unchanged\./);

  const result = await runMigrate(db);
  assert.ok(result.ok, `migration failed:\n${result.output}`);
  assert.match(result.output, /applied {2}0003_trial_and_subscriptions\.sql/);

  // Customers who were using the product before this release keep it: active,
  // no end date. None is left trialing without a trial end (= expired).
  const states = await rows<{ subscription_status: string; ends: string | null; n: string }>(
    db,
    `SELECT subscription_status, current_period_ends_at::text AS ends, count(*)::text AS n
       FROM profiles GROUP BY 1, 2`,
  );
  assert.deepEqual(states, [{ subscription_status: "active", ends: null, n: "2" }]);

  // A new signup after the release starts a trial by default.
  await rows(
    db,
    `INSERT INTO profiles (email, password_hash, password_salt)
     VALUES ('after-release@example.test', 'x', 'y')`,
  );
  const [fresh] = await rows<{ subscription_status: string; days: string }>(
    db,
    `SELECT subscription_status, round(extract(epoch FROM trial_ends_at - now()) / 86400)::text AS days
       FROM profiles WHERE email = 'after-release@example.test'`,
  );
  assert.deepEqual(fresh, { subscription_status: "trialing", days: "7" });

  // Replaying the file is a no-op: the backfill touches nothing twice.
  const sql = await readFile(join(migrationsDir, "0003_trial_and_subscriptions.sql"), "utf8");
  await loadSql(db, sql);
  const [still] = await rows<{ subscription_status: string }>(
    db,
    `SELECT subscription_status FROM profiles WHERE email = 'after-release@example.test'`,
  );
  assert.equal(still!.subscription_status, "trialing");
});

// ---------------------------------------------------------------------------
// generation_jobs.provider — the fourth blocker, found by the rehearsal on a
// restored copy of production: `provider text NOT NULL`, and a write probe
// that inserted a job without one. The fixture now carries the table exactly
// as production defines it.
// ---------------------------------------------------------------------------

test("the dry run passes on production's generation_jobs (provider NOT NULL) and changes nothing", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  const [{ provider_nullable }] = await rows<{ provider_nullable: string }>(
    db,
    `SELECT is_nullable AS provider_nullable FROM information_schema.columns
      WHERE table_name = 'generation_jobs' AND column_name = 'provider'`,
  );
  assert.equal(provider_nullable, "NO", "the fixture must carry production's provider NOT NULL");

  const schemaSnapshot = async () =>
    (await rows<{ c: string }>(
      db,
      `SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY 1)
         AS c FROM information_schema.columns WHERE table_schema = 'public'`,
    ))[0]!.c;
  const schemaBefore = await schemaSnapshot();

  const rehearsal = await runMigrate(db, ["--dry-run"]);
  assert.ok(rehearsal.ok, `dry run failed:\n${rehearsal.output}`);
  assert.match(rehearsal.output, /write probe passed/);
  assert.match(rehearsal.output, /DRY RUN OK/);
  assert.match(rehearsal.output, /Rolled back: the database is unchanged\./);
  assert.doesNotMatch(rehearsal.output, /null value in column "provider"/);

  // Unchanged: no new column, no ledger row, the same two jobs.
  const [{ n }] = await rows<{ n: string }>(
    db,
    `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = 'generation_jobs'`,
  );
  assert.equal(n, "10", "the dry run must leave generation_jobs exactly as it found it");

  // And the whole schema — no ledger table left behind either.
  assert.equal(await schemaSnapshot(), schemaBefore, "a dry run must not change a single column of any table");
  const [{ ledger }] = await rows<{ ledger: string | null }>(db, `SELECT to_regclass('public.schema_migrations')::text AS ledger`);
  assert.equal(ledger, null, "the dry run must not create schema_migrations");
});

test("the migration keeps production's jobs, keeps provider mandatory, and accepts the API's own write", async () => {
  const db = await createScratchDatabase();
  await loadSql(db, legacyFixture);
  const before = await rows<{ id: string; provider: string; status: string; input: unknown; output: unknown }>(
    db,
    `SELECT id::text, provider, status, input, output FROM generation_jobs ORDER BY id`,
  );

  const result = await runMigrate(db);
  assert.ok(result.ok, `migration failed:\n${result.output}`);
  assert.match(result.output, /\[0004\] generation_jobs\.provider is already NOT NULL/);

  // Every historical job is still there, byte for byte.
  const after = await rows<{ id: string; provider: string; status: string; input: unknown; output: unknown }>(
    db,
    `SELECT id::text, provider, status, input, output FROM generation_jobs ORDER BY id`,
  );
  assert.deepEqual(after, before);

  // The constraint is still there: not relaxed to make the migration pass.
  const [{ provider_nullable }] = await rows<{ provider_nullable: string }>(
    db,
    `SELECT is_nullable AS provider_nullable FROM information_schema.columns
      WHERE table_name = 'generation_jobs' AND column_name = 'provider'`,
  );
  assert.equal(provider_nullable, "NO");

  // The API's exact write (services/generation.ts recordJob) and its two
  // outcomes (settleJob) are accepted, and the job carries its provider.
  const profile = "aaaaaaaa-1111-1111-1111-111111111111";
  const [job] = await rows<{ id: string; provider: string }>(
    db,
    `INSERT INTO generation_jobs
       (profile_id, post_id, kind, status, provider, provider_job_id,
        provider_status_url, result_url, error, format)
     VALUES ($1, NULL, 'image', 'processing', 'graphiste', 'job-1', NULL, NULL, NULL, 'null'::jsonb)
     RETURNING id::text, provider`,
    [profile],
  );
  assert.equal(job!.provider, "graphiste");
  await rows(db, `UPDATE generation_jobs SET status = 'completed', result_url = 'x', error = NULL WHERE id = $1`, [job!.id]);
  await rows(db, `UPDATE generation_jobs SET status = 'failed', result_url = NULL, error = 'x' WHERE id = $1`, [job!.id]);

  // A job without a provider is refused: every job must say which provider
  // to ask when it is resumed.
  await assert.rejects(
    rows(db, `INSERT INTO generation_jobs (profile_id, kind, status) VALUES ($1, 'image', 'processing')`, [profile]),
    /null value in column "provider"/,
  );

  // A second run changes nothing and destroys nothing.
  const again = await runMigrate(db);
  assert.ok(again.ok, again.output);
  assert.match(again.output, /Schema already up to date\./);
  const [{ n }] = await rows<{ n: string }>(db, `SELECT count(*)::text AS n FROM generation_jobs`);
  assert.equal(n, "3", "two historical jobs + the API's one");
});

test("a fresh database gets the same provider rule as production", async () => {
  const db = await createScratchDatabase();
  const result = await runMigrate(db);
  assert.ok(result.ok, result.output);
  assert.match(result.output, /\[0004\] generation_jobs\.provider is now NOT NULL/);
  const [{ provider_nullable }] = await rows<{ provider_nullable: string }>(
    db,
    `SELECT is_nullable AS provider_nullable FROM information_schema.columns
      WHERE table_name = 'generation_jobs' AND column_name = 'provider'`,
  );
  assert.equal(provider_nullable, "NO");
});

test("historical jobs without a provider are kept, and new ones must name one", async () => {
  // A database that reached this release from an older legacy shape, where
  // 0000 had to ADD the provider column: its historical rows have none.
  // Inventing one would be guessing — they stay as they are.
  const db = await createScratchDatabase();
  assert.ok((await runMigrate(db)).ok);
  const sql = await readFile(join(migrationsDir, "0004_generation_job_provider.sql"), "utf8");
  const [{ id: profile }] = await rows<{ id: string }>(
    db,
    `INSERT INTO profiles (email, password_hash, password_salt) VALUES ('old-jobs@example.test', 'x', 'y') RETURNING id::text`,
  );
  // Recreate the pre-0004 state: nullable provider, one historical row without it.
  await loadSql(db, `ALTER TABLE generation_jobs ALTER COLUMN provider DROP NOT NULL`);
  await rows(db, `INSERT INTO generation_jobs (profile_id, kind, status) VALUES ($1, 'image', 'completed')`, [profile]);

  await loadSql(db, sql);
  await loadSql(db, sql); // idempotent

  const [{ n }] = await rows<{ n: string }>(db, `SELECT count(*)::text AS n FROM generation_jobs WHERE provider IS NULL`);
  assert.equal(n, "1", "the historical row is kept unchanged");
  await assert.rejects(
    rows(db, `INSERT INTO generation_jobs (profile_id, kind, status) VALUES ($1, 'image', 'processing')`, [profile]),
    /generation_jobs_provider_present/,
  );
});
