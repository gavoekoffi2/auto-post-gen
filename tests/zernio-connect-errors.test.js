import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Zernio billing errors are actionable instead of the generic Edge Function message", () => {
  const edge = readFileSync("supabase/functions/zernio-connect/index.ts", "utf8");
  const ui = readFileSync("src/components/SocialMediaConnect.tsx", "utf8");

  assert.match(edge, /free_tier_exceeded/);
  assert.match(edge, /ZERNIO_PAYMENT_REQUIRED/);
  assert.match(edge, /limite gratuite Zernio de 2 comptes connectés/);
  assert.match(ui, /functionError\.context\.clone\(\)\.json\(\)/);
  assert.match(ui, /toast\.error\(await functionErrorMessage/);
});