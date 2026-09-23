import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync } from "node:fs";

// The poster character, against the real segmentation model, a real Postgres
// and the real routes (Fastify inject).
//
// What is pinned here cannot be read off the code: that the model really
// cuts a figure out of its background, that the cut-out stands on the
// poster's bottom edge on the chosen side, that the provider is told which
// side to keep free — and is NEVER sent the photo — and that a render started
// with a character is finished with it.
//
// The images are synthesised here (no third-party photo is committed).
// `npm test` fetches the pinned model first (scripts/fetch-bg-model.mjs).

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.MEDIA_ROOT ??= "/tmp/psa-test-media";
process.env.NODE_ENV = "test";

// A fake poster provider on localhost records what it is sent.
const received: Array<Record<string, unknown>> = [];
let statusReads = 0;
const provider: Server = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method === "GET") {
      // A status read: the render is finished (on a host the re-host step
      // refuses, so the provider URL is what gets recorded).
      res.setHeader("Content-Type", "application/json");
      statusReads += 1;
      res.end(JSON.stringify({ status: "completed", image_url: "https://poster.invalid/render.png" }));
      return;
    }
    received.push(JSON.parse(body || "{}") as Record<string, unknown>);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ job_id: `fake-${received.length}` }));
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const port = (provider.address() as { port: number }).port;
process.env.GRAPHISTE_GPT_API_KEY = "fake-key";
process.env.GRAPHISTE_GPT_API_URL = `http://127.0.0.1:${port}/v1/posters/generate`;

const { default: sharp } = await import("sharp");
const { default: Fastify } = await import("fastify");
const { default: cookie } = await import("@fastify/cookie");
const { default: multipart } = await import("@fastify/multipart");
const { pool, query, queryOne } = await import("../dist/src/lib/db.js");
const { env } = await import("../dist/src/lib/env.js");
const { HttpError } = await import("../dist/src/lib/errors.js");
const { resolveMediaPath, storeBuffer } = await import("../dist/src/lib/media.js");
const { authRoutes } = await import("../dist/src/routes/auth.js");
const { profileRoutes } = await import("../dist/src/routes/profile.js");
const { characterRoutes } = await import("../dist/src/routes/character.js");
const { prepareCharacter, compositeCharacter, segmentationAvailable } = await import(
  "../dist/src/services/character.js"
);
const { applyCharacter, readJob, startPosterJob } = await import("../dist/src/services/generation.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk arbitrary JSON bodies
type Json = Record<string, any>;

/** A person-like figure — head, hair, neck, shoulders — on a textured background. */
async function figurePhoto(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#dfe7ee"/><stop offset="1" stop-color="#b9c7d3"/></linearGradient></defs>
    <rect width="800" height="1000" fill="url(#bg)"/>
    <ellipse cx="400" cy="300" rx="120" ry="150" fill="#6b3f2a"/>
    <ellipse cx="400" cy="200" rx="130" ry="80" fill="#1b1b1b"/>
    <path d="M170 1000 C170 700 250 500 400 500 C550 500 630 700 630 1000 Z" fill="#c0392b"/>
    <rect x="360" y="430" width="80" height="90" fill="#6b3f2a"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function alphaAt(png: Buffer, fx: number, fy: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = Math.min(info.width - 1, Math.round(fx * (info.width - 1)));
  const y = Math.min(info.height - 1, Math.round(fy * (info.height - 1)));
  return data[(y * info.width + x) * 4 + 3]!;
}

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_COOKIE_SECRET });
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 } });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message, code: error.code });
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  return reply.code(status).send({ error: String(error) });
});
await app.register(async (scope) => {
  await authRoutes(scope);
  await profileRoutes(scope);
  await characterRoutes(scope);
}, { prefix: "/api" });

const stamp = Date.now();
const created: string[] = [];
let account: { id: string; cookie: string };

before(async () => {
  assert.ok(
    segmentationAvailable(),
    `the segmentation model is missing at ${env.bgModelPath} — run: node scripts/fetch-bg-model.mjs`,
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: "10.77.0.1",
    payload: { email: `character-${stamp}@example.test`, password: "correct-horse-battery" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = (res.json() as Json).user.id as string;
  created.push(id);
  const raw = res.headers["set-cookie"];
  account = { id, cookie: (Array.isArray(raw) ? raw[0]! : String(raw)).split(";")[0]! };
});

after(async () => {
  await query(`DELETE FROM profiles WHERE id = ANY($1)`, [created]);
  await app.close();
  await pool.end();
  await new Promise((resolve) => provider.close(resolve));
});

function multipartBody(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----psa${stamp}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    ));
    chunks.push(file.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(fields: Record<string, string>, data?: Buffer) {
  const body = multipartBody(fields, data ? { name: "moi.jpg", type: "image/jpeg", data } : undefined);
  const res = await app.inject({
    method: "POST",
    url: "/api/profile/poster-character",
    headers: { cookie: account.cookie, "content-type": body.contentType },
    payload: body.payload,
  });
  return { status: res.statusCode, body: res.json() as Json };
}

// ── The cut-out ────────────────────────────────────────────────────────

test("a photo is cut out: background transparent, subject opaque, cropped to it", async () => {
  const cut = await prepareCharacter(await figurePhoto());
  assert.equal(cut.cutOut, true);
  assert.ok(cut.width < 800 && cut.height <= 1000, `cropped to the subject (${cut.width}x${cut.height})`);
  assert.equal(await alphaAt(cut.png, 0, 0), 0, "top-left corner is background");
  assert.equal(await alphaAt(cut.png, 1, 0), 0, "top-right corner is background");
  assert.equal(await alphaAt(cut.png, 0.5, 0.3), 255, "the head is kept");
  assert.equal(await alphaAt(cut.png, 0.5, 0.8), 255, "the body is kept");
  // No air under the subject: it must stand on the poster's bottom edge.
  assert.equal(await alphaAt(cut.png, 0.5, 1), 255, "the cut-out ends where the subject ends");
});

test("an image that is already cut out is kept as its author made it", async () => {
  const first = await prepareCharacter(await figurePhoto());
  const again = await prepareCharacter(first.png);
  assert.equal(again.cutOut, false, "no second pass through the model");
  assert.equal(again.width, first.width);
  assert.equal(again.height, first.height);
});

test("an image with nothing to cut out, or not an image at all, is refused with a reason", async () => {
  const flat = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#e5e7eb" } }).jpeg().toBuffer();
  await assert.rejects(prepareCharacter(flat), (err: { code?: string }) => err.code === "no_subject");
  await assert.rejects(
    prepareCharacter(Buffer.from("<html>not an image</html>")),
    (err: { code?: string }) => err.code === "invalid_image",
  );
});

// ── On the poster ──────────────────────────────────────────────────────

test("on the poster, the character stands on the bottom edge of the chosen side", async () => {
  const cut = await prepareCharacter(await figurePhoto());
  const poster = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#1e3a8a" } }).png().toBuffer();
  for (const side of ["left", "right"] as const) {
    const out = await compositeCharacter(poster, cut.png, side);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1080);
    assert.equal(info.height, 1350);
    const isBackground = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return Math.abs(data[i]! - 0x1e) < 24 && Math.abs(data[i + 1]! - 0x3a) < 24 && Math.abs(data[i + 2]! - 0x8a) < 24;
    };
    const bottom = info.height - 2;
    const sideX = side === "left" ? Math.round(info.width * 0.2) : Math.round(info.width * 0.8);
    const otherX = side === "left" ? Math.round(info.width * 0.8) : Math.round(info.width * 0.2);
    assert.equal(isBackground(sideX, bottom), false, `${side}: the character is on its side, on the bottom edge`);
    assert.equal(isBackground(otherX, bottom), true, `${side}: the other side is left alone`);
    assert.equal(isBackground(sideX, 40), true, `${side}: the top of the poster is left alone`);
  }
});

// ── Routes ─────────────────────────────────────────────────────────────

test("the upload requires the rights confirmation, then stores and switches the character on", async () => {
  const photo = await figurePhoto();
  const refused = await upload({}, photo);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "rights_required");

  const ok = await upload({ rights_confirmed: "true" }, photo);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.character.cutOut, true);
  assert.equal(ok.body.profile.poster_character_enabled, true);
  assert.equal(ok.body.profile.poster_character_position, "right");
  assert.match(ok.body.profile.poster_character_url, /^\/api\/media\/[0-9a-f-]{36}\/file$/);
  assert.ok(ok.body.profile.poster_character_rights_at);
  assert.equal("poster_character_asset_id" in ok.body.profile, false);

  // What is stored is the PNG this server produced, not the upload.
  const asset = await queryOne<{ mime_type: string; storage_path: string }>(
    `SELECT m.mime_type, m.storage_path FROM profiles p JOIN media_assets m ON m.id = p.poster_character_asset_id
      WHERE p.id = $1`,
    [account.id],
  );
  assert.equal(asset!.mime_type, "image/png");
  assert.ok(existsSync(resolveMediaPath(asset!.storage_path)));

  // Replacing it removes the previous file and row.
  const replaced = await upload({ rights_confirmed: "true" }, photo);
  assert.equal(replaced.status, 201);
  assert.equal(existsSync(resolveMediaPath(asset!.storage_path)), false, "the previous cut-out is deleted");
});

test("the upload ceiling is the route's 12 MB, not the 5 MB of an ordinary upload", async () => {
  // A 7 MB phone photo reaches the image check (here: not an image) rather
  // than being cut off by the app-wide multipart limit.
  const big = await upload({ rights_confirmed: "true" }, Buffer.alloc(7 * 1024 * 1024, 7));
  assert.equal(big.status, 400, JSON.stringify(big.body));
  assert.equal(big.body.code, "invalid_image");
  const tooBig = await upload({ rights_confirmed: "true" }, Buffer.alloc(13 * 1024 * 1024, 7));
  assert.equal(tooBig.status, 413, JSON.stringify(tooBig.body));
});

test("the side and the on/off switch are settings; the image itself is not writable by PATCH", async () => {
  const patch = (payload: Json) =>
    app.inject({ method: "PATCH", url: "/api/profile", headers: { cookie: account.cookie }, payload });
  let res = await patch({ poster_character_position: "left", poster_character_enabled: false });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as Json).poster_character_position, "left");
  assert.equal((res.json() as Json).poster_character_enabled, false);
  res = await patch({ poster_character_position: "middle" });
  assert.equal(res.statusCode, 400);
  // An asset id or a rights date in the body is ignored.
  const before = await queryOne<{ a: string }>(`SELECT poster_character_asset_id::text AS a FROM profiles WHERE id = $1`, [account.id]);
  res = await patch({ poster_character_asset_id: "00000000-0000-0000-0000-000000000000", poster_character_rights_at: null });
  const afterRow = await queryOne<{ a: string }>(`SELECT poster_character_asset_id::text AS a FROM profiles WHERE id = $1`, [account.id]);
  assert.equal(afterRow!.a, before!.a);
  await patch({ poster_character_enabled: true, poster_character_position: "left" });
});

test("a render started with a character: the provider keeps that side free and never receives the photo", async () => {
  received.length = 0;
  const [post] = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, title, content, content_category, platforms, status)
     VALUES ($1, 't', 'La boulangerie ouvre le dimanche.', 'promo', ARRAY['Instagram'], 'pending') RETURNING id`,
    [account.id],
  );
  const job = await startPosterJob({
    profileId: account.id,
    postId: post!.id,
    postContent: "La boulangerie ouvre le dimanche.",
    contentCategory: "promo",
    platforms: ["Instagram"],
    companyName: "Boulangerie Test",
    sector: "Boulangerie",
    description: "",
    footerText: "",
    colors: [],
    logoUrl: null,
  });
  assert.equal(job.status, "processing");
  assert.equal(received.length, 1);
  const sent = JSON.stringify(received[0]);
  assert.match(String(received[0]!.subject), /Zone réservée[\s\S]*côté gauche/);
  // The layout travels; the image does not — in no field, in no form.
  assert.doesNotMatch(sent, /\/api\/media\//);
  assert.doesNotMatch(sent, /reference_image|base64|data:image/);
  const snapshot = await queryOne<{ character_overlay: Json }>(
    `SELECT character_overlay FROM generation_jobs WHERE id = $1`,
    [job.id],
  );
  assert.equal(snapshot!.character_overlay.position, "left");
  assert.match(snapshot!.character_overlay.assetId, /^[0-9a-f-]{36}$/);

  // Switched off: nothing reserved, nothing snapshotted.
  await query(`UPDATE profiles SET poster_character_enabled = false WHERE id = $1`, [account.id]);
  const plain = await startPosterJob({
    profileId: account.id, postId: post!.id, postContent: "x", contentCategory: "value",
    platforms: ["Instagram"], companyName: "B", sector: "", description: "", footerText: "", colors: [], logoUrl: null,
  });
  assert.doesNotMatch(String(received[1]!.subject), /Zone réservée/);
  const none = await queryOne<{ character_overlay: Json | null }>(
    `SELECT character_overlay FROM generation_jobs WHERE id = $1`,
    [plain.id],
  );
  assert.equal(none!.character_overlay, null);
  await query(`UPDATE profiles SET poster_character_enabled = true WHERE id = $1`, [account.id]);

  // Completing it lays the character on and replaces the provider's file.
  const rendered = await storeBuffer(
    account.id,
    await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#123456" } }).png().toBuffer(),
    "image/png",
  );
  const final = await applyCharacter(account.id, rendered, snapshot!.character_overlay as { assetId: string; position: "left" });
  assert.equal(final.mimeType, "image/jpeg");
  assert.equal(existsSync(resolveMediaPath(rendered.storagePath)), false, "the bare render is replaced");
  const meta = await sharp(resolveMediaPath(final.storagePath)).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
});

test("concurrent status reads settle a render once", async () => {
  const [post] = await query<{ id: string }>(
    `INSERT INTO posts (profile_id, title, content, platforms, status)
     VALUES ($1, 't', 'Deux onglets ouverts.', ARRAY['Instagram'], 'pending') RETURNING id`,
    [account.id],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO generation_jobs (profile_id, post_id, kind, status, provider, provider_job_id, format)
     VALUES ($1, $2, 'image', 'processing', 'graphiste', 'fake-race', 'null'::jsonb) RETURNING id`,
    [account.id, post!.id],
  );
  // Counts the writes that settle this job: exactly one may happen.
  await query(`CREATE TABLE IF NOT EXISTS test_settle_log (job_id uuid)`);
  await query(`CREATE OR REPLACE FUNCTION test_log_settle() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO test_settle_log VALUES (NEW.id); RETURN NEW; END $$`);
  await query(`DROP TRIGGER IF EXISTS test_log_settle ON generation_jobs`);
  await query(`CREATE TRIGGER test_log_settle AFTER UPDATE OF status ON generation_jobs
    FOR EACH ROW WHEN (NEW.status <> 'processing') EXECUTE FUNCTION test_log_settle()`);
  statusReads = 0;
  const [a, b] = await Promise.all([readJob(account.id, job!.id), readJob(account.id, job!.id)]);
  assert.equal(statusReads, 2, "both readers really asked the provider");
  assert.equal(a!.status, "completed");
  assert.equal(b!.status, "completed");
  // The loser returns the winner's row rather than its own copy.
  assert.equal(a!.result_url, b!.result_url);
  const stored = await queryOne<{ status: string; result_url: string }>(
    `SELECT status, result_url FROM generation_jobs WHERE id = $1`,
    [job!.id],
  );
  assert.equal(stored!.result_url, a!.result_url);
  const settles = await query(`SELECT 1 FROM test_settle_log WHERE job_id = $1`, [job!.id]);
  await query(`DROP TRIGGER test_log_settle ON generation_jobs`);
  await query(`DROP TABLE test_settle_log`);
  await query(`DROP FUNCTION test_log_settle()`);
  assert.equal(settles.length, 1, "the job was settled exactly once");
  // Settled: a later read never asks the provider again.
  await readJob(account.id, job!.id);
  assert.equal(statusReads, 2);
});

test("a missing character never costs the paid render", async () => {
  const rendered = await storeBuffer(
    account.id,
    await sharp({ create: { width: 400, height: 500, channels: 3, background: "#000" } }).png().toBuffer(),
    "image/png",
  );
  const kept = await applyCharacter(account.id, rendered, {
    assetId: "00000000-0000-0000-0000-000000000000",
    position: "right",
  });
  assert.equal(kept.storagePath, rendered.storagePath);
  assert.ok(existsSync(resolveMediaPath(rendered.storagePath)));
});

test("removing the character deletes the file and switches the feature off", async () => {
  const asset = await queryOne<{ storage_path: string }>(
    `SELECT m.storage_path FROM profiles p JOIN media_assets m ON m.id = p.poster_character_asset_id WHERE p.id = $1`,
    [account.id],
  );
  const res = await app.inject({ method: "DELETE", url: "/api/profile/poster-character", headers: { cookie: account.cookie } });
  assert.equal(res.statusCode, 200, res.body);
  const profile = (res.json() as Json).profile;
  assert.equal(profile.poster_character_url, null);
  assert.equal(profile.poster_character_enabled, false);
  assert.equal(existsSync(resolveMediaPath(asset!.storage_path)), false);
});
