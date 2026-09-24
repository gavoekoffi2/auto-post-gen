import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The account's visual identity on posters: poses chosen for each message,
// mirrored toward the content, and the migration that turns the single
// cut-out of 0006 into the first pose. Real Postgres; no model provider
// configured, so the gesture is chosen by the deterministic ranking.

process.env.SESSION_COOKIE_SECRET ??= "test-secret-that-is-long-enough-for-the-check";
process.env.MEDIA_ROOT ??= "/tmp/psa-test-media";
process.env.NODE_ENV = "test";
delete process.env.OPENROUTER_API_KEY;

const { default: sharp } = await import("sharp");
const { pool, query, queryOne } = await import("../dist/src/lib/db.js");
const { storeBuffer } = await import("../dist/src/lib/media.js");
const { choosePose, rankGestures } = await import("../dist/src/services/poses.js");
const { posterLayout, shouldMirror } = await import("../dist/src/services/branding.js");
const { composePoster } = await import("../dist/src/services/character.js");

const stamp = Date.now();
const created: string[] = [];

async function account(label: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO profiles (email) VALUES ($1) RETURNING id`,
    [`${label}-${stamp}@example.test`],
  );
  created.push(row!.id);
  return row!.id;
}

async function addPose(profileId: string, gesture: string, facing = "front"): Promise<string> {
  const png = await sharp({ create: { width: 40, height: 80, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const file = await storeBuffer(profileId, png, "image/png");
  const [asset] = await query<{ id: string }>(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'other', $2, 'image/png', $3) RETURNING id`,
    [profileId, file.storagePath, file.sizeBytes],
  );
  const [pose] = await query<{ id: string }>(
    `INSERT INTO poster_character_poses (profile_id, asset_id, gesture, facing)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [profileId, asset!.id, gesture, facing],
  );
  return pose!.id;
}

after(async () => {
  await query(`DELETE FROM profiles WHERE id = ANY($1)`, [created]);
  await pool.end();
});

test("the gesture follows the message", () => {
  assert.equal(rankGestures("Découvrez notre nouvelle offre de rentrée !", "promo")[0], "presente");
  assert.equal(rankGestures("Astuce : 3 étapes pour garder vos clients", "value")[0], "explique");
  assert.equal(rankGestures("Félicitations à toute l'équipe pour ce succès 🎉", "value")[0], "celebre");
  assert.equal(rankGestures("Pourquoi vos ventes stagnent-elles ?", "research")[0], "reflechit");
  assert.equal(rankGestures("Bienvenue dans notre nouvelle boutique", "value")[0], "accueille");
  // Every gesture is always ranked, so any set of poses gets an answer.
  assert.equal(new Set(rankGestures("x", "value")).size, 9);
});

test("each poster gets the pose that suits it, rotating among poses of the same gesture", async () => {
  const id = await account("poses");
  assert.equal(await choosePose(id, "Bonjour", "value"), null, "no pose, no character");

  const presente1 = await addPose(id, "presente");
  const presente2 = await addPose(id, "presente");
  const explique = await addPose(id, "explique");

  const promo1 = await choosePose(id, "Découvrez notre nouvelle offre", "promo");
  const promo2 = await choosePose(id, "Découvrez notre nouvelle offre", "promo");
  assert.equal(promo1!.gesture, "presente");
  assert.equal(promo2!.gesture, "presente");
  assert.deepEqual(new Set([promo1!.poseId, promo2!.poseId]), new Set([presente1, presente2]), "both photos used in turn");

  const tip = await choosePose(id, "Astuce : la méthode en 3 étapes", "value");
  assert.equal(tip!.poseId, explique);

  // A message with no clear match still gets a pose.
  assert.ok(await choosePose(id, "Bonne semaine", "value"));
});

test("a pose facing away from the poster's centre is mirrored toward the content", async () => {
  assert.equal(shouldMirror("right", "right"), true);
  assert.equal(shouldMirror("left", "left"), true);
  assert.equal(shouldMirror("right", "left"), false);
  assert.equal(shouldMirror("left", "front"), false);

  // A figure whose left half is green and right half red: once mirrored on
  // the right side, the red half is on the left.
  const figure = await sharp({
    create: { width: 200, height: 400, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } },
  })
    .composite([{ input: { create: { width: 100, height: 400, channels: 4, background: "#ff0000" } }, left: 100, top: 0 }])
    .png()
    .toBuffer();
  const poster = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const leftHalfColour = async (mirror: boolean) => {
    const out = await composePoster(poster, { character: { image: figure, position: "right", mirror } });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // The character is 320 px wide at most on the right: sample its left quarter.
    let firstX = info.width - 1;
    const y = info.height - 50;
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) { firstX = x; break; }
    }
    const i = (y * info.width + firstX + 20) * info.channels;
    return data[i]! > data[i + 1]! ? "red" : "green";
  };
  assert.equal(await leftHalfColour(false), "green");
  assert.equal(await leftHalfColour(true), "red");
});

test("the layout keeps the logo clear of the character", () => {
  assert.deepEqual(posterLayout(null), { footer: "bottom-left", brand: "bottom-right" });
  assert.deepEqual(posterLayout("right"), { footer: "bottom-left", brand: "top-left" });
  assert.deepEqual(posterLayout("left"), { footer: "bottom-right", brand: "top-right" });
});

test("migration 0009 turns the single cut-out of 0007 into the first pose, once", async () => {
  const id = await account("backfill");
  const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#000" } }).png().toBuffer();
  const file = await storeBuffer(id, png, "image/png");
  const [asset] = await query<{ id: string }>(
    `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
     VALUES ($1, 'other', $2, 'image/png', $3) RETURNING id`,
    [id, file.storagePath, file.sizeBytes],
  );
  await query(`UPDATE profiles SET poster_character_asset_id = $2 WHERE id = $1`, [id, asset!.id]);

  const sql = readFileSync(new URL("../migrations/0009_brand_kit_and_poses.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql); // replayed: idempotent
  const poses = await query<{ gesture: string }>(
    `SELECT gesture FROM poster_character_poses WHERE profile_id = $1`,
    [id],
  );
  assert.deepEqual(poses.map((p) => p.gesture), ["neutre"]);
  const flags = await queryOne<{ poster_logo_enabled: boolean; brand_colors_enabled: boolean }>(
    `SELECT poster_logo_enabled, brand_colors_enabled FROM profiles WHERE id = $1`,
    [id],
  );
  assert.deepEqual(flags, { poster_logo_enabled: true, brand_colors_enabled: true });
});
