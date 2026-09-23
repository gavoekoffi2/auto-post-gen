import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Design decisions from the pre-release audit. Behaviour is tested against a
// real Postgres in server/tests/audit-fixes.test.ts; these pin the shape so a
// later edit cannot quietly undo one.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("scheduled dates are shown and edited in local time, never as a UTC date", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.doesNotMatch(dashboard, /toISOString\(\)\.split\(['"]T['"]\)/);
  assert.match(dashboard, /date: post\.scheduled_for \? localDateInput\(post\.scheduled_for\)/);
  assert.match(dashboard, /d\.getFullYear\(\)/);
});

test("a post being sent is shown as such and cannot be validated again", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.match(dashboard, /"Publication en cours"/);
  const posts = read("server/src/routes/posts.ts");
  assert.match(posts, /AND status IN \('pending', 'validated', 'failed'\)/);
});

test("a failed profile read never sends a set-up account to onboarding", () => {
  const guard = read("src/components/ProtectedRoute.tsx");
  assert.match(guard, /"signed_out" : "unavailable"/);
  assert.doesNotMatch(guard, /isUnauthenticated \? "unknown" : "incomplete"/);
});

test("the automatic path is counted against the plan like the manual one", () => {
  const weekly = read("server/src/services/weekly.ts");
  assert.match(weekly, /reserve\(profileId, "generate-text", entitlement\.limits\.monthlyTextGenerations\)/);
  assert.match(weekly, /monthlyUsage\(profileId, fn\)/);
  const misc = read("server/src/routes/misc.ts");
  assert.match(misc, /`generate-week:\$\{ctx\.profileId\}`/);
});

test("the Graphiste API key only ever travels to the configured origin", () => {
  const generation = read("server/src/services/generation.ts");
  assert.match(generation, /url\.origin === base\.origin \? url\.toString\(\) : null/);
  assert.match(generation, /safeGraphisteStatusUrl\(extractStatusUrl\(payload\)\)/);
  assert.match(generation, /safeGraphisteStatusUrl\(job\.provider_status_url\)/);
});

test("prompts receive French labels, not the dashboard's option codes", () => {
  const labels = read("server/src/lib/labels.ts");
  assert.match(labels, /food: "Restauration"/);
  for (const file of ["server/src/services/text.ts", "server/src/services/weekly.ts"]) {
    assert.match(read(file), /sectorLabel\(profile\.sector\)/, file);
    assert.match(read(file), /toneLabel\(profile\.tone\)/, file);
  }
});

test("migration 0007 only replaces a function", () => {
  const sql = read("server/migrations/0007_publish_recovery_bounded.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.match(sql, /CREATE OR REPLACE FUNCTION recover_stuck_publishing\(\) RETURNS integer/);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b/i);
  // The same budget as the API.
  assert.match(sql, /publish_attempts \+ 1 >= 5/);
  assert.match(read("server/src/services/publish.ts"), /const MAX_PUBLISH_ATTEMPTS = 5;/);
});
