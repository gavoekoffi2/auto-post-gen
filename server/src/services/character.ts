import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { env } from "../lib/env.js";
import { HttpError, badRequest, notConfigured } from "../lib/errors.js";

// The poster character: a person (or a mascot) the account wants on every
// poster, cut out of its photo once, then laid onto each finished render.
//
// Everything happens on this server. The photo is never sent to the poster
// provider, which has two consequences that matter:
//   * the character on the poster is the account's own image, pixel for
//     pixel — not the provider's re-interpretation of a face;
//   * a photograph of a real person does not leave the deployment.
//
// Two stages:
//   prepareCharacter()   at upload — cut the subject out (or keep the
//                        transparency of an image that is already cut out),
//                        crop to it, cap its size. Stored as a PNG.
//   compositeCharacter() at render — the poster provider has been told to
//                        keep one side free; the character is laid there,
//                        standing on the bottom edge, with a soft shadow.

export type CharacterPosition = "left" | "right";

/** The stored cut-out never exceeds this on its longest side. */
export const CHARACTER_MAX_SIDE = 1600;
/** Largest source image accepted, in pixels (a 40 MP phone photo). */
const MAX_INPUT_PIXELS = 40_000_000;
/** Working resolution: plenty for a poster overlay, cheap to process. */
const WORK_MAX_SIDE = 2048;
/** Input resolution of the segmentation model ("silueta", a U²-Net). */
const MODEL_SIZE = 320;
const MODEL_MEAN = [0.485, 0.456, 0.406] as const;
const MODEL_STD = [0.229, 0.224, 0.225] as const;
/** Alpha below this is treated as background (model haze, JPEG noise). */
const ALPHA_FLOOR = 12;
/**
 * The model's mask is soft over a few pixels, and those edge pixels still
 * carry the ORIGINAL background colour — a light halo around the character
 * once it sits on a dark poster. Remapping [low, high] to [0, 255] tightens
 * that transition without making the edge jagged.
 */
const EDGE_LOW = 24;
const EDGE_HIGH = 232;
/** Below this height the cut-out is enlarged on a 2K poster and looks soft. */
export const CHARACTER_LOW_RES_HEIGHT = 700;
/** An image counts as "already cut out" when this share of it is transparent. */
const PRECUT_TRANSPARENT_SHARE = 0.05;
/** Less foreground than this means nothing was found to cut out. */
const MIN_SUBJECT_SHARE = 0.02;
const INFERENCE_TIMEOUT_MS = 90_000;

export function segmentationAvailable(): boolean {
  return existsSync(env.bgModelPath);
}

// One inference at a time for the whole process: each one holds hundreds of
// MB for a few seconds, and uploads are rare. A queue bounds memory without
// refusing anyone.
let queue: Promise<unknown> = Promise.resolve();

function runSegmentation(input: Float32Array): Promise<Float32Array> {
  const run = (): Promise<Float32Array> =>
    new Promise((resolvePromise, reject) => {
      const worker = new Worker(new URL("./segmentationWorker.js", import.meta.url), {
        workerData: { modelPath: env.bgModelPath, size: MODEL_SIZE, input },
        transferList: [input.buffer as ArrayBuffer],
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("segmentation timed out"));
      }, INFERENCE_TIMEOUT_MS);
      worker.once("message", (msg: { ok: boolean; mask?: Float32Array; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (msg.ok && msg.mask) resolvePromise(msg.mask);
        else reject(new Error(msg.error ?? "segmentation failed"));
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** The subject's alpha mask at the working size, from the segmentation model. */
async function segment(rgb: Buffer, width: number, height: number): Promise<Buffer> {
  const { data } = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let max = 1;
  for (const v of data) if (v > max) max = v;
  const plane = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * plane + i] = (data[i * 3 + c]! / max - MODEL_MEAN[c]!) / MODEL_STD[c]!;
    }
  }

  const prediction = await runSegmentation(input);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of prediction) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const small = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) small[i] = Math.round(((prediction[i]! - lo) / span) * 255);

  // extractChannel keeps the result single-channel: a resized one-channel
  // raw image otherwise comes back as RGB, and the mask would be misread.
  return sharp(small, { raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 } })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .extractChannel(0)
    .raw()
    .toBuffer();
}

export interface PreparedCharacter {
  png: Buffer;
  width: number;
  height: number;
  /** False when the upload was already cut out and kept as it was. */
  cutOut: boolean;
  /** Small enough to look soft once enlarged onto a poster. */
  lowResolution: boolean;
}

/**
 * Turns an uploaded image into the stored character cut-out.
 *
 * Throws a user-facing error for an unreadable image, for an image with no
 * detectable subject, and — when the model is not installed — for a photo
 * that would need cutting out (an already transparent PNG still works).
 */
export async function prepareCharacter(upload: Buffer): Promise<PreparedCharacter> {
  let working: { data: Buffer; info: sharp.OutputInfo };
  let hadAlpha: boolean;
  try {
    const source = sharp(upload, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS });
    hadAlpha = Boolean((await source.metadata()).hasAlpha);
    working = await source
      .rotate() // honour the EXIF orientation of phone photos
      .resize(WORK_MAX_SIDE, WORK_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw badRequest(
      "Cette image n'a pas pu être lue. Envoyez une photo JPEG, PNG ou WebP.",
      "invalid_image",
    );
  }

  const { width, height } = working.info;
  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  let alpha: Buffer = Buffer.alloc(pixels);
  let transparent = 0;
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = working.data[i * 4]!;
    rgb[i * 3 + 1] = working.data[i * 4 + 1]!;
    rgb[i * 3 + 2] = working.data[i * 4 + 2]!;
    const a = working.data[i * 4 + 3]!;
    alpha[i] = a;
    if (a < 16) transparent++;
  }

  // An image that is already cut out (a mascot exported as a transparent PNG,
  // a photo detoured elsewhere) is kept exactly as its author made it.
  const cutOut = !(hadAlpha && transparent / pixels >= PRECUT_TRANSPARENT_SHARE);
  if (cutOut) {
    if (!segmentationAvailable()) {
      throw notConfigured(
        "Le détourage automatique n'est pas installé sur ce serveur. Envoyez une image " +
          "déjà détourée (PNG à fond transparent).",
      );
    }
    try {
      alpha = await segment(rgb, width, height);
      const span = EDGE_HIGH - EDGE_LOW;
      for (let i = 0; i < pixels; i++) {
        const a = alpha[i]!;
        alpha[i] = a <= EDGE_LOW ? 0 : a >= EDGE_HIGH ? 255 : Math.round(((a - EDGE_LOW) / span) * 255);
      }
    } catch (err) {
      console.error("[character] segmentation failed:", (err as Error).message);
      throw new HttpError(
        503,
        "Le détourage de l'image a échoué. Réessayez dans un instant.",
        "cutout_failed",
      );
    }
  }

  // Clean the haze, measure the subject and find its bounding box.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let solid = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (alpha[i]! < ALPHA_FLOOR) {
        alpha[i] = 0;
        continue;
      }
      if (alpha[i]! >= 128) solid++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || solid / pixels < MIN_SUBJECT_SHARE) {
    throw badRequest(
      "Aucun personnage n'a été détecté sur cette image. Choisissez une photo où la " +
        "personne (ou la mascotte) est bien visible et se détache du fond.",
      "no_subject",
    );
  }

  // A little air on the top and the sides; none at the bottom. The character
  // stands on the poster's bottom edge, so a photo cut at the waist must end
  // exactly at the cut, not float above it with a hard line showing.
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const cropWidth = right - left + 1;
  const cropHeight = maxY - top + 1;

  // The RGBA buffer is assembled by hand rather than with joinChannel():
  // sharp applies extract() at a fixed stage of its pipeline, BEFORE
  // joinChannel(), so the two together crop the colours and not the mask —
  // a black silhouette with the photo showing through at one edge.
  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = rgb[i * 3]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = alpha[i]!;
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(CHARACTER_MAX_SIDE, CHARACTER_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  return {
    png: png.data,
    width: png.info.width,
    height: png.info.height,
    cutOut,
    lowResolution: png.info.height < CHARACTER_LOW_RES_HEIGHT,
  };
}

/**
 * The share of the poster the provider is asked to keep free, and the box
 * the character is fitted into. One definition, used by both the prompt and
 * the compositing, so the two cannot disagree.
 */
export function characterBox(width: number, height: number) {
  const landscape = width > height * 1.15;
  return {
    maxWidth: Math.round(width * (landscape ? 0.36 : 0.46)),
    maxHeight: Math.round(height * (landscape ? 0.9 : 0.64)),
    margin: Math.round(width * 0.03),
  };
}

/**
 * Lays the character onto a finished poster.
 *
 * Standing on the bottom edge, on the requested side, scaled to fit the
 * reserved box, with a soft shadow so it sits in the scene rather than on top
 * of it. Returns a JPEG the size of the poster.
 */
export async function compositeCharacter(
  poster: Buffer,
  character: Buffer,
  position: CharacterPosition,
): Promise<Buffer> {
  const base = sharp(poster, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const { data: posterPixels, info: posterInfo } = await base.raw().toBuffer({ resolveWithObject: true });
  const width = posterInfo.width;
  const height = posterInfo.height;
  const box = characterBox(width, height);

  const fitted = await sharp(character)
    .ensureAlpha()
    .resize(box.maxWidth, box.maxHeight, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const cw = fitted.info.width;
  const ch = fitted.info.height;
  const x = position === "left" ? box.margin : width - cw - box.margin;
  const y = height - ch;

  // Shadow: the character's own silhouette, black, blurred, a little offset
  // toward the centre of the poster, clipped to the canvas.
  const alpha = await sharp(fitted.data).extractChannel(3).raw().toBuffer();
  const blur = Math.max(3, Math.round(cw * 0.025));
  const pad = blur * 3;
  const sw = cw + pad * 2;
  const sh = ch + pad * 2;
  const shadowRgba = Buffer.alloc(sw * sh * 4);
  for (let row = 0; row < ch; row++) {
    for (let col = 0; col < cw; col++) {
      shadowRgba[((row + pad) * sw + col + pad) * 4 + 3] = Math.round(alpha[row * cw + col]! * 0.45);
    }
  }
  const shadowFull = await sharp(shadowRgba, { raw: { width: sw, height: sh, channels: 4 } })
    .blur(blur)
    .png()
    .toBuffer();
  const shift = Math.round(cw * 0.03) * (position === "left" ? 1 : -1);
  const sx = x - pad + shift;
  const sy = y - pad + Math.round(blur / 2);
  const clipLeft = Math.max(0, sx);
  const clipTop = Math.max(0, sy);
  const clipRight = Math.min(width, sx + sw);
  const clipBottom = Math.min(height, sy + sh);

  const layers: sharp.OverlayOptions[] = [];
  if (clipRight > clipLeft && clipBottom > clipTop) {
    const shadow = await sharp(shadowFull)
      .extract({
        left: clipLeft - sx,
        top: clipTop - sy,
        width: clipRight - clipLeft,
        height: clipBottom - clipTop,
      })
      .png()
      .toBuffer();
    layers.push({ input: shadow, left: clipLeft, top: clipTop });
  }
  layers.push({ input: fitted.data, left: x, top: y });

  return sharp(posterPixels, { raw: { width, height, channels: posterInfo.channels } })
    .composite(layers)
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}
