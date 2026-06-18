import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const zernioSource = readFileSync(join(__dirname, '..', 'supabase/functions/_shared/zernio.ts'), 'utf8');
const publishSource = readFileSync(join(__dirname, '..', 'supabase/functions/publish-post/index.ts'), 'utf8');

test('Zernio publish parses per-platform statuses instead of treating every HTTP 200 as success', () => {
  assert.match(zernioSource, /interface ZernioPlatformResult/);
  assert.match(zernioSource, /platformPostUrl/);
  assert.match(zernioSource, /const status = normaliseZernioStatus\(rawStatus\)/);
  assert.match(zernioSource, /failed|error|published|queued|processing|scheduled/);
});

test('publish-post returns LinkedIn platform post URLs and does not mark queued Zernio jobs as published', () => {
  assert.match(publishSource, /externalUrl\?: string/);
  assert.match(publishSource, /externalPostIds\[`\$\{r\.platform\}_url`\] = r\.externalUrl/);
  assert.match(publishSource, /r\.status === "ok"/);
  assert.match(publishSource, /status === "pending"/);
  assert.match(publishSource, /anyPending/);
});
