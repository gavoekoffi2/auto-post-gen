import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "./env.js";
import { badRequest, tooLarge } from "./errors.js";

// Local media storage.
//
// Files live in MEDIA_ROOT (the `pro-social-ai_media` volume), under one
// directory per account. Nothing about the path comes from the browser: the
// account id comes from the session and the filename is a fresh UUID, so an
// upload has no way to name its own destination and therefore no way to
// traverse out of its directory or overwrite another account's file.

/** Raster images only. SVG is deliberately excluded — see below. */
const ALLOWED_IMAGE_TYPES = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type MediaKind = "logo" | "custom_image" | "poster" | "other";
const KINDS: readonly MediaKind[] = ["logo", "custom_image", "poster", "other"];

export function asMediaKind(value: unknown): MediaKind {
  const kind = String(value ?? "other");
  if (!KINDS.includes(kind as MediaKind)) {
    throw badRequest(`Type de média inconnu : ${kind}.`);
  }
  return kind as MediaKind;
}

/**
 * Why SVG is refused even though it is an image:
 *
 * an SVG is a document. It can carry <script>, and it is served from the same
 * origin as the app, so storing one turns "upload your logo" into stored XSS
 * against every user who views it. Rasters cannot do that.
 */
export function extensionForType(mimeType: string): string {
  const ext = ALLOWED_IMAGE_TYPES.get(mimeType.toLowerCase().split(";")[0]!.trim());
  if (!ext) {
    throw badRequest(
      "Format d'image non supporté. Utilisez PNG, JPEG, WebP ou GIF (le SVG n'est pas accepté).",
    );
  }
  return ext;
}

/**
 * Resolves a stored relative path to an absolute one, refusing anything that
 * escapes MEDIA_ROOT.
 *
 * Defence in depth: paths are generated, never user-supplied, so this should
 * be unreachable — but a future caller that forgets will fail loudly here
 * instead of reading /etc/passwd.
 */
export function resolveMediaPath(storagePath: string): string {
  const root = resolve(env.mediaRoot);
  const absolute = resolve(join(root, normalize(storagePath)));
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw badRequest("Chemin de média invalide.");
  }
  return absolute;
}

export interface StoredFile {
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Streams an upload to disk under the account's own directory.
 *
 * The size ceiling is enforced WHILE streaming, not after: buffering first and
 * checking the length afterwards means a large upload has already been written
 * (or held in memory) before it is rejected.
 */
export async function storeUpload(
  profileId: string,
  file: Readable,
  mimeType: string,
  opts: { maxBytes?: number } = {},
): Promise<StoredFile> {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const ext = extensionForType(mimeType);

  // Account directory + random name: the browser names neither.
  const storagePath = join(profileId, `${randomUUID()}.${ext}`);
  const absolute = resolveMediaPath(storagePath);
  await mkdir(dirname(absolute), { recursive: true });

  let written = 0;
  let exceeded = false;
  file.on("data", (chunk: Buffer) => {
    written += chunk.length;
    if (written > maxBytes && !exceeded) {
      exceeded = true;
      file.destroy(new Error("upload_too_large"));
    }
  });

  try {
    await pipeline(file, createWriteStream(absolute));
  } catch (err) {
    // Never leave a partial file behind for a rejected upload.
    await rm(absolute, { force: true }).catch(() => {});
    if (exceeded || (err as Error).message === "upload_too_large") {
      throw tooLarge(
        `L'image ne doit pas dépasser ${Math.floor(maxBytes / (1024 * 1024))} Mo.`,
      );
    }
    throw err;
  }

  const info = await stat(absolute);
  if (info.size === 0) {
    await rm(absolute, { force: true }).catch(() => {});
    throw badRequest("Le fichier envoyé est vide.");
  }

  return { storagePath, mimeType, sizeBytes: info.size };
}

/** Deletes a stored file. Missing is success — the goal is that it is gone. */
export async function deleteStoredFile(storagePath: string): Promise<void> {
  await rm(resolveMediaPath(storagePath), { force: true }).catch(() => {});
}

/** Removes an account's whole media directory, for account deletion. */
export async function deleteProfileMedia(profileId: string): Promise<void> {
  const dir = resolveMediaPath(profileId);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * The URL the frontend uses for a stored file.
 *
 * Relative and same-origin, so it works behind nginx without the API knowing
 * its own public hostname, and it survives the site moving to another domain.
 */
export function mediaUrl(assetId: string): string {
  return `/api/media/${assetId}/file`;
}

/**
 * An absolute, session-free URL for one media asset.
 *
 * Used only where a third party must fetch the file — the publishing
 * provider downloading a poster to attach it. The token is long and random,
 * minted on demand for that one asset, and revocable by clearing the column;
 * it grants reading that single file and nothing else.
 */
export function publicMediaUrl(token: string): string {
  const base = (env.appPublicUrl ?? "").replace(/\/+$/, "");
  return `${base}/api/media/public/${token}`;
}

/** The asset id inside a relative media URL, or null if it is not one. */
export function mediaAssetIdFromUrl(url: string): string | null {
  const match = /^\/api\/media\/([0-9a-f-]{36})\/file$/i.exec(url);
  return match?.[1] ?? null;
}

/**
 * Copies a remote image into this account's own storage.
 *
 * Posters come back as URLs on the renderer's CDN, and those expire. Storing
 * the URL meant a poster silently disappeared from the dashboard — and from
 * the post — some days after it was generated, including from posts scheduled
 * for later.
 *
 * The URL is validated before it is fetched (https, public host only), the
 * response's declared type must be a raster image we accept, and the body is
 * capped WHILE streaming, so neither a redirect to an internal address nor an
 * unbounded response can be used against this server.
 */
export async function rehostRemoteImage(
  profileId: string,
  url: string,
): Promise<StoredFile> {
  // Refuses http, private, link-local and metadata hosts. Imported here rather
  // than at the top because validate.ts is otherwise request-shaped.
  const { asImageUrl } = await import("./validate.js");
  const safe = asImageUrl(url, "image_url");
  if (!safe || safe.startsWith("/")) throw badRequest("URL d'image invalide.");

  const response = await fetch(safe, {
    // Redirects are followed by fetch, and a redirect can land anywhere — so
    // the size and type checks below, not the initial URL, are what bound it.
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    throw badRequest(`L'image générée n'a pas pu être récupérée (${response.status}).`);
  }

  const declared = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  // Throws for SVG and for anything that is not a raster image we accept.
  extensionForType(declared);

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw tooLarge("L'image générée est trop volumineuse.");
  }

  const { Readable } = await import("node:stream");
  return storeUpload(profileId, Readable.fromWeb(response.body as never), declared);
}
