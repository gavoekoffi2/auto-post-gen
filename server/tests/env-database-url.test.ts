import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "pg-connection-string";

// How the API is told which database to use.
//
// Compose passes the connection as PARTS (PGHOST/PGUSER/PGPASSWORD/...), not
// as a URL, for two reasons this file pins down:
//
//   * a URL assembled by string interpolation inside the compose file puts the
//     password into the resolved configuration, where `docker compose config`
//     then prints or masks it — and a mask in that output is indistinguishable
//     from a literal `***` in the file, which is how a working deployment gets
//     reported as broken;
//   * hand-built URLs are silently wrong for passwords containing @ : / ? #.
//
// env.ts is read once at import, so each case loads a fresh copy of the module.

let counter = 0;
async function loadEnv(vars: Record<string, string | undefined>) {
  for (const key of ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
  // A distinct URL per load: ESM caches modules by specifier.
  const mod = await import(`../dist/src/lib/env.js?case=${counter++}`);
  return mod.env as { databaseUrl: string };
}

test("DATABASE_URL is used as given when it is set", async () => {
  const env = await loadEnv({ DATABASE_URL: "postgres://someone:secret@db.example:6543/appdb" });
  assert.equal(env.databaseUrl, "postgres://someone:secret@db.example:6543/appdb");
});

test("DATABASE_URL wins over the parts, so nothing outside Compose changes", async () => {
  const env = await loadEnv({
    DATABASE_URL: "postgres://direct@db.example:5432/direct_db",
    PGHOST: "ignored",
    PGUSER: "ignored",
    PGDATABASE: "ignored",
  });
  assert.match(env.databaseUrl, /direct_db$/);
});

test("the parts are assembled into a valid connection string", async () => {
  const env = await loadEnv({
    PGHOST: "postgres",
    PGUSER: "pro_social_ai",
    PGPASSWORD: "simple-password",
    PGDATABASE: "pro_social_ai",
  });
  const parsed = parse(env.databaseUrl);
  assert.equal(parsed.host, "postgres");
  assert.equal(parsed.port, "5432", "PGPORT defaults to 5432");
  assert.equal(parsed.user, "pro_social_ai");
  assert.equal(parsed.password, "simple-password");
  assert.equal(parsed.database, "pro_social_ai");
});

test("a password containing URL syntax survives the round trip", async () => {
  // The exact class of bug an interpolated URL in YAML produces: the password
  // parses as host/port/path and the API fails to authenticate, pointing
  // nowhere near the cause.
  const password = "p@ss:w/rd#1?&=+";
  const env = await loadEnv({
    PGHOST: "postgres",
    PGUSER: "user@corp",
    PGPASSWORD: password,
    PGDATABASE: "pro_social_ai",
  });
  assert.doesNotMatch(
    env.databaseUrl.split("@").slice(-1)[0]!,
    /[:/]w/,
    "the password must not leak into the host part",
  );
  const parsed = parse(env.databaseUrl);
  assert.equal(parsed.password, password);
  assert.equal(parsed.user, "user@corp");
  assert.equal(parsed.host, "postgres");
  assert.equal(parsed.database, "pro_social_ai");
});

test("a non-default port is honoured", async () => {
  const env = await loadEnv({
    PGHOST: "db",
    PGPORT: "6432",
    PGUSER: "u",
    PGPASSWORD: "p",
    PGDATABASE: "d",
  });
  assert.equal(parse(env.databaseUrl).port, "6432");
});

test("a passwordless connection (peer/trust auth) is still expressible", async () => {
  const env = await loadEnv({ PGHOST: "db", PGUSER: "u", PGDATABASE: "d" });
  const parsed = parse(env.databaseUrl);
  assert.equal(parsed.user, "u");
  assert.ok(!parsed.password, "no password means no empty credentials section");
});

test("missing configuration fails at boot, naming both ways to supply it", async () => {
  await assert.rejects(
    () => loadEnv({}),
    (err: Error) => {
      assert.match(err.message, /DATABASE_URL/);
      assert.match(err.message, /PGHOST/);
      assert.match(err.message, /PGDATABASE/);
      return true;
    },
    "an API that starts without a database would only fail at the first request",
  );
});
