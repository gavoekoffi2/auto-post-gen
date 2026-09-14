import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Static gates on the deployment artefacts.
//
// The behavioural migration tests live in server/tests/legacy-migration.test.ts
// and need a database. These need nothing, run in the repository's own suite,
// and pin the properties that make a migration safe to run against a
// PRODUCTION database with real accounts in it.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migrationsDir = new URL("../server/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

/** Strips SQL comments so a rule is not matched inside prose. */
function sqlOnly(text) {
  return text
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

test("no migration can destroy data", () => {
  for (const file of migrations) {
    const sql = sqlOnly(readFileSync(new URL(file, migrationsDir), "utf8"));
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, `${file} must never DROP TABLE`);
    assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/i, `${file} must never DROP COLUMN`);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `${file} must never TRUNCATE`);
    assert.doesNotMatch(sql, /\bDROP\s+DATABASE\b/i, `${file} must never DROP DATABASE`);
    assert.doesNotMatch(sql, /\bDROP\s+SCHEMA\b/i, `${file} must never DROP SCHEMA`);
    // Renaming is what turns a rollback into data loss: the previous image
    // queries a column that no longer answers to that name.
    assert.doesNotMatch(sql, /\bRENAME\s+(COLUMN|TO)\b/i, `${file} must never rename an existing object`);
    // A DELETE against a user table. (0000 deletes nothing at all; the quota
    // helper's DELETE lives inside a function body in 0001 and is scoped to a
    // single reservation row, which is why the check is for bare DELETE FROM
    // on the account tables.)
    assert.doesNotMatch(
      sql,
      /\bDELETE\s+FROM\s+(public\.)?(profiles|users|posts|media_assets|social_connections|audit_log)\b/i,
      `${file} must never delete user rows`,
    );
  }
});

test("the legacy compatibility migration runs before the schema it repairs", () => {
  // 0001 aborts on the legacy shape, so a repair numbered after it could never
  // run. Filename order is what the runner applies.
  const compat = migrations.find((f) => f.includes("legacy_production_compat"));
  assert.ok(compat, "the legacy compatibility migration must exist");
  assert.ok(
    compat < "0001_core_schema.sql",
    `${compat} must sort before 0001_core_schema.sql`,
  );
  assert.equal(migrations[0], compat, "it must be the first migration applied");
});

test("the compatibility migration refuses rather than guesses", () => {
  const sql = read("server/migrations/0000_legacy_production_compat.sql");
  // Every refusal names what is wrong and what to do about it.
  assert.match(sql, /cannot determine where the account email lives/);
  assert.match(sql, /shared by more than one profile/);
  assert.match(sql, /primary keys are not uuid/);
  assert.match(sql, /still rejects a normal write from the API/);
  for (const clause of ["MESSAGE =", "DETAIL  =", "HINT    ="]) {
    assert.ok(sql.includes(clause), `refusals must carry ${clause.trim()}`);
  }
  // It adds columns, never replaces tables.
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
  assert.doesNotMatch(sqlOnly(sql), /CREATE TABLE(?! IF NOT EXISTS)/i);
});

test("the migration runner shows the database's own warnings and can rehearse", () => {
  const runner = read("server/src/migrate.ts");
  // A migration with caveats (accounts that must reset their password, rows it
  // could not attach) must not look like a clean one.
  assert.match(runner, /client\.on\("notice"/);
  assert.match(runner, /msg\.severity/);
  // A rehearsal on a restored copy answers "would this work?" without writing.
  assert.match(runner, /--dry-run/);
  assert.match(runner, /await client\.query\("ROLLBACK"\)/);

  const pkg = JSON.parse(read("server/package.json"));
  assert.ok(pkg.scripts["migrate:dry-run"], "npm run migrate:dry-run must exist");
});

test("the production stack keeps Postgres private and routes /api to the API", () => {
  const compose = read("deploy/docker-compose.vps.yml");
  const nginx = read("nginx.vps.conf");

  // Every service restarts with the host, except the one-shot migration.
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /profiles: \["migrate"\]/);
  assert.match(compose, /restart: "no"/);

  // The database is on the internal network only: no `ports:` mapping anywhere
  // in the postgres service. Comments are stripped first — the service carries
  // a comment explaining why there is no mapping, which is not one.
  const postgresBlock = compose
    .slice(compose.indexOf("  postgres:"), compose.indexOf("  api:"))
    .replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(postgresBlock, /ports:/, "PostgreSQL must never be published on the host");

  // Persistence: the media volume the VPS already has, and the database volume.
  assert.match(compose, /pro-social-ai_media/);
  assert.match(compose, /pro-social-ai_pgdata/);

  // Traefik on the shared `web` network, no host 80/443 binding of our own.
  assert.match(compose, /traefik\.enable=true/);
  const networksBlock = compose.slice(compose.indexOf("\nnetworks:")).replace(/^\s*#.*$/gm, "");
  assert.match(networksBlock, /web:\s*\n\s+external: true/, "`web` must be the reverse proxy's existing network");
  assert.doesNotMatch(compose, /"(80|443):(80|443)"/, "Traefik owns the host ports");

  // /api is proxied to the API container; everything else falls back to the
  // SPA, so /login survives a refresh.
  assert.match(nginx, /location = \/api \{/);
  assert.match(nginx, /location \/api\/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/api:8080;/);
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/);
});

test("the database password never travels inside a URL in the compose file", () => {
  const compose = read("deploy/docker-compose.vps.yml").replace(/^\s*#.*$/gm, "");

  // A URL assembled here would put the password into the resolved
  // configuration, where `docker compose config` prints or masks it — and a
  // mask there is indistinguishable from a literal `***` in the file, which is
  // how a working deployment gets reported as broken. It is also silently
  // wrong for a password containing @ : / ? #.
  assert.doesNotMatch(
    compose,
    /DATABASE_URL:\s*postgres:\/\//,
    "the connection must be passed as parts, not as an interpolated URL",
  );

  // Both the API and the one-shot migration must reach the same database the
  // same way, or a migration lands somewhere the API never reads.
  for (const service of ["api", "migrate"]) {
    const start = compose.indexOf(`\n  ${service}:`);
    assert.ok(start > 0, `${service} must exist`);
    // Up to the next top-level service: a line indented by exactly two spaces.
    const rest = compose.slice(start + service.length + 4);
    const nextService = rest.search(/\n {2}[a-z_-]+:/);
    const block = nextService === -1 ? rest : rest.slice(0, nextService);
    for (const key of ["PGHOST:", "PGUSER:", "PGPASSWORD:", "PGDATABASE:"]) {
      assert.ok(block.includes(key), `${service} must receive ${key}`);
    }
    assert.match(block, /PGPASSWORD: \$\{POSTGRES_PASSWORD\}/,
      `${service} must take the password from the env file, never a literal`);
  }

  // And the server knows how to assemble them.
  const env = read("server/src/lib/env.ts");
  assert.match(env, /encodeURIComponent/);
  assert.match(env, /PGPASSWORD/);
  assert.match(env, /optional\("DATABASE_URL"\)/, "DATABASE_URL must still work outside Compose");
});

test("no real secret is committed anywhere in the deployment files", () => {
  for (const path of ["deploy/docker-compose.vps.yml", ".env.selfhosted.example", "HERMES_VPS_RELEASE.md"]) {
    // Compose substitutions are removed first: `${POSTGRES_PASSWORD:?set ...}`
    // is a variable reference and its error text is not a value.
    const text = read(path).replace(/\$\{[^}]*\}/g, "${VAR}");
    // Every remaining value must be an obvious placeholder.
    // [ \t]* rather than \s*: a newline must not be skipped, or an empty
    // `OPENROUTER_API_KEY=` reads as if it carried the NEXT line's value.
    const suspicious = text.match(/(PASSWORD|SECRET|API_KEY)[ \t]*[:=][ \t]*([^\s#]+)/g) || [];
    for (const line of suspicious) {
      assert.match(
        line,
        /replace-me|placeholder|fake|example|changeme|<|\.\.\.|\$\{/i,
        `possible real secret committed: ${line}`,
      );
    }
  }
});

test("the frontend has no cloud backend left in it", () => {
  const api = read("src/lib/api.ts");
  assert.doesNotMatch(api, /supabase/i);
  // Same-origin, cookie-based: no configurable API host, no bearer token.
  assert.match(api, /credentials: "include"/);
  assert.doesNotMatch(api, /VITE_SUPABASE/);

  const nginx = read("nginx.vps.conf");
  assert.match(nginx, /connect-src 'self'/, "the CSP must not reopen a cloud channel");
  assert.doesNotMatch(nginx, /supabase\.co/);
});
