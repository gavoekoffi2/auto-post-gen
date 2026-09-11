import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const publishPost = read("supabase/functions/publish-post/index.ts");
const generateImage = read("supabase/functions/generate-image/index.ts");
const ai = read("supabase/functions/_shared/ai.ts");
const dashboard = read("src/pages/Dashboard.tsx");
const retryMigration = read("supabase/migrations/20260910000000_publish_retry_backoff.sql");

// ---------------------------------------------------------------------------
// Publish queue: bounded retries instead of a starved, self-blocking batch.
// ---------------------------------------------------------------------------

test("a post that cannot publish leaves the queue instead of blocking it forever", () => {
  // The cron selects due posts ordered oldest-first with a small LIMIT. A post
  // written back as 'validated' with a past scheduled_for was re-selected on
  // every tick; a handful of them permanently filled the batch and starved
  // every newer post behind them.
  assert.match(publishPost, /const MAX_PUBLISH_ATTEMPTS = \d+/);
  assert.match(publishPost, /const RETRY_BACKOFF_MINUTES = \[/);
  // Attempts are counted on the row, not just in memory.
  assert.match(publishPost, /publish_attempts: anyOk \? 0 : attempts/);
  // Exhausted attempts are terminal, so the post shows as failed in the
  // dashboard (with its per-platform reason) rather than looping silently.
  assert.match(publishPost, /allErrors \|\| exhausted/);
});

test("the cron skips posts still inside their retry backoff window", () => {
  assert.match(publishPost, /\.lte\("next_publish_attempt_at", nowIso\)/);
  // Only a post going back into the queue carries a future backoff stamp.
  assert.match(publishPost, /finalStatus === "validated" \? nextAttemptAt\(attempts\)/);
});

test("a failed re-publish never erases the timestamp of a publish that succeeded", () => {
  assert.equal(
    publishPost.includes("published_at: anyOk ? new Date().toISOString() : null"),
    false,
    "published_at must not be reset to null on an unsuccessful attempt",
  );
  assert.match(publishPost, /if \(anyOk\) update\.published_at = new Date\(\)\.toISOString\(\)/);
});

test("the retry columns exist and the cron's selection index covers them", () => {
  assert.match(retryMigration, /ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0/);
  assert.match(retryMigration, /ADD COLUMN IF NOT EXISTS next_publish_attempt_at timestamptz/);
  // Without the column in the index the added predicate degrades the queue
  // scan to a sequential scan as posts accumulate.
  assert.match(
    retryMigration,
    /CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled[\s\S]*next_publish_attempt_at/,
  );
  assert.match(retryMigration, /CHECK \(publish_attempts >= 0\)/);
});

test("validating or retrying a post clears the inherited retry state", () => {
  // Otherwise a post that already burned its attempts is re-failed instantly
  // and the user's "Réessayer" click appears to do nothing.
  //
  // The reset now happens SERVER-side as part of validating: the publish
  // budget is the server's to grant, so the browser no longer writes the
  // counter or the backoff stamp itself.
  const validates = dashboard.match(/postsApi\.validate\(/g) || [];
  assert.ok(validates.length >= 2, "both handleValidate and handleRetry must call validate");
  assert.equal(
    /publish_attempts:\s*0/.test(dashboard),
    false,
    "the browser must not set the retry counter itself",
  );
});

// ---------------------------------------------------------------------------
// Image generation: terminal failures are persisted, re-hosting is guarded.
// ---------------------------------------------------------------------------

test("a terminally failed poster job is cleared from the post row", () => {
  // The row previously kept image_status='processing' with a dead job id, so
  // the dashboard resumed that same dead job on EVERY load — a spinner that
  // could never resolve and a poll that could never succeed.
  assert.match(generateImage, /const markImageFailed = async \(\) => \{/);
  assert.match(
    generateImage,
    /image_status: "failed", image_job_id: null, image_status_url: null/,
  );
  assert.match(generateImage, /await markImageFailed\(\)/);
});

test("the dashboard only resumes jobs that are still marked processing", () => {
  assert.match(dashboard, /p\.image_status === "processing"/);
});

test("re-hosting a poster goes through the SSRF-guarded fetch", () => {
  // The URL comes back from an external API response, so the interactive path
  // must use the same guarded helper as the cron path (https-only, private and
  // metadata hosts blocked, content-type checked, response size capped).
  assert.match(generateImage, /import \{ fetchImageBytes \} from "\.\.\/_shared\/safeFetch\.ts"/);
  assert.match(generateImage, /const fetched = await fetchImageBytes\(imageUrl\)/);
  assert.equal(
    generateImage.includes("const fetched = await fetch(imageUrl);"),
    false,
    "the poster re-host must not use an unguarded, uncapped fetch",
  );
});

test("a provider failure before any paid render gives the image quota back", () => {
  assert.match(generateImage, /const releaseImageQuota = async \(\) => \{/);
  assert.match(generateImage, /await releaseImageQuota\(\)/);
  // Released by id: a LIMIT on DELETE is not portable across PostgREST
  // versions, and a delete that ignored it would wipe the month's history.
  assert.match(generateImage, /\.eq\("id", reservation\.id\)/);
});

// ---------------------------------------------------------------------------
// Text generation: Claude-only, but no longer a single point of failure.
// ---------------------------------------------------------------------------

test("text generation walks a Claude-only chain instead of pinning one slug", () => {
  assert.match(ai, /export function getTextModels\(\): string\[\]/);
  // Every entry stays on Claude — the chain must not become a quality downgrade.
  const chain = ai.match(/const chain = \[[\s\S]*?\]\.filter\(Boolean\)/);
  assert.ok(chain, "getTextModels must expose an explicit chain");
  const slugs = (chain[0].match(/"[^"\n]+"/g) || []).filter((token) => token.includes("/"));
  assert.ok(slugs.length >= 2, "the chain needs at least one fallback model");
  for (const model of slugs) {
    assert.match(model, /^"anthropic\/claude-/, `non-Claude model in the text chain: ${model}`);
  }
  assert.match(ai, /export async function chatCompletionWithFallback/);
});

test("only per-model failures advance the chain, not bad key or no credit", () => {
  // A 401 (bad key) or 402 (no credit) fails identically on every model;
  // retrying them down the chain would just multiply the latency.
  assert.match(ai, /function isModelUnavailable\(status: number\): boolean/);
  const guard = ai.match(/function isModelUnavailable[\s\S]*?\n\}/)[0];
  assert.equal(guard.includes("401"), false, "401 must not be treated as model-unavailable");
  assert.equal(guard.includes("402"), false, "402 must not be treated as model-unavailable");
  assert.match(guard, /404/);
});

test("the generators no longer pin a single model on the call", () => {
  for (const path of [
    "supabase/functions/generate-content/index.ts",
    "supabase/functions/auto-generate-weekly/index.ts",
    "supabase/functions/detect-audiences/index.ts",
  ]) {
    assert.equal(
      read(path).includes("model: getTextModel(),"),
      false,
      `${path} still pins a model, which bypasses the fallback chain`,
    );
  }
});

// ---------------------------------------------------------------------------
// Scheduling: local wall-clock in, correct instant out.
// ---------------------------------------------------------------------------

test("edited schedules are converted from local wall-clock to a real instant", () => {
  // Concatenating the date and time inputs into "2026-09-10T14:30:00" made
  // Postgres read the value as UTC, shifting the post by the user's offset on
  // every save while the dashboard kept rendering it as local time.
  assert.equal(
    dashboard.includes("`${editingPost.date}T${editingPost.time}:00`"),
    false,
    "a naive timestamp string must not be sent to a timestamptz column",
  );
  assert.match(dashboard, /function localDateTimeToIso/);
  assert.match(dashboard, /return local\.toISOString\(\)/);
});

test("a manually generated post is given a real schedule", () => {
  // scheduled_for = null kept the post out of the calendar, showed a blank
  // date on its card, and made it invisible to the publish cron (whose due
  // query filters on scheduled_for).
  assert.match(dashboard, /function nextPreferredSlot/);
  assert.match(dashboard, /scheduledFor: nextPreferredSlot\(userProfile\)/);
});

test("regenerating a post's text drops the poster job that belonged to the old text", () => {
  const handler = dashboard.match(/const handleRegenerateContent[\s\S]*?\n  \};/)[0];
  assert.match(handler, /image_job_id: null/);
  assert.match(handler, /image_status: null/);
  // The persisted category must follow the regenerated text, or the new poster
  // is built for the previous post's editorial intent.
  assert.match(handler, /content_category: category/);
});

// ---------------------------------------------------------------------------
// Connect surface matches what a post can actually target.
// ---------------------------------------------------------------------------

test("the connect dialog only offers networks a post can be addressed to", () => {
  const connect = read("src/components/SocialMediaConnect.tsx");
  const list = connect.match(/const ZERNIO_PLATFORMS = \[[\s\S]*?\] as const;/)[0];
  const offered = (list.match(/id: "([a-z]+)"/g) || []).map((m) => m.slice(5, -1));
  // posts.platforms is constrained to this set (see production_hardening), and
  // the Onboarding/Profil pickers offer the same. Offering more here let a user
  // connect an account they could then never publish to.
  assert.deepEqual(offered.sort(), ["facebook", "instagram", "linkedin", "twitter"]);
});

// ---------------------------------------------------------------------------
// Marketing copy must not invent customers or usage numbers.
// ---------------------------------------------------------------------------

test("the landing page carries no invented customers or usage figures", () => {
  const testimonials = read("src/components/landing/TestimonialsNew.tsx");
  const about = read("src/pages/About.tsx");
  for (const [label, source] of [["testimonials", testimonials], ["about", about]]) {
    for (const claim of ["10K+", "500K+", "98%", "Utilisateurs actifs", "Satisfaction client"]) {
      assert.equal(
        source.includes(claim),
        false,
        `${label} still advertises "${claim}" for a product with no users yet`,
      );
    }
    // Stock-photo faces attached to invented names.
    assert.equal(source.includes("images.unsplash.com"), false, `${label} still uses stock faces`);
  }
});

// ---------------------------------------------------------------------------
// A canned fallback must be visible as one, and must not cost a generation.
// ---------------------------------------------------------------------------

test("the canned fallback text is surfaced to the user, not passed off as AI output", () => {
  // generate-content answers { fallback: true } when the AI provider was
  // unreachable and it returned a generic placeholder post. The dashboard used
  // to announce that as a successful generation, so a user could publish
  // boilerplate believing it had been written for their business.
  assert.match(dashboard, /if \(data\.fallback\)/);
  assert.match(dashboard, /modèle générique/);
});

test("the dashboard only claims web enrichment when the search actually returned something", () => {
  assert.match(dashboard, /data\.usedWebInspiration\s*\n?\s*\?/);
});

test("a fallback does not consume the user's text generation quota", () => {
  const generateContent = read("supabase/functions/generate-content/index.ts");
  assert.match(generateContent, /const releaseQuota = async \(\) => \{/);
  assert.match(generateContent, /await releaseQuota\(\);\n\s*const payload = fallbackContent/);
  // Released by id, for the same reason as the image quota.
  assert.match(generateContent, /\.eq\("id", reservation\.id\)/);
});
