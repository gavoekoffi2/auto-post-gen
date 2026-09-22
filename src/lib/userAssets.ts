// Shared helpers for the public `user-assets` bucket.
//
// Two problems these solve:
//  1. The stored object key used to take its extension from the USER's
//     filename (`file.name.split('.').pop()`), so a file with no dot produced
//     a key ending in the whole filename, and an arbitrary string ended up in
//     a path. The extension now comes from the browser-verified MIME type.
//  2. Replacing or removing a logo only cleared the database column. The old
//     object stayed in a PUBLIC bucket forever — still reachable by URL, and
//     growing storage with every change.

import { supabase } from "@/integrations/supabase/client";

export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
/** Keeps one user's library bounded; posters and logos live in the same bucket. */
export const MAX_CUSTOM_IMAGES = 30;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Accepted upload types. SVG is excluded on purpose: it can carry script. */
export const ACCEPTED_IMAGE_TYPES = Object.keys(EXT_BY_TYPE);

export function assetExtension(mimeType: string): string | null {
  return EXT_BY_TYPE[mimeType.toLowerCase()] ?? null;
}

/** Validates a picked file, returning an error message or null. */
export function validateImageFile(file: File): string | null {
  if (!assetExtension(file.type)) {
    return `${file.name} : format non supporté (JPG, PNG, WEBP, GIF ou AVIF).`;
  }
  if (file.size > MAX_ASSET_BYTES) {
    return `${file.name} dépasse ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} Mo.`;
  }
  return null;
}

/**
 * Object key for a user upload. The first segment MUST be the user id: the
 * storage RLS policy keys on it.
 */
export function buildAssetPath(userId: string, kind: string, mimeType: string): string {
  const ext = assetExtension(mimeType) ?? "jpg";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${userId}/${kind}-${unique}.${ext}`;
}

/** Turns a public URL from this bucket back into its object key, or null. */
export function assetPathFromPublicUrl(publicUrl: string): string | null {
  const marker = "/user-assets/";
  const index = publicUrl.indexOf(marker);
  if (index < 0) return null;
  const path = publicUrl.slice(index + marker.length).split("?")[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    // A stray '%' makes decodeURIComponent throw. Older object keys took
    // their name from the user's filename, so such keys exist; the raw path
    // is the right thing to try, and it must not take the caller down.
    return path;
  }
}

/**
 * Best-effort delete of an object we are replacing or dropping. Never throws:
 * an orphaned file must not fail the user's action, and a URL that is not ours
 * (or already gone) is simply skipped.
 */
export async function deleteAssetByUrl(publicUrl: string | null | undefined): Promise<void> {
  if (!publicUrl) return;
  // Everything is inside the try, including parsing the URL: this function
  // promises never to throw, and its callers rely on that — they update the UI
  // first and delete afterwards, with no catch of their own.
  try {
    const path = assetPathFromPublicUrl(publicUrl);
    if (!path) return;
    await supabase.storage.from("user-assets").remove([path]);
  } catch (error) {
    console.warn("Could not remove the previous asset:", error);
  }
}
