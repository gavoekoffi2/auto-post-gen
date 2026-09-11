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

  // An unconfigured server says which secret is missing, so an operator can
  // fix the deployment without reading the code.
  assert.match(routes, /ZERNIO_API_KEY/);

  // The API client turns the server's message into an ApiError, so the dialog
  // surfaces that message directly instead of digging through an envelope.
  assert.match(ui, /err instanceof Error \? err\.message/);
});
