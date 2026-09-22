import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeGraphisteStatusUrl } from "../supabase/functions/_shared/graphiste.ts";

const ENDPOINT = "https://provider.example.com/functions/v1/api-v1/v1/posters/generate";

test("an off-origin status URL is refused", () => {
  // Every poll of this URL carries `Authorization: Bearer <GRAPHISTE_GPT_API_KEY>`.
  // statusUrl reaches the function from the generate-image request body and
  // from posts.image_status_url, which RLS lets its owner write — so accepting
  // an arbitrary URL hands the operator's API key to any logged-in user.
  for (const hostile of [
    "https://attacker.example/steal",
    "https://provider.example.com.attacker.example/steal",
    "https://user:pass@attacker.example/steal",
    "http://provider.example.com/poll",        // downgraded to http
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://localhost:54321/",
    "https://127.0.0.1/",
  ]) {
    assert.equal(safeGraphisteStatusUrl(ENDPOINT, hostile), null, `accepted ${hostile}`);
  }
});

test("a legitimate status URL from the provider is accepted", () => {
  assert.equal(
    safeGraphisteStatusUrl(ENDPOINT, "https://provider.example.com/functions/v1/api-v1/v1/jobs/abc"),
    "https://provider.example.com/functions/v1/api-v1/v1/jobs/abc",
  );
  // A relative path is same-origin by construction.
  assert.equal(
    safeGraphisteStatusUrl(ENDPOINT, "/functions/v1/api-v1/v1/jobs/abc"),
    "https://provider.example.com/functions/v1/api-v1/v1/jobs/abc",
  );
});

test("malformed input never throws, and never escapes the provider's origin", () => {
  assert.equal(safeGraphisteStatusUrl(ENDPOINT, null), null);
  assert.equal(safeGraphisteStatusUrl(ENDPOINT, ""), null);
  // An unparseable endpoint means we have nothing to pin against: refuse.
  assert.equal(safeGraphisteStatusUrl("not a url", "https://provider.example.com/x"), null);
  // Garbage that is not a URL is treated as a relative path, so it resolves
  // onto the provider's own origin (it will simply 404). What matters is that
  // it can never reach a host we did not configure.
  const resolved = safeGraphisteStatusUrl(ENDPOINT, "not a url");
  assert.ok(resolved && new URL(resolved).origin === "https://provider.example.com");
});

test("both poll sites use the guard, and no image download is unbounded", () => {
  const shared = readFileSync("supabase/functions/_shared/graphiste.ts", "utf8");
  const image = readFileSync("supabase/functions/generate-image/index.ts", "utf8");

  for (const [name, source] of [["_shared/graphiste.ts", shared], ["generate-image", image]]) {
    assert.match(source, /safeGraphisteStatusUrl\(endpoint, statusUrl\)/, `${name} must filter the status URL`);
    assert.doesNotMatch(
      source,
      /out\.push\(statusUrl\.startsWith\("http"\)/,
      `${name} still pushes a raw statusUrl`,
    );
  }

  // Remote poster bytes go through the SSRF-guarded, size-capped helper.
  assert.match(image, /from "\.\.\/_shared\/safeFetch\.ts"/);
  assert.match(image, /await fetchImageBytes\(imageUrl\)/);
  assert.doesNotMatch(image, /await fetch\(imageUrl\)/);
});
