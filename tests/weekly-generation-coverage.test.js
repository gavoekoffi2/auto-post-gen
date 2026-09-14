import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const weekly = read("supabase/functions/auto-generate-weekly/index.ts");

test("weekly generation also serves users who validate their posts manually", () => {
  // Previously `.eq("auto_publish", true)`: everyone who wanted to approve each
  // post got nothing from the cron, and the validation email had nothing to send.
  assert.doesNotMatch(weekly, /\.eq\("auto_publish", true\)/);
  assert.match(weekly, /\.or\("auto_publish\.eq\.true,auto_generate_enabled\.eq\.true"\)/);
  assert.match(weekly, /status: profile\.auto_publish \? "validated" : "pending"/);
});

test("posts awaiting validation start their one-click link TTL", () => {
  assert.match(weekly, /validation_token_created_at: profile\.auto_publish \? null : new Date\(\)\.toISOString\(\)/);
  const validate = read("supabase/functions/validate-post/index.ts");
  // A weekly email covering posts scheduled up to 7 days out needs a TTL that
  // outlives the batch it announces.
  assert.match(validate, /const TOKEN_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
});

test("the cron never spends AI credits on a half-finished signup", () => {
  assert.match(weekly, /onboarding not complete/);
  assert.match(weekly, /Array\.isArray\(profile\.content_types\)/);
  assert.match(weekly, /profile\.description \|\| ""/);
});

test("weekly generation is an explicit, user-visible setting", () => {
  const migration = read("supabase/migrations/20260914000100_weekly_generation_opt_in.sql");
  assert.match(migration, /auto_generate_enabled boolean NOT NULL DEFAULT true/);

  const profile = read("src/pages/Profile.tsx");
  assert.match(profile, /auto_generate_enabled/);
  assert.match(profile, /Générer mes posts automatiquement chaque semaine/);
  // Auto-publishing without auto-generation is meaningless: keep them coherent.
  assert.match(profile, /auto_publish: checked \? profile\.auto_publish : false/);

  const types = read("src/integrations/supabase/types.ts");
  assert.match(types, /auto_generate_enabled: boolean/);
});

test("the dashboard counts every publishing provider, not just Zernio", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  const queryStart = dashboard.indexOf("from('social_connections')");
  assert.ok(queryStart > 0, "the dashboard must still look up social connections");
  const block = dashboard.slice(queryStart, dashboard.indexOf("setHasConnection(", queryStart));
  assert.doesNotMatch(block, /provider/, "direct OAuth connections must count too");
  assert.match(block, /\.eq\('user_id', session\.user\.id\)/);
});
