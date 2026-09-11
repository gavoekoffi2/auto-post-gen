import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { query, queryOne } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";
import {
  MAX_UPLOAD_BYTES,
  asMediaKind,
  deleteStoredFile,
  mediaUrl,
  resolveMediaPath,
  storeUpload,
} from "../lib/media.js";
import { requireTenant } from "../lib/tenant.js";
import { asString, asUuid } from "../lib/validate.js";

interface MediaRow {
  id: string;
  kind: string;
  storage_path: string;
  mime_type: string;
  size_bytes: string;
  created_at: Date;
}

function present(row: MediaRow) {
  return {
    id: row.id,
    url: mediaUrl(row.id),
    kind: row.kind,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    created_at: row.created_at.toISOString(),
  };
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/media", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const kindFilter = (request.query as { kind?: string } | undefined)?.kind;
    const kind = kindFilter ? asMediaKind(kindFilter) : null;

    const rows = await query<MediaRow>(
      kind
        ? `SELECT id, kind, storage_path, mime_type, size_bytes, created_at
             FROM media_assets WHERE profile_id = $1 AND kind = $2
            ORDER BY created_at DESC LIMIT 500`
        : `SELECT id, kind, storage_path, mime_type, size_bytes, created_at
             FROM media_assets WHERE profile_id = $1
            ORDER BY created_at DESC LIMIT 500`,
      kind ? [ctx.profileId, kind] : [ctx.profileId],
    );
    return { media: rows.map(present) };
  });

  app.post("/media", async (request, reply) => {
    const ctx = await requireTenant(request, reply);

    if (!request.isMultipart()) {
      throw badRequest("L'envoi de fichier doit être en multipart/form-data.");
    }

    let stored: Awaited<ReturnType<typeof storeUpload>> | null = null;
    let kind = "other";

    for await (const part of request.parts()) {
      if (part.type === "field" && part.fieldname === "kind") {
        kind = asMediaKind(part.value);
        continue;
      }
      if (part.type !== "file") continue;
      if (stored) {
        // One file per request keeps the accounting (and the size ceiling)
        // unambiguous; the client uploads several images as several calls.
        throw badRequest("Un seul fichier par envoi.");
      }
      // The MIME type is taken from the part, then checked against the
      // allow-list in storeUpload. The browser's claim is a hint, which is
      // why the extension is derived from the allow-list and not from the
      // filename the browser supplied.
      stored = await storeUpload(ctx.profileId, part.file, part.mimetype, {
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }

    if (!stored) throw badRequest("Aucun fichier reçu.");

    const row = await queryOne<MediaRow>(
      `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, storage_path, mime_type, size_bytes, created_at`,
      [ctx.profileId, kind, stored.storagePath, stored.mimeType, stored.sizeBytes],
    );
    if (!row) {
      await deleteStoredFile(stored.storagePath);
      throw badRequest("L'enregistrement du média a échoué.");
    }
    return reply.code(201).send(present(row));
  });

  /**
   * Serves a stored file.
   *
   * Ownership is checked on every read: media is NOT public. The row is
   * looked up by id AND profile id, so an id belonging to another account is
   * a 404 — the same answer as an id that does not exist.
   */
  app.get("/media/:id/file", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");

    const row = await queryOne<MediaRow>(
      `SELECT id, kind, storage_path, mime_type, size_bytes, created_at
         FROM media_assets WHERE id = $1 AND profile_id = $2`,
      [id, ctx.profileId],
    );
    if (!row) throw notFound("Média introuvable.");

    const absolute = resolveMediaPath(row.storage_path);
    try {
      await stat(absolute);
    } catch {
      throw notFound("Le fichier n'est plus disponible.");
    }

    return reply
      .header("Content-Type", row.mime_type)
      // Even though only rasters are accepted, tell the browser not to
      // second-guess the type: sniffing is how a "png" becomes a document.
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "inline")
      // Private: this is one account's media, so no shared cache may keep it.
      .header("Cache-Control", "private, max-age=3600")
      .send(createReadStream(absolute));
  });

  app.delete("/media/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");

    const row = await queryOne<{ storage_path: string }>(
      `DELETE FROM media_assets WHERE id = $1 AND profile_id = $2 RETURNING storage_path`,
      [id, ctx.profileId],
    );
    if (!row) throw notFound("Média introuvable.");

    // The row goes first: a file left on disk is wasted space, but a row
    // pointing at a file that is gone is a broken image in the UI.
    await deleteStoredFile(row.storage_path);
    return reply.code(204).send();
  });
}
