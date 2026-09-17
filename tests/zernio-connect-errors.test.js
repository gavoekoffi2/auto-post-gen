import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Zernio billing errors are actionable instead of the generic Edge Function message", () => {
  const edge = readFileSync("supabase/functions/zernio-connect/index.ts", "utf8");
  const ui = readFileSync("src/components/SocialMediaConnect.tsx", "utf8");
  // The JSON body of a failed invoke() is unwrapped in one shared place so no
  // screen can regress to the SDK's meaningless "non-2xx status code" message.
  const helper = readFileSync("src/lib/functionError.ts", "utf8");

  assert.match(edge, /free_tier_exceeded/);
  assert.match(edge, /ZERNIO_PAYMENT_REQUIRED/);
  assert.match(edge, /limite gratuite Zernio de 2 comptes connectés/);
  assert.match(helper, /functionError\.context\.clone\(\)\.json\(\)/);
  assert.match(ui, /import \{ functionErrorMessage \} from "@\/lib\/functionError"/);
  assert.match(ui, /toast\.error\(await functionErrorMessage/);
});

test("user-facing edge function failures go through the shared error unwrapper", () => {
  for (const file of ["src/pages/Dashboard.tsx", "src/pages/Onboarding.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /functionErrorMessage/,
      `${file} must surface the edge function's own error message`,
    );
  }
});
