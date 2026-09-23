import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publish = readFileSync(join(__dirname, '..', 'server/src/services/publish.ts'), 'utf8');

test('per-platform statuses are parsed instead of treating every HTTP 200 as success', () => {
  // A 200 from the provider means "request accepted", not "post published".
  // Reading it as success is how the dashboard claimed a post existed on a
  // network that had not published it — and sometimes never would.
  assert.match(publish, /const rawStatus = String\(row\?\.status \?\? ""\)\.toLowerCase\(\)/);
  assert.match(publish, /\["published", "success", "succeeded", "completed", "ok"\]/);
  assert.match(publish, /\["queued", "processing", "scheduled", "pending", "created"\]/);
  // Anything unrecognised is an error, not a silent success.
  assert.match(publish, /Statut inattendu/);
});

test('a queued job is reported as pending, never as published', () => {
  assert.match(publish, /status: "pending"/);
  assert.match(publish, /pas encore confirmée par le réseau/);
  // Only a genuinely published platform contributes a post URL and moves the
  // row to 'published'.
  assert.match(publish, /r\.status === "ok" && r\.externalUrl/);
  assert.match(publish, /const anyOk = results\.some\(\(r\) => r\.status === "ok"\)/);
  // An accepted-but-queued post is never re-queued (it would be posted
  // twice): it stays 'publishing' with the provider's id, which crash
  // recovery settles as published, never as a retry.
  assert.match(publish, /const accepted = !anyOk && results\.some\(\(r\) => r\.status === "pending"\)/);
  assert.match(publish, /\? "publishing"/);
  assert.match(publish, /provider_post_id = COALESCE\(\$8, provider_post_id\)/);
});

test('a platform URL is recorded so the user can open what was posted', () => {
  assert.match(publish, /externalUrl\?: string/);
  assert.match(publish, /externalIds\[`\$\{r\.platform\}_url`\] = r\.externalUrl/);
  assert.match(publish, /platformPostUrl/);
});

test('a network the account has not connected is reported as such, not as an error', () => {
  // "not_connected" is actionable — it tells the user to connect the account.
  // Reporting it as a failure would burn a publish attempt on every retry.
  assert.match(publish, /status: "not_connected"/);
  assert.match(publish, /a\.isActive !== false/);
});
