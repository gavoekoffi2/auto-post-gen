import type { FastifyInstance } from "fastify";
import { query, queryOne, transaction } from "../lib/db.js";
import { badRequest, tooLarge } from "../lib/errors.js";
import { deleteStoredFile, storeBuffer } from "../lib/media.js";
import { hitRateLimit } from "../lib/rateLimit.js";
import { requireTenant } from "../lib/tenant.js";
import { prepareCharacter } from "../services/character.js";
import { loadProfile } from "./profile.js";

/** A phone photo is often larger than the 5 MB of an ordinary upload. */
export const CHARACTER_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

/**
 * The poster character: upload (cut out on this server) and removal.
 *
 * Switching it on or off and choosing its side are ordinary profile settings
 * (PATCH /profile: poster_character_enabled, poster_character_position).
 */
export async function characterRoutes(app: FastifyInstance): Promise<void> {
  app.post("/profile/poster-character", async (request, reply) => {
    const ctx = await requireTenant(request, reply);

    if (!request.isMultipart()) {
      throw badRequest("L'envoi de l'image doit être en multipart/form-data.");
    }

    let rightsConfirmed = false;
    let upload: Buffer | null = null;
    for await (const part of request.parts({ limits: { fileSize: CHARACTER_UPLOAD_MAX_BYTES, files: 1 } })) {
      if (part.type === "field") {
        if (part.fieldname === "rights_confirmed") rightsConfirmed = String(part.value) === "true";
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
      10,
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

    // Decoded, cut out and re-encoded here: whatever was uploaded, what is
    // stored is a PNG this server produced.
    const prepared = await prepareCharacter(upload);
    const stored = await storeBuffer(ctx.profileId, prepared.png, "image/png");

    let previous: { id: string; storage_path: string } | null = null;
    try {
      previous = await transaction(async (client) => {
        const old = (
          await client.query<{ id: string; storage_path: string }>(
            `SELECT m.id, m.storage_path
               FROM profiles p JOIN media_assets m ON m.id = p.poster_character_asset_id
              WHERE p.id = $1 FOR UPDATE OF p`,
            [ctx.profileId],
          )
        ).rows[0] ?? null;
        const asset = (
          await client.query<{ id: string }>(
            `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
             VALUES ($1, 'other', $2, $3, $4) RETURNING id`,
            [ctx.profileId, stored.storagePath, stored.mimeType, stored.sizeBytes],
          )
        ).rows[0]!;
        await client.query(
          `UPDATE profiles
              SET poster_character_asset_id = $2,
                  poster_character_enabled = true,
                  poster_character_rights_at = now()
            WHERE id = $1`,
          [ctx.profileId, asset.id],
        );
        if (old) await client.query(`DELETE FROM media_assets WHERE id = $1 AND profile_id = $2`, [old.id, ctx.profileId]);
        return old;
      });
    } catch (err) {
      await deleteStoredFile(stored.storagePath);
      throw err;
    }
    // Files after the commit: a rolled-back swap must not have lost the old one.
    if (previous) await deleteStoredFile(previous.storage_path);

    return reply.code(201).send({
      profile: await loadProfile(ctx.profileId),
      character: {
        width: prepared.width,
        height: prepared.height,
        cutOut: prepared.cutOut,
        lowResolution: prepared.lowResolution,
      },
    });
  });

  app.delete("/profile/poster-character", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const old = await queryOne<{ id: string; storage_path: string }>(
      `SELECT m.id, m.storage_path
         FROM profiles p JOIN media_assets m ON m.id = p.poster_character_asset_id
        WHERE p.id = $1`,
      [ctx.profileId],
    );
    await query(
      `UPDATE profiles
          SET poster_character_asset_id = NULL, poster_character_enabled = false,
              poster_character_rights_at = NULL
        WHERE id = $1`,
      [ctx.profileId],
    );
    if (old) {
      await query(`DELETE FROM media_assets WHERE id = $1 AND profile_id = $2`, [old.id, ctx.profileId]);
      await deleteStoredFile(old.storage_path);
    }
    return reply.send({ profile: await loadProfile(ctx.profileId) });
  });
}
