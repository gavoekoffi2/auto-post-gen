import type { FastifyInstance } from "fastify";
import { query, queryOne, transaction } from "../lib/db.js";
import { badRequest, notFound, tooLarge } from "../lib/errors.js";
import { deleteStoredFile, storeBuffer } from "../lib/media.js";
import { hitRateLimit } from "../lib/rateLimit.js";
import { requireTenant } from "../lib/tenant.js";
import { asObject, asUuid } from "../lib/validate.js";
import { prepareCharacter } from "../services/character.js";
import { MAX_POSES, isFacing, isGesture, type Facing, type Gesture } from "../services/poses.js";
import { loadProfile } from "./profile.js";

/** A phone photo is often larger than the 5 MB of an ordinary upload. */
export const CHARACTER_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

/**
 * The poster character: its poses (the same person in different gestures,
 * each cut out on this server), added, edited and removed here.
 *
 * Switching it on or off by default and choosing its side are ordinary
 * profile settings (PATCH /profile: poster_character_enabled,
 * poster_character_position); a post can override the default
 * (PATCH /posts/:id: include_character).
 */
export async function characterRoutes(app: FastifyInstance): Promise<void> {
  app.post("/profile/poster-character", async (request, reply) => {
    const ctx = await requireTenant(request, reply);

    if (!request.isMultipart()) {
      throw badRequest("L'envoi de l'image doit être en multipart/form-data.");
    }

    let rightsConfirmed = false;
    let gesture: Gesture = "neutre";
    let facing: Facing = "front";
    let upload: Buffer | null = null;
    for await (const part of request.parts({ limits: { fileSize: CHARACTER_UPLOAD_MAX_BYTES, files: 1 } })) {
      if (part.type === "field") {
        const value = String(part.value);
        if (part.fieldname === "rights_confirmed") rightsConfirmed = value === "true";
        if (part.fieldname === "gesture") {
          if (!isGesture(value)) throw badRequest("Geste inconnu.");
          gesture = value;
        }
        if (part.fieldname === "facing") {
          if (!isFacing(value)) throw badRequest("Orientation inconnue.");
          facing = value;
        }
        continue;
      }
      if (upload) throw badRequest("Un seul fichier par envoi.");
      try {
        upload = await part.toBuffer();
      } catch {
        throw tooLarge(
          `L'image ne doit pas dépasser ${Math.floor(CHARACTER_UPLOAD_MAX_BYTES / (1024 * 1024))} Mo.`,
        );
      }
    }
    if (!upload || upload.length === 0) throw badRequest("Aucune image reçue.");

    // Each upload runs a few seconds of segmentation: bounded per account.
    // Checked once the body is read, not before: behind nginx, answering
    // while a 12 MB photo is still arriving closes the connection under it,
    // and the user gets "502 Bad Gateway" instead of this message.
    await hitRateLimit(
      `poster-character:${ctx.profileId}`,
      20,
      3600,
      "Trop d'envois d'image de personnage. Réessayez dans une heure.",
    );

    // The image of a real person ends up on public posts: the account states
    // that it holds the right to use it. Recorded, never inferred.
    if (!rightsConfirmed) {
      throw badRequest(
        "Confirmez que vous avez le droit d'utiliser cette image (droit à l'image de la personne " +
          "représentée) avant de l'envoyer.",
        "rights_required",
      );
    }

    const count = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM poster_character_poses WHERE profile_id = $1`,
      [ctx.profileId],
    );
    const existing = count?.n ?? 0;
    if (existing >= MAX_POSES) {
      throw badRequest(
        `${MAX_POSES} poses au maximum. Supprimez-en une avant d'en ajouter une autre.`,
        "too_many_poses",
      );
    }

    // Decoded, cut out and re-encoded here: whatever was uploaded, what is
    // stored is a PNG this server produced.
    const prepared = await prepareCharacter(upload);
    const stored = await storeBuffer(ctx.profileId, prepared.png, "image/png");

    let poseId: string;
    try {
      poseId = await transaction(async (client) => {
        const asset = (
          await client.query<{ id: string }>(
            `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
             VALUES ($1, 'other', $2, $3, $4) RETURNING id`,
            [ctx.profileId, stored.storagePath, stored.mimeType, stored.sizeBytes],
          )
        ).rows[0]!;
        const pose = (
          await client.query<{ id: string }>(
            `INSERT INTO poster_character_poses (profile_id, asset_id, gesture, facing, width, height)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [ctx.profileId, asset.id, gesture, facing, prepared.width, prepared.height],
          )
        ).rows[0]!;
        // The first pose switches the feature on; later ones leave the
        // account's own choice alone.
        await client.query(
          `UPDATE profiles
              SET poster_character_enabled = poster_character_enabled OR $2,
                  poster_character_rights_at = now()
            WHERE id = $1`,
          [ctx.profileId, existing === 0],
        );
        return pose.id;
      });
    } catch (err) {
      await deleteStoredFile(stored.storagePath);
      throw err;
    }

    return reply.code(201).send({
      profile: await loadProfile(ctx.profileId),
      pose: { id: poseId, gesture, facing },
      character: {
        width: prepared.width,
        height: prepared.height,
        cutOut: prepared.cutOut,
        lowResolution: prepared.lowResolution,
      },
    });
  });

  app.patch("/profile/poster-character/poses/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");
    const body = asObject(request.body, "body");
    const gesture = "gesture" in body ? body.gesture : undefined;
    const facing = "facing" in body ? body.facing : undefined;
    if (gesture !== undefined && !isGesture(gesture)) throw badRequest("Geste inconnu.");
    if (facing !== undefined && !isFacing(facing)) throw badRequest("Orientation inconnue.");
    const row = await queryOne(
      `UPDATE poster_character_poses
          SET gesture = COALESCE($3, gesture), facing = COALESCE($4, facing)
        WHERE id = $1 AND profile_id = $2
        RETURNING id`,
      [id, ctx.profileId, gesture ?? null, facing ?? null],
    );
    if (!row) throw notFound("Pose introuvable.");
    return reply.send({ profile: await loadProfile(ctx.profileId) });
  });

  app.delete("/profile/poster-character/poses/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");
    // Deleting the media deletes the pose with it (ON DELETE CASCADE).
    const removed = await queryOne<{ storage_path: string }>(
      `DELETE FROM media_assets m
        USING poster_character_poses x
        WHERE x.id = $1 AND x.profile_id = $2 AND m.id = x.asset_id AND m.profile_id = $2
        RETURNING m.storage_path`,
      [id, ctx.profileId],
    );
    if (!removed) throw notFound("Pose introuvable.");
    await deleteStoredFile(removed.storage_path);
    // No pose left: nothing to show, the feature switches off.
    await query(
      `UPDATE profiles SET poster_character_enabled = false
        WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM poster_character_poses WHERE profile_id = $1)`,
      [ctx.profileId],
    );
    return reply.send({ profile: await loadProfile(ctx.profileId) });
  });

  app.delete("/profile/poster-character", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const removed = await query<{ storage_path: string }>(
      `DELETE FROM media_assets m
        USING poster_character_poses x
        WHERE x.profile_id = $1 AND m.id = x.asset_id AND m.profile_id = $1
        RETURNING m.storage_path`,
      [ctx.profileId],
    );
    // The single cut-out of 0006, if it was never turned into a pose.
    const legacy = await queryOne<{ storage_path: string }>(
      `DELETE FROM media_assets m USING profiles p
        WHERE p.id = $1 AND m.id = p.poster_character_asset_id AND m.profile_id = $1
        RETURNING m.storage_path`,
      [ctx.profileId],
    );
    await query(
      `UPDATE profiles
          SET poster_character_asset_id = NULL, poster_character_enabled = false,
              poster_character_rights_at = NULL
        WHERE id = $1`,
      [ctx.profileId],
    );
    for (const row of [...removed, ...(legacy ? [legacy] : [])]) await deleteStoredFile(row.storage_path);
    return reply.send({ profile: await loadProfile(ctx.profileId) });
  });
}
