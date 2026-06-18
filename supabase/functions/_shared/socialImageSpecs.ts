// Centralized social-media image specifications — single source of truth for
// the output format (width / height / aspect ratio) that a given set of
// platforms should produce.
//
// This module is intentionally dependency-free and uses only erasable
// TypeScript so the exact same file works in three runtimes:
//   - the Supabase edge function (Deno):  supabase/functions/_shared/socialImageSpecs.ts
//   - the dashboard (Vite / React):       src/lib/socialImageSpecs.ts
//   - the Node test runner (type stripping)
//
// Keep the two copies byte-for-byte identical — a regression test enforces it.
// Edit both together.

export type SocialImageOrientation =
  | "story"
  | "portrait"
  | "square"
  | "landscape";

export interface SocialImageSpec {
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /** Human-readable aspect ratio, e.g. "9:16". */
  aspectRatio: string;
  /** Short label shown in the UI / logs, e.g. "TikTok". */
  label: string;
  /** Coarse layout family used by the poster renderer. */
  orientation: SocialImageOrientation;
  /** Canonical platform keys that drove this decision. */
  platforms: string[];
}

// 9:16 full-height platforms. Any of these forces a vertical story canvas.
const VERTICAL_PLATFORMS = new Set([
  "tiktok",
  "youtube-shorts",
  "instagram-story",
  "instagram-reels",
]);

// Wide "professional feed" platforms that share a landscape format.
const LANDSCAPE_PRO_PLATFORMS = new Set(["linkedin", "facebook", "x"]);

// Native, recommended single-platform formats.
const NATIVE_SPECS: Record<string, SocialImageSpec> = {
  linkedin: { width: 1200, height: 627, aspectRatio: "1.91:1", label: "LinkedIn", orientation: "landscape", platforms: ["linkedin"] },
  facebook: { width: 1200, height: 630, aspectRatio: "1.91:1", label: "Facebook", orientation: "landscape", platforms: ["facebook"] },
  x: { width: 1200, height: 675, aspectRatio: "16:9", label: "X (Twitter)", orientation: "landscape", platforms: ["x"] },
  instagram: { width: 1080, height: 1350, aspectRatio: "4:5", label: "Instagram", orientation: "portrait", platforms: ["instagram"] },
  "instagram-story": { width: 1080, height: 1920, aspectRatio: "9:16", label: "Instagram Story", orientation: "story", platforms: ["instagram-story"] },
  "instagram-reels": { width: 1080, height: 1920, aspectRatio: "9:16", label: "Instagram Reels", orientation: "story", platforms: ["instagram-reels"] },
  tiktok: { width: 1080, height: 1920, aspectRatio: "9:16", label: "TikTok", orientation: "story", platforms: ["tiktok"] },
  "youtube-shorts": { width: 1080, height: 1920, aspectRatio: "9:16", label: "YouTube Shorts", orientation: "story", platforms: ["youtube-shorts"] },
};

// Shared multi-platform fallbacks (platforms[] is filled in per call).
const STORY_SPEC: SocialImageSpec = { width: 1080, height: 1920, aspectRatio: "9:16", label: "Vertical (Story / Reels / TikTok / Shorts)", orientation: "story", platforms: [] };
const PORTRAIT_SPEC: SocialImageSpec = { width: 1080, height: 1350, aspectRatio: "4:5", label: "Instagram", orientation: "portrait", platforms: [] };
const SQUARE_SPEC: SocialImageSpec = { width: 1080, height: 1080, aspectRatio: "1:1", label: "Carré multi-réseaux", orientation: "square", platforms: [] };
const LANDSCAPE_PRO_SPEC: SocialImageSpec = { width: 1200, height: 627, aspectRatio: "1.91:1", label: "Paysage pro (LinkedIn / Facebook / X)", orientation: "landscape", platforms: [] };
const DEFAULT_SPEC: SocialImageSpec = { width: 1080, height: 1080, aspectRatio: "1:1", label: "Universel", orientation: "square", platforms: [] };

/**
 * Map a free-form platform label (any casing / common alias) to the canonical
 * internal key. Unknown values return "" so they can be filtered out.
 */
export function normalizePlatform(value: string): string {
  const v = (value || "").toString().trim().toLowerCase();
  if (!v) return "";
  // Order matters: story / reels must win over the plain "instagram" match.
  if (/stor(y|ies)/.test(v)) return "instagram-story";
  if (/reel/.test(v)) return "instagram-reels";
  if (/tik\s*tok/.test(v)) return "tiktok";
  if (/short/.test(v) || /^yt$|youtube/.test(v)) return "youtube-shorts";
  if (/instagram|insta|^ig$/.test(v)) return "instagram";
  if (/linked/.test(v)) return "linkedin";
  if (/face\s*book|^fb$|^meta$/.test(v)) return "facebook";
  if (/twitter|^x$|^x[\s/(]/.test(v)) return "x";
  return "";
}

/**
 * Decide the single best output format for a post given the platforms it
 * targets. Implements the documented priority fallback so multi-platform posts
 * still get one coherent, safe canvas:
 *   1. Any vertical (TikTok / Reels / Shorts / Story)        -> 1080x1920
 *   2. Instagram feed only                                   -> 1080x1350
 *   3. Only landscape pro (LinkedIn / Facebook / X)          -> 1200x627
 *   4. Landscape pro mixed with Instagram feed (compromise)  -> 1080x1080
 * A single platform always returns its native recommended format.
 */
export function getSocialImageSpec(platforms: string[]): SocialImageSpec {
  const canonical = Array.from(
    new Set((platforms || []).map(normalizePlatform).filter(Boolean)),
  );

  if (canonical.length === 0) return { ...DEFAULT_SPEC, platforms: canonical };

  // Priority 1: any vertical platform forces a full-height story canvas.
  if (canonical.some((p) => VERTICAL_PLATFORMS.has(p))) {
    return { ...STORY_SPEC, platforms: canonical };
  }

  // A single platform uses its native recommended format.
  if (canonical.length === 1) {
    const native = NATIVE_SPECS[canonical[0]];
    return native
      ? { ...native, platforms: canonical }
      : { ...DEFAULT_SPEC, platforms: canonical };
  }

  const hasInstagramFeed = canonical.includes("instagram");
  const hasLandscapePro = canonical.some((p) => LANDSCAPE_PRO_PLATFORMS.has(p));

  // Priority 4: pro feed mixed with Instagram feed -> square compromise.
  if (hasInstagramFeed && hasLandscapePro) {
    return { ...SQUARE_SPEC, platforms: canonical };
  }
  // Priority 2: Instagram feed only -> recommended portrait.
  if (hasInstagramFeed) {
    return { ...PORTRAIT_SPEC, platforms: canonical };
  }
  // Priority 3: only landscape pro platforms -> shared landscape.
  if (hasLandscapePro) {
    return { ...LANDSCAPE_PRO_SPEC, platforms: canonical };
  }
  return { ...DEFAULT_SPEC, platforms: canonical };
}
