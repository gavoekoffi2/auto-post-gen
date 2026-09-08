// Shared validation for user-supplied images (logo, custom image library).
//
// Two problems this centralises:
//   - `file.name.split(".").pop()` trusts the filename. A file called
//     "logo" (no dot) produced the path "…/logo-123.logo"; a crafted name
//     could inject path segments or an arbitrary extension into storage.
//   - `file.type.startsWith("image/")` accepts image/svg+xml. An SVG is an
//     executable document, and every other stage of the poster pipeline
//     already refuses SVG, so a user could store one the renderer will not
//     accept — or feed it to Graphiste as a logo and get a broken poster.

/** Raster formats the app actually renders and sends to the poster API. */
const ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A flat result rather than a discriminated union: this project compiles with
// `strict: false` / `strictNullChecks: false`, under which boolean-literal
// discriminants do not narrow, so `if (!result.ok)` would not give callers the
// error branch.
export interface ImageValidation {
  /** Null when the file is acceptable, otherwise the message to show. */
  error: string | null;
  /** Safe extension derived from the MIME type, never from the filename. */
  extension: string;
}

export function validateImageFile(file: File): ImageValidation {
  const mime = (file.type || "").toLowerCase().trim();

  if (mime === "image/svg+xml" || mime === "image/svg") {
    return {
      error: "Les fichiers SVG ne sont pas acceptés. Utilisez un PNG, JPG ou WebP.",
      extension: "",
    };
  }
  if (!mime.startsWith("image/")) {
    return { error: "Veuillez sélectionner une image.", extension: "" };
  }
  const extension = ALLOWED_MIME[mime];
  if (!extension) {
    return {
      error: "Format non supporté. Utilisez un PNG, JPG, WebP, GIF ou AVIF.",
      extension: "",
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { error: "L'image ne doit pas dépasser 5 Mo.", extension: "" };
  }
  if (file.size === 0) {
    return { error: "Ce fichier est vide.", extension: "" };
  }
  return { error: null, extension };
}
