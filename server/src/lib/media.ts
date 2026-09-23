import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { queryOne } from "./db.js";
import { publicOnlyLookup } from "./network.js";
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

/**
 * Ceiling for a poster copied back from the renderer. A premium 2K render in
 * PNG is routinely larger than the 5 MB allowed for a user upload: capping it
 * at 5 MB made the copy fail, the expiring provider URL was kept instead, and
 * the poster later vanished from the post it was attached to.
 */
export const REMOTE_POSTER_MAX_BYTES = 25 * 1024 * 1024;

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

/**
 * Writes an in-memory image (a processed cut-out, a composited poster) under
 * the account's own directory, with a generated name.
 */
export async function storeBuffer(
  profileId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<StoredFile> {
  const ext = extensionForType(mimeType);
  const storagePath = join(profileId, `${randomUUID()}.${ext}`);
  const absolute = resolveMediaPath(storagePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer);
  return { storagePath, mimeType, sizeBytes: buffer.length };
}

/** Reads a stored file back. */
export async function readStoredFile(storagePath: string): Promise<Buffer> {
  return readFile(resolveMediaPath(storagePath));
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
 * An absolute, session-free URL a third party (the poster renderer, the
 * publishing provider) can fetch for one of this account's own files.
 *
 * A relative /api/media/... URL is session-guarded: handed over as is, it is
 * unfetchable — which is how the account's logo never reached a single
 * poster. A capability token is minted (or reused) for exactly that asset.
 * Returns null when the URL is local but cannot be shared (no
 * APP_PUBLIC_URL, or not this account's asset); an absolute URL is returned
 * unchanged.
 */
export async function shareableMediaUrl(profileId: string, url: string): Promise<string | null> {
  const assetId = mediaAssetIdFromUrl(url);
  if (!assetId) return /^https:\/\//i.test(url) ? url : null;
  if (!env.appPublicUrl) return null;
  const row = await queryOne<{ public_token: string | null }>(
    `UPDATE media_assets
        SET public_token = COALESCE(public_token, encode(gen_random_bytes(32), 'hex'))
      WHERE id = $1 AND profile_id = $2
      RETURNING public_token`,
    [assetId, profileId],
  );
  return row?.public_token ? publicMediaUrl(row.public_token) : null;
}

const MAX_REDIRECTS = 3;

/**
 * GETs a remote image over https from a public host, following at most a few
 * redirects, each one re-validated. Plain `fetch` followed redirects blindly
 * and resolved names without looking at the answer, so an image URL could
 * lead the server to an internal address.
 */
async function getPublicImage(url: string, signal: AbortSignal): Promise<IncomingMessage> {
  const { asImageUrl } = await import("./validate.js");
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = asImageUrl(current, "image_url");
    if (!safe || safe.startsWith("/")) throw badRequest("URL d'image invalide.");
    const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const req = httpsRequest(safe, { method: "GET", lookup: publicOnlyLookup, signal }, resolveResponse);
      req.on("error", reject);
      req.end();
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      current = new URL(response.headers.location, safe).toString();
      continue;
    }
    return response;
  }
  throw badRequest("L'image générée redirige trop de fois.");
}

/**
 * Stores an image delivered inline (data:image/...;base64,...), as some
 * renderers do. It used to be handed to the https-only re-host, refused, and
 * the whole data URI recorded as the post's image URL.
 */
async function storeDataUrl(profileId: string, dataUrl: string): Promise<StoredFile> {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw badRequest("Image générée illisible.");
  const mimeType = match[1]!.toLowerCase();
  extensionForType(mimeType);
  const buffer = Buffer.from(match[2]!, "base64");
  if (buffer.length === 0) throw badRequest("Image générée vide.");
  if (buffer.length > REMOTE_POSTER_MAX_BYTES) throw tooLarge("L'image générée est trop volumineuse.");
  return storeBuffer(profileId, buffer, mimeType);
}

/**
 * Copies a remote image into this account's own storage.
 *
 * Posters come back as URLs on the renderer's CDN, and those expire. Storing
 * the URL meant a poster silently disappeared from the dashboard — and from
 * the post — some days after it was generated, including from posts scheduled
 * for later.
 *
 * The URL is validated before it is fetched (https, public host only — the
 * resolved address included, at every redirect), the response's declared
 * type must be a raster image we accept, and the body is capped WHILE
 * streaming, so neither a redirect to an internal address nor an unbounded
 * response can be used against this server.
 */
export async function rehostRemoteImage(
  profileId: string,
  url: string,
): Promise<StoredFile> {
  if (/^data:/i.test(url)) return storeDataUrl(profileId, url);

  const signal = AbortSignal.timeout(60_000);
  const response = await getPublicImage(url, signal);
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    response.resume();
    throw badRequest(`L'image générée n'a pas pu être récupérée (${status}).`);
  }

  const declared = String(response.headers["content-type"] ?? "").split(";")[0]!.trim();
  try {
    // Throws for SVG and for anything that is not a raster image we accept.
    extensionForType(declared);
    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (declaredLength > REMOTE_POSTER_MAX_BYTES) {
      throw tooLarge("L'image générée est trop volumineuse.");
    }
  } catch (err) {
    response.destroy();
    throw err;
  }

  return storeUpload(profileId, response, declared, { maxBytes: REMOTE_POSTER_MAX_BYTES });
}
