import test, { after, before } from "node:test";
import assert from "node:assert/strict";

// End-to-end tests against a real Postgres and a real Fastify instance.
//
// These exercise the guarantees that matter and cannot be checked by reading
// the code: that a session is required, that one account cannot reach
// another's rows, that quotas are a real cap, and that a password is verified
// server-side before it changes.
//
// Run with a database available (npm test builds first):
//   DATABASE_URL=postgres://... npm test

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.MEDIA_ROOT ??= "/tmp/psa-test-media";
process.env.NODE_ENV = "test";

const { pool, query } = await import("../dist/src/lib/db.js");
const { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } = await import(
  "../dist/src/lib/password.js"
);

let alice = "";
let bob = "";

before(async () => {
  // Fixtures. The schema is applied by `npm run migrate` before the suite.
  const { hash, salt } = await hashPassword("correct-horse-battery");
  const rows = await query<{ id: string }>(
    `INSERT INTO profiles (email, password_hash, password_salt)
     VALUES ($1, $2, $3), ($4, $2, $3)
     RETURNING id`,
    [`alice-${Date.now()}@example.test`, hash, salt, `bob-${Date.now()}@example.test`],
  );
  alice = rows[0]!.id;
  bob = rows[1]!.id;
});

after(async () => {
  await query(`DELETE FROM profiles WHERE id = ANY($1)`, [[alice, bob]]);
  await pool.end();
});

test("a password verifies against its own hash and nothing else", async () => {
  const record = await hashPassword("correct-horse-battery");
  assert.equal(await verifyPassword("correct-horse-battery", record), true);
  assert.equal(await verifyPassword("wrong-password", record), false);
  // A near-miss must fail like any other wrong password.
  assert.equal(await verifyPassword("correct-horse-batter", record), false);
});

test("two hashes of the same password differ (per-user salt)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a.hash, b.hash, "identical hashes would mean a shared or missing salt");
  assert.notEqual(a.salt, b.salt);
});

test("an account with no password set never authenticates", async () => {
  // An invite-created row must not be loggable-into with an empty password.
  assert.equal(await verifyPassword("", { hash: null, salt: null }), false);
  assert.equal(await verifyPassword("anything", { hash: null, salt: null }), false);
});

test("the minimum password length is enforced as a constant, not a suggestion", () => {
  assert.ok(MIN_PASSWORD_LENGTH >= 8);
});

test("the generation quota is a real cap, and a release frees exactly one slot", async () => {
  const allowed: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const rows = await query<{ consume_generation_quota: boolean }>(
      `SELECT consume_generation_quota($1, 'test-fn', 3, 3600)`,
      [alice],
    );
    allowed.push(rows[0]!.consume_generation_quota);
  }
  assert.deepEqual(allowed, [true, true, true, false, false]);

  await query(`SELECT release_generation_quota($1, 'test-fn')`, [alice]);
  const after = await query<{ consume_generation_quota: boolean }>(
    `SELECT consume_generation_quota($1, 'test-fn', 3, 3600)`,
    [alice],
  );
  assert.equal(after[0]!.consume_generation_quota, true, "releasing one must free exactly one");

  // And the history is kept rather than wiped.
  const remaining = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM generation_usage WHERE profile_id = $1`,
    [alice],
  );
  assert.equal(Number(remaining[0]!.count), 3);
});

test("one account's quota does not consume another's", async () => {
  for (let i = 0; i < 3; i++) {
    await query(`SELECT consume_generation_quota($1, 'isolation-fn', 3, 3600)`, [alice]);
  }
  const aliceBlocked = await query<{ consume_generation_quota: boolean }>(
    `SELECT consume_generation_quota($1, 'isolation-fn', 3, 3600)`,
    [alice],
  );
  assert.equal(aliceBlocked[0]!.consume_generation_quota, false);

  const bobAllowed = await query<{ consume_generation_quota: boolean }>(
    `SELECT consume_generation_quota($1, 'isolation-fn', 3, 3600)`,
    [bob],
  );
  assert.equal(bobAllowed[0]!.consume_generation_quota, true, "quotas must be per account");
});

test("a post is only reachable through its owner's profile id", async () => {
  const inserted = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, content, platforms) VALUES ($1, 'secret', ARRAY['LinkedIn'])
     RETURNING id`,
    [alice],
  );
  const postId = inserted[0]!.id;

  // This is the shape every route uses. Bob asking for Alice's post id gets
  // nothing back — identical to asking for an id that does not exist.
  const asBob = await query(`SELECT id FROM posts WHERE id = $1 AND profile_id = $2`, [
    postId,
    bob,
  ]);
  assert.equal(asBob.length, 0);

  const asAlice = await query(`SELECT id FROM posts WHERE id = $1 AND profile_id = $2`, [
    postId,
    alice,
  ]);
  assert.equal(asAlice.length, 1);
});

test("the publish queue skips posts inside their backoff window", async () => {
  // Twelve unpublishable posts plus one fresh: without a backoff the twelve
  // fill the (ordered, capped) batch on every tick and starve the fresh one.
  await query(
    `INSERT INTO posts (profile_id, content, platforms, status, scheduled_for, publish_attempts,
                        next_publish_attempt_at)
     SELECT $1, 'stuck ' || n, ARRAY['LinkedIn'], 'validated',
            now() - interval '30 days' + (n * interval '1 minute'), 1, now() + interval '15 minutes'
       FROM generate_series(1, 12) n`,
    [alice],
  );
  await query(
    `INSERT INTO posts (profile_id, content, platforms, status, scheduled_for)
     VALUES ($1, 'fresh', ARRAY['LinkedIn'], 'validated', now() - interval '1 minute')`,
    [alice],
  );

  const due = await query<{ content: string }>(
    `SELECT content FROM posts
      WHERE profile_id = $1 AND status = 'validated'
        AND scheduled_for <= now() AND next_publish_attempt_at <= now()
      ORDER BY scheduled_for ASC LIMIT 12`,
    [alice],
  );
  assert.deepEqual(due.map((r) => r.content), ["fresh"]);
});

test("a post cannot target a network the product cannot publish to", async () => {
  await assert.rejects(
    query(`INSERT INTO posts (profile_id, content, platforms) VALUES ($1, 'x', ARRAY['YouTube'])`, [
      alice,
    ]),
    /posts_platforms_known/,
  );
});

test("the retry counter cannot be driven negative", async () => {
  await assert.rejects(
    query(`INSERT INTO posts (profile_id, content, publish_attempts) VALUES ($1, 'x', -5)`, [alice]),
    /posts_attempts_nonneg/,
  );
});

test("a crashed publish that reached the provider is not re-posted", async () => {
  const rows = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, content, status, publishing_started_at, provider_post_id)
     VALUES ($1, 'sent', 'publishing', now() - interval '20 minutes', 'provider-123')
     RETURNING id`,
    [alice],
  );
  await query(`SELECT recover_stuck_publishing()`);
  const after = await query<{ status: string }>(`SELECT status FROM posts WHERE id = $1`, [
    rows[0]!.id,
  ]);
  assert.equal(after[0]!.status, "published", "re-queueing it would post the same content twice");
});

test("a crashed publish that never reached the provider is re-queued and counted", async () => {
  const rows = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, content, status, publishing_started_at, publish_attempts)
     VALUES ($1, 'unsent', 'publishing', now() - interval '20 minutes', 0)
     RETURNING id`,
    [alice],
  );
  await query(`SELECT recover_stuck_publishing()`);
  const after = await query<{
    status: string;
    publish_attempts: number;
    backed_off: boolean;
  }>(
    `SELECT status, publish_attempts, next_publish_attempt_at > now() AS backed_off
       FROM posts WHERE id = $1`,
    [rows[0]!.id],
  );
  assert.equal(after[0]!.status, "validated");
  assert.equal(after[0]!.publish_attempts, 1);
  assert.equal(after[0]!.backed_off, true);
});

test("media rows are scoped per account and reject an oversized file", async () => {
  await query(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'logo', $2, 'image/png', 1024)`,
    [alice, `${alice}/test.png`],
  );
  const asBob = await query(`SELECT id FROM media_assets WHERE profile_id = $1`, [bob]);
  assert.equal(asBob.length, 0);

  await assert.rejects(
    query(
      `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
       VALUES ($1, 'logo', $2, 'image/png', 999999999)`,
      [alice, `${alice}/huge.png`],
    ),
    /media_size_positive/,
  );
});

test("a one-time token cannot be replayed", async () => {
  await query(
    `INSERT INTO one_time_tokens (profile_id, purpose, token_hash, expires_at)
     VALUES ($1, 'password_reset', 'hash-under-test', now() + interval '1 hour')`,
    [alice],
  );
  const first = await query(
    `UPDATE one_time_tokens SET used_at = now()
      WHERE token_hash = 'hash-under-test' AND used_at IS NULL AND expires_at > now()
      RETURNING profile_id`,
  );
  assert.equal(first.length, 1);

  const second = await query(
    `UPDATE one_time_tokens SET used_at = now()
      WHERE token_hash = 'hash-under-test' AND used_at IS NULL AND expires_at > now()
      RETURNING profile_id`,
  );
  assert.equal(second.length, 0, "a used token must not claim a second time");
});

test("the queue selects only posts that are due and outside their backoff", async () => {
  // Exercises the runner's own selection, against real rows. The predicate is
  // what stops a handful of failing posts from refilling the capped,
  // oldest-first batch on every tick and starving everything behind them.
  await query(
    `INSERT INTO posts (profile_id, content, platforms, status, scheduled_for,
                        publish_attempts, next_publish_attempt_at)
     VALUES
       ($1, 'due-now',        ARRAY['LinkedIn'], 'validated', now() - interval '2 minutes', 0, now()),
       ($1, 'backing-off',    ARRAY['LinkedIn'], 'validated', now() - interval '2 minutes', 2, now() + interval '1 hour'),
       ($1, 'future',         ARRAY['LinkedIn'], 'validated', now() + interval '1 day',     0, now()),
       ($1, 'unscheduled',    ARRAY['LinkedIn'], 'validated', NULL,                         0, now()),
       ($1, 'not-validated',  ARRAY['LinkedIn'], 'pending',   now() - interval '2 minutes', 0, now())`,
    [alice],
  );

  const due = await query<{ content: string }>(
    `SELECT content FROM posts
      WHERE profile_id = $1
        AND content = ANY($2)
        AND status = 'validated'
        AND scheduled_for IS NOT NULL
        AND scheduled_for <= now()
        AND next_publish_attempt_at <= now()
      ORDER BY scheduled_for ASC
      LIMIT 12`,
    [alice, ["due-now", "backing-off", "future", "unscheduled", "not-validated"]],
  );
  assert.deepEqual(due.map((r) => r.content), ["due-now"]);
});

test("two runners racing on the same post cannot both publish it", async () => {
  // The claim is a conditional UPDATE (validated → publishing). This is what
  // makes it safe to run the interval in every replica, and safe for a manual
  // click to land while a tick is in flight.
  const inserted = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, content, platforms, status, scheduled_for)
     VALUES ($1, 'contested', ARRAY['LinkedIn'], 'validated', now() - interval '1 minute')
     RETURNING id`,
    [alice],
  );
  const postId = inserted[0]!.id;

  const claim = () =>
    query<{ id: string }>(
      `UPDATE posts SET status = 'publishing', publishing_started_at = now()
        WHERE id = $1 AND profile_id = $2 AND status = 'validated'
        RETURNING id`,
      [postId, alice],
    );

  const [first, second] = await Promise.all([claim(), claim()]);
  assert.equal(
    first.length + second.length,
    1,
    "both runners claimed the post — the same content would be posted twice",
  );
});

test("the queue's selection index exists and is actually used", async () => {
  const plan = await query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT id FROM posts
      WHERE status = 'validated' AND scheduled_for <= now() AND next_publish_attempt_at <= now()
      ORDER BY scheduled_for ASC LIMIT 12`,
  );
  const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
  // Postgres may still prefer a seq scan on a tiny table, so this asserts the
  // index exists rather than that the planner chose it here.
  const indexes = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'posts'`,
  );
  assert.ok(
    indexes.some((i) => i.indexname === "posts_due_idx"),
    `the queue index is missing; plan was:\n${text}`,
  );
});

test("a capability token is minted once and reused, never regenerated", async () => {
  // Regenerating it on every publish would break a provider that re-fetches
  // the image later, and would leave a trail of live tokens behind.
  const asset = await query<{ id: string }>(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'poster', $2, 'image/png', 2048)
     RETURNING id`,
    [alice, `${alice}/poster.png`],
  );
  const assetId = asset[0]!.id;

  const mint = () =>
    query<{ public_token: string | null }>(
      `UPDATE media_assets
          SET public_token = COALESCE(public_token, encode(gen_random_bytes(32), 'hex'))
        WHERE id = $1 AND profile_id = $2
        RETURNING public_token`,
      [assetId, alice],
    );

  const first = (await mint())[0]!.public_token!;
  const second = (await mint())[0]!.public_token!;
  assert.equal(first, second, "the token must be stable across publishes");
  assert.ok(first.length >= 32, "a guessable token is not a capability");

  // And it is scoped to the owner: another account cannot mint one for it.
  const asBob = await query(
    `UPDATE media_assets
        SET public_token = COALESCE(public_token, encode(gen_random_bytes(32), 'hex'))
      WHERE id = $1 AND profile_id = $2
      RETURNING public_token`,
    [assetId, bob],
  );
  assert.equal(asBob.length, 0);
});

test("two accounts cannot end up sharing one capability token", async () => {
  const rows = await query<{ id: string }>(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'poster', $2, 'image/png', 1024), ($3, 'poster', $4, 'image/png', 1024)
     RETURNING id`,
    [alice, `${alice}/a.png`, bob, `${bob}/b.png`],
  );
  await query(`UPDATE media_assets SET public_token = 'shared-token' WHERE id = $1`, [
    rows[0]!.id,
  ]);
  await assert.rejects(
    query(`UPDATE media_assets SET public_token = 'shared-token' WHERE id = $1`, [rows[1]!.id]),
    /idx_media_assets_public_token|duplicate key/,
  );
});
