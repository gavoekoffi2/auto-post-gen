import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const publishPost = read("server/src/services/publish.ts");
const generation = read("server/src/services/generation.ts");
const generationRoutes = read("server/src/routes/generations.ts");
const text = read("server/src/services/text.ts");
const dashboard = read("src/pages/Dashboard.tsx");
const schema = read("server/migrations/0001_core_schema.sql");

// ---------------------------------------------------------------------------
// Publish queue: bounded retries instead of a starved, self-blocking batch.
// ---------------------------------------------------------------------------

test("a post that cannot publish leaves the queue instead of blocking it forever", () => {
  // The queue selects due posts oldest-first with a small LIMIT. A post
  // written back as 'validated' with a past scheduled_for was re-selected on
  // every tick; a handful of them permanently filled the batch and starved
  // every newer post behind them.
  assert.match(publishPost, /const MAX_PUBLISH_ATTEMPTS = \d+/);
  assert.match(publishPost, /const RETRY_BACKOFF_MINUTES = \[/);
  // Attempts are counted on the row, not just in memory.
  assert.match(publishPost, /publish_attempts = \$\d+|publish_attempts,/);
  // Exhausted attempts are terminal, so the post shows as failed in the
  // dashboard (with its per-platform reason) rather than looping silently.
  assert.match(publishPost, /allErrors \|\| exhausted/);
});

test("the queue skips posts still inside their retry backoff window", () => {
  const scheduler = read("server/src/services/scheduler.ts");
  assert.match(scheduler, /next_publish_attempt_at <= now\(\)/);
  // Only a post going back into the queue carries a future backoff stamp; one
  // that published or failed terminally is stamped now.
  assert.match(publishPost, /status === "validated" \? nextAttemptAt\(attempts\)/);
});

test("a failed re-publish never erases the timestamp of a publish that succeeded", () => {
  // COALESCE keeps the original instant: overwriting it with NULL on a later
  // failed attempt loses when the post actually went out.
  // The column keeps its own value on any attempt that did not publish.
  assert.match(
    publishPost,
    /published_at = CASE WHEN \$3 = 'published' THEN now\(\) ELSE published_at END/,
  );
  assert.doesNotMatch(publishPost, /published_at = CASE WHEN[^\n]*ELSE NULL/);
  // The recovery function keeps it too, rather than restamping an old post.
  assert.match(schema, /published_at = COALESCE\(published_at, now\(\)\)/);
});

test("the retry columns exist and the queue's selection index covers them", () => {
  assert.match(schema, /publish_attempts\s+integer NOT NULL DEFAULT 0/);
  assert.match(schema, /next_publish_attempt_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  // Without the column in the index the added predicate degrades the queue
  // scan to a sequential scan as posts accumulate.
  assert.match(
    schema,
    /CREATE INDEX IF NOT EXISTS posts_due_idx[\s\S]{0,200}next_publish_attempt_at/,
  );
  assert.match(schema, /posts_attempts_nonneg CHECK \(publish_attempts >= 0\)/);
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
  assert.match(generation, /async function settleJob/);
  assert.match(generation, /image_job_id = CASE WHEN \$3 = 'processing' THEN image_job_id ELSE NULL END/);
  assert.match(generation, /settleJob\(job, "failed"/);
});

test("the dashboard only resumes jobs that are still marked processing", () => {
  assert.match(dashboard, /p\.image_status === "processing"/);
});

test("a poster URL is only ever accepted from the provider that rendered it", () => {
  // The URL comes back from the provider's own response and is stored as-is;
  // the URLs a USER can supply go through asImageUrl instead (see
  // security-hardening). Neither path lets an arbitrary host be fetched from
  // inside this network.
  assert.match(generation, /extractImageUrl\(/);
  assert.match(read("server/src/lib/validate.ts"), /export function asImageUrl/);
});

test("a provider failure before any paid render gives the image quota back", () => {
  assert.match(generationRoutes, /releaseQuota\(ctx\.profileId, "generate-image"\)/);
  // Released by deleting exactly one reservation row, so the usage history is
  // preserved rather than wiped.
  assert.match(schema, /CREATE OR REPLACE FUNCTION release_generation_quota/);
  assert.match(schema, /LIMIT 1/);
});

// ---------------------------------------------------------------------------
// Text generation: Claude-only, but no longer a single point of failure.
// ---------------------------------------------------------------------------

test("text generation walks a Claude-only chain instead of pinning one slug", () => {
  assert.match(text, /function textModels\(\): string\[\]/);
  // Every entry stays on Claude — the chain must not become a quality downgrade.
  const chain = text.match(/return \[[\s\S]*?\]\.filter\(Boolean\)/);
  assert.ok(chain, "textModels must expose an explicit chain");
  const slugs = (chain[0].match(/"[^"\n]+"/g) || []).filter((token) => token.includes("/"));
  assert.ok(slugs.length >= 2, "the chain needs at least one fallback model");
  for (const model of slugs) {
    assert.match(model, /^"anthropic\/claude-/, `non-Claude model in the text chain: ${model}`);
  }
  assert.match(text, /export async function callClaude/);
});

test("only per-model failures advance the chain, not bad key or no credit", () => {
  // A 401 (bad key) or 402 (no credit) fails identically on every model;
  // retrying them down the chain would just multiply the latency.
  assert.match(text, /function isModelUnavailable\(status: number\): boolean/);
  const guard = text.match(/function isModelUnavailable[\s\S]*?\n\}/)[0];
  assert.equal(guard.includes("401"), false, "401 must not be treated as model-unavailable");
  assert.equal(guard.includes("402"), false, "402 must not be treated as model-unavailable");
  assert.match(guard, /404/);
});

test("every text feature goes through the one chain, none pins a model", () => {
  // A second call site with its own pinned slug is how the fallback silently
  // stops applying to half the product.
  const audiences = read("server/src/services/audiences.ts");
  for (const [name, src] of [["text", text], ["audiences", audiences]]) {
    assert.doesNotMatch(src, /model: "anthropic/, `${name} pins a model on the call`);
  }
  assert.match(audiences, /callClaude\(/);
  // Exactly one place builds the request body.
  assert.equal((text.match(/OPENROUTER_ENDPOINT, \{/g) || []).length, 1);
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
  // Canned filler is not a generation. Charging for it means a provider
  // outage silently spends the user's hourly budget on boilerplate.
  assert.match(text, /fallback: true/);
  assert.match(generationRoutes, /if \(result\.fallback\) await releaseQuota\(ctx\.profileId, "generate-text"\)/);
  // …and the client is told, so the UI can say so rather than passing it off
  // as a real result.
  assert.match(dashboard, /fallback/);
});

test("the publish queue has something that actually runs it", () => {
  // Scheduled publishing is the product's central promise. On the old stack a
  // platform cron invoked the function; here it has to be run by this server,
  // or a scheduled post simply never goes out.
  const scheduler = read("server/src/services/scheduler.ts");
  assert.match(scheduler, /export async function runPublishTick/);
  assert.match(scheduler, /status = 'validated'/);
  assert.match(scheduler, /scheduled_for <= now\(\)/);
  assert.match(scheduler, /next_publish_attempt_at <= now\(\)/);
  assert.match(scheduler, /LIMIT \$1/);
  // A crash mid-publish is unstuck before the batch is selected.
  assert.match(scheduler, /recover_stuck_publishing/);
  // One post failing must not abandon the rest of the batch.
  assert.match(scheduler, /catch \(err\)/);

  const index = read("server/src/index.ts");
  assert.match(index, /startScheduler\(/);
  assert.match(index, /PUBLISH_TICK_SECONDS/);
});
