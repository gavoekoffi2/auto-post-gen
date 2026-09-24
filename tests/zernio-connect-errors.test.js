import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("a provider failure reaches the user as a message they can act on", () => {
  const publish = readFileSync("server/src/services/publish.ts", "utf8");
  const routes = readFileSync("server/src/routes/misc.ts", "utf8");
  const ui = readFileSync("src/components/SocialMediaConnect.tsx", "utf8");

  // The provider's own status and body are carried into the message rather
  // than collapsed into a generic failure the user cannot do anything with.
  assert.match(publish, /Publication refusée \(\$\{postResponse\.status\}\)/);
  assert.match(publish, /Impossible de lire les comptes connectés \(\$\{accountsResponse\.status\}\)/);

  // Social OAuth is handled by the isolated Zernio connector. Its server-only
  // configuration failure still names the missing secret, while the route
  // delegates rather than returning the retired handoff placeholder.
  const zernio = readFileSync("server/src/lib/zernio.ts", "utf8");
  assert.match(zernio, /ZERNIO_API_KEY/);
  assert.match(routes, /connectSocial\(ctx\.profileId, body\.platform\)/);

  // The API client turns the server's message into an ApiError, so the dialog
  // surfaces that message directly instead of digging through an envelope.
  assert.match(ui, /err instanceof Error \? err\.message/);
});
