import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const health = readFileSync("supabase/functions/_shared/health.ts", "utf8");
const adminApi = readFileSync("supabase/functions/admin-api/index.ts", "utf8");
const adminUi = readFileSync("src/pages/Admin.tsx", "utf8");

test("health checks report secret PRESENCE, never a secret value", () => {
  // Every secret read is coerced to a boolean on the spot. A `detail` or
  // response built from the raw value would leak production keys to any admin
  // browser session (and into logs).
  const secretReads = health.match(/Deno\.env\.get\("[A-Z_]+"\)/g) || [];
  assert.ok(secretReads.length > 0, "the diagnosis must read the configured secrets");
  assert.doesNotMatch(health, /detail:\s*`[^`]*\$\{key\}/, "a secret value must never reach a detail string");
  assert.doesNotMatch(health, /value:\s*Deno\.env\.get/);
  assert.match(health, /const present = !!Deno\.env\.get\(name\)/);
});

test("every provider probe is time-bounded and cannot throw out of the check", () => {
  assert.match(health, /PROBE_TIMEOUT_MS/);
  assert.match(health, /AbortController/);
  // Each probe wraps its network call so a dead third party degrades to a
  // reported "error" instead of failing the whole admin page.
  for (const probe of ["openRouterCheck", "graphisteCheck", "zernioCheck"]) {
    const body = health.slice(health.indexOf(`function ${probe}`));
    assert.match(body.slice(0, 2500), /catch \(err\)/, `${probe} must handle its own failure`);
  }
});

test("the diagnosis covers the failures that silently broke production before", () => {
  // The historic outages: a missing Graphiste key (text without a poster) and
  // a cron that stopped firing (nothing published, nobody alerted).
  assert.match(health, /GRAPHISTE_GPT_API_KEY/);
  assert.match(health, /OPENROUTER_API_KEY/);
  assert.match(health, /ZERNIO_API_KEY/);
  assert.match(health, /CRON_SECRET/);
  assert.match(health, /ALLOWED_ORIGINS/);
  assert.match(health, /pipeline:overdue/);
  assert.match(health, /pipeline:weekly/);
  assert.match(health, /pipeline:stuck/);
});

test("the health action is exposed by admin-api and rendered in the control plane", () => {
  assert.match(adminApi, /action === "health"/);
  assert.match(adminApi, /runHealthChecks\(admin\)/);
  assert.match(adminUi, /action: "health"/);
});

test("the diagnosis is also pushed, not only displayed", () => {
  const alert = readFileSync("supabase/functions/health-alert/index.ts", "utf8");
  const config = readFileSync("supabase/config.toml", "utf8");

  // Showing a failure in /admin only helps someone who opens /admin.
  assert.match(alert, /runHealthChecks\(admin\)/);
  assert.match(alert, /api\.resend\.com\/emails/);

  // Only real failures page the operator: alerting on warnings trains people
  // to ignore the alerts that matter.
  assert.match(alert, /filter\(\(c\) => c\.status === "error"\)/);
  assert.match(alert, /if \(failing\.length === 0\)/);

  // This endpoint reveals which secrets are configured, so it must fail closed.
  assert.match(alert, /CRON_SECRET/);
  assert.match(alert, /refusing to run/);
  assert.match(alert, /provided !== expectedSecret/);
  assert.match(config, /\[functions\.health-alert\]/);
});

test("the weekly-generation check looks only at the accounts it is about", () => {
  const health = readFileSync("supabase/functions/_shared/health.ts", "utf8");
  // Counting posts platform-wide would let one manual generation by any other
  // account mask a dead cron — reporting healthy in exactly the situation the
  // check exists to catch.
  assert.match(health, /\.eq\("auto_publish", true\)/);
  assert.match(health, /q\.in\("user_id", autoIds\)/);
});
