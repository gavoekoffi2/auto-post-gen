import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";

// Regressions found in the pre-release audit, each pinned against a real
// Postgres, the real routes (Fastify inject) and fake providers on localhost.

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.MEDIA_ROOT ??= "/tmp/psa-test-media";
process.env.NODE_ENV = "test";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
async function fakeServer(handler: Handler): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`);
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits };
}
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

// A 1×1 PNG, inline — the shape some renderers answer with.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const graphisteBodies: Array<Record<string, unknown>> = [];
let graphisteReply: unknown = { job_id: "job-1" };
const graphiste = await fakeServer((req, body, res) => {
  if (req.method === "POST") graphisteBodies.push(JSON.parse(body || "{}"));
  json(res, 200, req.method === "POST" ? graphisteReply : { status: "processing" });
});
// Another origin, standing in for a host a status URL must never reach.
const elsewhere = await fakeServer((_req, _body, res) => json(res, 200, { status: "processing" }));

let zernioPost: unknown = {};
const zernio = await fakeServer((req, _body, res) => {
  if (req.url?.startsWith("/accounts")) {
    return json(res, 200, { accounts: [{ _id: "acc-li", platform: "linkedin", isActive: true }] });
  }
  json(res, 200, zernioPost);
});

process.env.GRAPHISTE_GPT_API_KEY = "fake-key";
process.env.GRAPHISTE_GPT_API_URL = `${graphiste.origin}/v1/posters/generate`;
process.env.ZERNIO_API_KEY = "fake-zernio";
process.env.ZERNIO_API_URL = zernio.origin;
process.env.APP_PUBLIC_URL = "https://app.example.test";
process.env.OPENROUTER_API_KEY = "fake-openrouter";

const { default: Fastify } = await import("fastify");
const { default: cookie } = await import("@fastify/cookie");
const { pool, query, queryOne } = await import("../dist/src/lib/db.js");
const { env } = await import("../dist/src/lib/env.js");
const { HttpError } = await import("../dist/src/lib/errors.js");
const { isNonPublicAddress, publicOnlyLookup } = await import("../dist/src/lib/network.js");
const { asImageUrl } = await import("../dist/src/lib/validate.js");
const { rehostRemoteImage, resolveMediaPath, storeBuffer } = await import("../dist/src/lib/media.js");
const { readJob, safeGraphisteStatusUrl, startPosterJob } = await import(
  "../dist/src/services/generation.js"
);
const { publishPost } = await import("../dist/src/services/publish.js");
const { pruneStaleRows } = await import("../dist/src/services/scheduler.js");
const { generateWeekFor } = await import("../dist/src/services/weekly.js");
const { authRoutes } = await import("../dist/src/routes/auth.js");
const { miscRoutes } = await import("../dist/src/routes/misc.js");
const { postRoutes } = await import("../dist/src/routes/posts.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk arbitrary JSON bodies
type Json = Record<string, any>;

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_COOKIE_SECRET });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message, code: error.code });
  return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: String(error) });
});
await app.register(async (scope) => {
  await authRoutes(scope);
  await miscRoutes(scope);
  await postRoutes(scope);
}, { prefix: "/api" });

const stamp = Date.now();
const created: string[] = [];
let ip = 1;
const nextIp = () => `10.88.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;

async function register(label: string): Promise<{ id: string; cookie: string; email: string }> {
  const email = `${label}-${stamp}@example.test`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: nextIp(),
    payload: { email, password: "correct-horse-battery" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = (res.json() as Json).user.id as string;
  created.push(id);
  const raw = res.headers["set-cookie"];
  return { id, email, cookie: (Array.isArray(raw) ? raw[0]! : String(raw)).split(";")[0]! };
}

const poster = (profileId: string, postId: string, extra: Record<string, unknown> = {}) => ({
  profileId,
  postId,
  postContent: "La boutique ouvre samedi.",
  contentCategory: "value" as const,
  platforms: ["LinkedIn"],
  companyName: "Boutique",
  sector: "Commerce",
  description: "",
  footerText: "",
  colors: [],
  logoUrl: null,
  ...extra,
});

async function newPost(profileId: string, imageUrl: string | null = null): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, title, content, platforms, status, image_url)
     VALUES ($1, 't', 'Bonjour.', ARRAY['LinkedIn'], 'validated', $2)
     RETURNING id`,
    [profileId, imageUrl],
  );
  return row!.id;
}

after(async () => {
  await query(`DELETE FROM profiles WHERE id = ANY($1)`, [created]);
  await app.close();
  await pool.end();
  for (const s of [graphiste, elsewhere, zernio]) await new Promise((r) => s.server.close(r));
});

// ── Outbound requests ──────────────────────────────────────────────────

test("non-public addresses are recognised in every spelling", () => {
  for (const a of ["127.0.0.1", "10.0.0.8", "100.64.0.1", "169.254.169.254", "192.168.1.1",
                   "::1", "fe80::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0.0.0.0"]) {
    assert.equal(isNonPublicAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:808:808"]) {
    assert.equal(isNonPublicAddress(a), false, a);
  }
});

test("an image URL on an internal address is refused, however it is written", () => {
  for (const url of [
    "https://[::ffff:127.0.0.1]/x.png",
    "https://[fd00::1]/x.png",
    "https://100.64.3.4/x.png",
    "https://localhost./x.png",
    "https://metadata.internal/x.png",
    "https://2130706433/x.png",
  ]) {
    assert.throws(() => asImageUrl(url, "image_url"), /adresse interne|https/, url);
  }
  assert.equal(asImageUrl("https://cdn.example.com/x.png", "image_url"), "https://cdn.example.com/x.png");
});

test("the fetch resolver refuses a name that resolves to an internal address", async () => {
  const outcome = await new Promise<string>((resolve) => {
    publicOnlyLookup("localhost", {}, (err) => resolve(err ? (err as { code?: string }).code ?? "error" : "ok"));
  });
  assert.equal(outcome, "ENONPUBLIC");
});

test("a status URL is only polled on the configured provider's origin", async () => {
  assert.equal(
    safeGraphisteStatusUrl(`${graphiste.origin}/v1/posters/abc`),
    `${graphiste.origin}/v1/posters/abc`,
  );
  assert.equal(safeGraphisteStatusUrl("/v1/posters/abc"), `${graphiste.origin}/v1/posters/abc`);
  assert.equal(safeGraphisteStatusUrl(`${elsewhere.origin}/steal`), null);
  assert.equal(safeGraphisteStatusUrl("https://attacker.example/steal"), null);

  // A job recorded with a foreign status URL (before the check existed):
  // polling it never sends the API key there.
  const account = await register("status-url");
  const [job] = await query<{ id: string }>(
    `INSERT INTO generation_jobs (profile_id, kind, status, provider, provider_status_url, format)
     VALUES ($1, 'image', 'processing', 'graphiste', $2, 'null'::jsonb) RETURNING id`,
    [account.id, `${elsewhere.origin}/steal`],
  );
  await readJob(account.id, job!.id);
  assert.equal(elsewhere.hits.length, 0, "the foreign host was never contacted");
});

// ── Posters ────────────────────────────────────────────────────────────

test("the account's logo reaches the renderer as a fetchable capability URL", async () => {
  const account = await register("logo");
  const logo = await storeBuffer(account.id, Buffer.from(PNG_1PX, "base64"), "image/png");
  const [asset] = await query<{ id: string }>(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'logo', $2, 'image/png', $3) RETURNING id`,
    [account.id, logo.storagePath, logo.sizeBytes],
  );
  const postId = await newPost(account.id);
  graphisteBodies.length = 0;
  graphisteReply = { job_id: "job-logo" };
  await startPosterJob(poster(account.id, postId, { logoUrl: `/api/media/${asset!.id}/file` }));
  const sent = graphisteBodies[0]!.logo_urls as string[];
  assert.match(sent[0]!, /^https:\/\/app\.example\.test\/api\/media\/public\/[0-9a-f]{64}$/);

  // Without a public address there is nothing fetchable to send: no logo,
  // rather than a relative path the renderer cannot use.
  const saved = env.appPublicUrl;
  env.appPublicUrl = "";
  try {
    await startPosterJob(poster(account.id, postId, { logoUrl: `/api/media/${asset!.id}/file` }));
    assert.equal("logo_urls" in graphisteBodies[1]!, false);
  } finally {
    env.appPublicUrl = saved;
  }
});

test("a poster delivered inline (data URL) is stored, not recorded as a data URI", async () => {
  const account = await register("data-url");
  const postId = await newPost(account.id);
  graphisteReply = { status: "completed", image_url: `data:image/png;base64,${PNG_1PX}` };
  try {
    const job = await startPosterJob(poster(account.id, postId));
    assert.equal(job.status, "completed");
    assert.match(job.result_url!, /^\/api\/media\/[0-9a-f-]{36}\/file$/);
  } finally {
    graphisteReply = { job_id: "job-1" };
  }
  const stored = await rehostRemoteImage(account.id, `data:image/png;base64,${PNG_1PX}`);
  assert.ok(existsSync(resolveMediaPath(stored.storagePath)));
  await assert.rejects(rehostRemoteImage(account.id, "data:image/svg+xml;base64,PHN2Zy8+"));
});

// ── Publishing ─────────────────────────────────────────────────────────

test("a post the provider accepted but queued is never sent a second time", async () => {
  const account = await register("queued");
  await query(
    `INSERT INTO social_connections (profile_id, provider, platform, account_id, provider_profile_key, is_active)
     VALUES ($1, 'zernio', 'linkedin', 'acc-li', 'pk-1', true)`,
    [account.id],
  );
  const postId = await newPost(account.id);
  zernioPost = { post: { _id: "zp-1", platforms: [{ platform: "linkedin", status: "queued" }] } };
  const results = await publishPost(account.id, postId);
  assert.equal(results[0]!.status, "pending");
  const row = await queryOne<{ status: string; provider_post_id: string | null }>(
    `SELECT status, provider_post_id FROM posts WHERE id = $1`,
    [postId],
  );
  // Not back in the queue, where it would be posted again — and not shown as
  // published before the network confirms it.
  assert.equal(row!.status, "publishing");
  assert.equal(row!.provider_post_id, "zp-1");
  const again = await publishPost(account.id, postId);
  assert.deepEqual(again, [], "a second run finds nothing to publish");
  // Crash recovery settles it as published, never as a retry.
  await query(
    `UPDATE posts SET publishing_started_at = now() - interval '20 minutes' WHERE id = $1`,
    [postId],
  );
  await query(`SELECT recover_stuck_publishing()`);
  const settled = await queryOne<{ status: string; publish_attempts: number }>(
    `SELECT status, publish_attempts FROM posts WHERE id = $1`,
    [postId],
  );
  assert.equal(settled!.status, "published");
});

test("an image that cannot be shared fails the attempt instead of wedging the post", async () => {
  const account = await register("no-public-url");
  await query(
    `INSERT INTO social_connections (profile_id, provider, platform, account_id, provider_profile_key, is_active)
     VALUES ($1, 'zernio', 'linkedin', 'acc-li', 'pk-2', true)`,
    [account.id],
  );
  const postId = await newPost(account.id, "/api/media/00000000-0000-0000-0000-000000000001/file");
  const saved = env.appPublicUrl;
  env.appPublicUrl = "";
  try {
    const results = await publishPost(account.id, postId);
    assert.equal(results[0]!.status, "error");
    assert.match(results[0]!.message!, /APP_PUBLIC_URL/);
  } finally {
    env.appPublicUrl = saved;
  }
  const row = await queryOne<{ status: string }>(`SELECT status FROM posts WHERE id = $1`, [postId]);
  assert.equal(row!.status, "failed", "not left in 'publishing'");
});

test("a post being sent, or already sent, cannot be validated back into the queue", async () => {
  const account = await register("revalidate");
  const post = async (status: string) =>
    (await query<{ id: string }>(
      `INSERT INTO posts (profile_id, title, content, platforms, status)
       VALUES ($1, 't', 'x', ARRAY['LinkedIn'], $2) RETURNING id`,
      [account.id, status],
    ))[0]!.id;
  const validate = (id: string) =>
    app.inject({ method: "POST", url: `/api/posts/${id}/validate`, headers: { cookie: account.cookie } });
  for (const status of ["publishing", "published"]) {
    const res = await validate(await post(status));
    assert.equal(res.statusCode, 409, `${status}: ${res.body}`);
  }
  for (const status of ["pending", "failed"]) {
    const res = await validate(await post(status));
    assert.equal(res.statusCode, 200, `${status}: ${res.body}`);
    assert.equal((res.json() as Json).status, "validated");
  }

  // Regenerated text updates the post's category with it.
  const id = await post("pending");
  const patched = await app.inject({
    method: "PATCH",
    url: `/api/posts/${id}`,
    headers: { cookie: account.cookie },
    payload: { content: "Nouveau texte.", content_category: "promo" },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((patched.json() as Json).content_category, "promo");
  const bad = await app.inject({
    method: "PATCH",
    url: `/api/posts/${id}`,
    headers: { cookie: account.cookie },
    payload: { content_category: "spam" },
  });
  assert.equal(bad.statusCode, 400);
});

test("crash recovery gives up on a post after the retry budget", async () => {
  const account = await register("recovery");
  const stuck = async (attempts: number) =>
    (await query<{ id: string }>(
      `INSERT INTO posts (profile_id, title, content, platforms, status, publishing_started_at, publish_attempts)
       VALUES ($1, 't', 'x', ARRAY['LinkedIn'], 'publishing', now() - interval '20 minutes', $2)
       RETURNING id`,
      [account.id, attempts],
    ))[0]!.id;
  const last = await stuck(4);
  const early = await stuck(1);
  await query(`SELECT recover_stuck_publishing()`);
  const status = async (id: string) =>
    (await queryOne<{ status: string }>(`SELECT status FROM posts WHERE id = $1`, [id]))!.status;
  assert.equal(await status(last), "failed");
  assert.equal(await status(early), "validated");
});

// ── Accounts ───────────────────────────────────────────────────────────

test("two sign-ups for the same address at once: one account, one clear refusal", async () => {
  const email = `race-${stamp}@example.test`;
  const [a, b] = await Promise.all(
    [0, 1].map(() =>
      app.inject({
        method: "POST",
        url: "/api/auth/register",
        remoteAddress: nextIp(),
        payload: { email, password: "correct-horse-battery" },
      }),
    ),
  );
  const codes = [a!.statusCode, b!.statusCode].sort();
  assert.deepEqual(codes, [201, 409]);
  const row = await queryOne<{ id: string }>(`SELECT id FROM profiles WHERE email = $1`, [email]);
  created.push(row!.id);
});

test("login attempts are limited per address, not for a whole shared network", async () => {
  const account = await register("login-limit");
  const shared = nextIp();
  const attempt = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: shared, payload: { email, password } });
  for (let i = 0; i < 10; i++) assert.equal((await attempt(account.email, "wrong-password")).statusCode, 401);
  assert.equal((await attempt(account.email, "wrong-password")).statusCode, 429);
  // Someone else on the same carrier IP still signs in.
  const other = await register("login-neighbour");
  assert.equal((await attempt(other.email, "correct-horse-battery")).statusCode, 200);
});

test("deleting an account that has a poster character works", async () => {
  const account = await register("delete-character");
  const file = await storeBuffer(account.id, Buffer.from(PNG_1PX, "base64"), "image/png");
  const [asset] = await query<{ id: string }>(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'other', $2, 'image/png', $3) RETURNING id`,
    [account.id, file.storagePath, file.sizeBytes],
  );
  await query(
    `UPDATE profiles SET poster_character_asset_id = $2, poster_character_enabled = true WHERE id = $1`,
    [account.id, asset!.id],
  );
  const res = await app.inject({
    method: "DELETE",
    url: "/api/account",
    headers: { cookie: account.cookie },
    payload: { password: "correct-horse-battery" },
  });
  assert.equal(res.statusCode, 204, res.body);
  assert.equal(await queryOne(`SELECT 1 FROM profiles WHERE id = $1`, [account.id]), null);
});

// ── Plans and maintenance ─────────────────────────────────────────────

test("automatic generation counts against the plan's monthly ceiling", async () => {
  const account = await register("weekly-ceiling");
  // The trial runs on Pro: 150 texts per rolling 30 days, all used.
  await query(
    `INSERT INTO generation_usage (profile_id, function_name, status, created_at)
     SELECT $1, 'generate-text', 'reserved', now() - interval '2 hours' FROM generate_series(1, 150)`,
    [account.id],
  );
  const result = await generateWeekFor(account.id);
  assert.equal(result.generated, 0);
  assert.equal(result.skipped, "plan_limit_reached");
  const usage = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM generation_usage WHERE profile_id = $1`,
    [account.id],
  );
  assert.equal(usage!.n, 150, "nothing generated, nothing recorded");
});

test("the daily maintenance removes stale sessions, rate events and tokens", async () => {
  const account = await register("prune");
  await query(
    `INSERT INTO ip_rate_events (bucket, created_at) VALUES ('prune-test', now() - interval '3 days'),
                                                          ('prune-test', now())`,
  );
  await query(
    `INSERT INTO sessions (profile_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 day')`,
    [account.id, `expired-${stamp}`],
  );
  const removed = await pruneStaleRows();
  assert.ok(removed >= 2);
  const left = await query(`SELECT 1 FROM ip_rate_events WHERE bucket = 'prune-test'`);
  assert.equal(left.length, 1, "the recent event stays");
  assert.equal(await queryOne(`SELECT 1 FROM sessions WHERE token_hash = $1`, [`expired-${stamp}`]), null);
});
