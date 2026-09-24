import { queryOne } from "../lib/db.js";
import { mediaAssetIdFromUrl } from "../lib/media.js";
import type { CharacterPosition, Corner } from "./character.js";
import { choosePose, isFacing, isGesture, type Facing, type Gesture } from "./poses.js";

// Everything that makes a poster the account's own, read in ONE place for
// every poster — the dashboard's and the weekly runner's alike — so no
// caller can forget a setting: the character (with the pose that suits the
// message), the logo, the brand colours and typography, the image style.

/** A job's character, snapshotted when the render starts. */
export interface CharacterOverlay {
  assetId: string;
  position: CharacterPosition;
  gesture: Gesture;
  facing: Facing;
}

/** A job's logo: this account's media asset id, or an https URL (older profiles). */
export interface LogoOverlay {
  source: string;
  corner: Corner;
}

export interface PosterBranding {
  character: CharacterOverlay | null;
  logo: LogoOverlay | null;
  /** Brand colours to impose, with their role; [] when the palette is switched off. */
  palette: Array<{ role: string; hex: string }>;
  font: string | null;
  imageStyle: string | null;
  peopleType: string | null;
}

export const NO_BRANDING: PosterBranding = {
  character: null,
  logo: null,
  palette: [],
  font: null,
  imageStyle: null,
  peopleType: null,
};

/**
 * Where things go on a poster. Without a character: the permanent message
 * bottom-left, the brand bottom-right. With one, its side is kept free, so
 * the message moves to the bottom of the other side and the brand to its top.
 */
export function posterLayout(characterSide: CharacterPosition | null): { footer: Corner; brand: Corner } {
  if (characterSide === "right") return { footer: "bottom-left", brand: "top-left" };
  if (characterSide === "left") return { footer: "bottom-right", brand: "top-right" };
  return { footer: "bottom-left", brand: "bottom-right" };
}

export const CORNER_FR: Record<Corner, string> = {
  "top-left": "supérieur gauche",
  "top-right": "supérieur droit",
  "bottom-left": "inférieur gauche",
  "bottom-right": "inférieur droit",
};

/** A pose facing away from the poster's centre is mirrored when laid on. */
export function shouldMirror(position: CharacterPosition, facing: Facing): boolean {
  return (position === "right" && facing === "right") || (position === "left" && facing === "left");
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The branding of one poster.
 *
 * The character appears when the post says so, or — when the post says
 * nothing (NULL) — when the account's default says so.
 */
export async function loadBranding(
  profileId: string,
  postId: string | null,
  content: string,
  category: string,
): Promise<PosterBranding> {
  const row = await queryOne<{
    poster_character_enabled: boolean;
    poster_character_position: string;
    poster_logo_enabled: boolean;
    logo_url: string | null;
    brand_colors_enabled: boolean;
    brand_primary_color: string | null;
    brand_secondary_color: string | null;
    brand_accent_color: string | null;
    brand_font: string | null;
    image_style: string | null;
    image_people_type: string | null;
    include_character: boolean | null;
  }>(
    `SELECT p.poster_character_enabled, p.poster_character_position, p.poster_logo_enabled,
            p.logo_url, p.brand_colors_enabled, p.brand_primary_color, p.brand_secondary_color,
            p.brand_accent_color, p.brand_font, p.image_style, p.image_people_type,
            x.include_character
       FROM profiles p
       LEFT JOIN posts x ON x.id = $2 AND x.profile_id = p.id
      WHERE p.id = $1`,
    [profileId, postId],
  );
  if (!row) return NO_BRANDING;

  let character: CharacterOverlay | null = null;
  if (row.include_character ?? row.poster_character_enabled) {
    const pose = await choosePose(profileId, content, category);
    if (pose) {
      character = {
        assetId: pose.assetId,
        position: row.poster_character_position === "left" ? "left" : "right",
        gesture: pose.gesture,
        facing: pose.facing,
      };
    }
  }

  let logo: LogoOverlay | null = null;
  if (row.poster_logo_enabled && row.logo_url) {
    const assetId = mediaAssetIdFromUrl(row.logo_url);
    const source = assetId
      ? (await queryOne<{ id: string }>(
          `SELECT id::text FROM media_assets WHERE id = $1 AND profile_id = $2`,
          [assetId, profileId],
        ))?.id ?? null
      : /^https:\/\//i.test(row.logo_url)
        ? row.logo_url
        : null;
    if (source) logo = { source, corner: posterLayout(character?.position ?? null).brand };
  }

  const palette = row.brand_colors_enabled
    ? [
        { role: "couleur principale", hex: row.brand_primary_color },
        { role: "couleur secondaire", hex: row.brand_secondary_color },
        { role: "couleur d'accent", hex: row.brand_accent_color },
      ].filter((c): c is { role: string; hex: string } => Boolean(c.hex && HEX.test(c.hex)))
    : [];

  return {
    character,
    logo,
    palette,
    font: row.brand_colors_enabled ? row.brand_font?.trim().slice(0, 60) || null : null,
    imageStyle: row.image_style?.trim() || null,
    peopleType: row.image_people_type?.trim() || null,
  };
}

/** A job's stored character, validated — the column is jsonb and could hold anything. */
export function asCharacterOverlay(value: unknown): CharacterOverlay | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { assetId?: unknown; position?: unknown; gesture?: unknown; facing?: unknown };
  if (typeof v.assetId !== "string" || !/^[0-9a-f-]{36}$/i.test(v.assetId)) return null;
  return {
    assetId: v.assetId,
    position: v.position === "left" ? "left" : "right",
    gesture: isGesture(v.gesture) ? v.gesture : "neutre",
    facing: isFacing(v.facing) ? v.facing : "front",
  };
}

/** A job's stored logo, validated. */
export function asLogoOverlay(value: unknown): LogoOverlay | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { source?: unknown; corner?: unknown };
  if (typeof v.source !== "string") return null;
  const local = /^[0-9a-f-]{36}$/i.test(v.source);
  if (!local && !/^https:\/\//i.test(v.source)) return null;
  const corner = ["top-left", "top-right", "bottom-left", "bottom-right"].includes(String(v.corner))
    ? (v.corner as Corner)
    : "bottom-right";
  return { source: v.source, corner };
}
