// Per-network caption limits.
//
// This module is intentionally dependency-free and uses only erasable
// TypeScript so the exact same file works in three runtimes:
//   - the API server (Node):   server/src/shared/platformTextLimits.ts
//   - the dashboard (Vite / React):       src/lib/platformTextLimits.ts
//   - the Node test runner (type stripping)
//
// Keep the two copies byte-for-byte identical — a regression test enforces it.
// Edit both together.
//
// Nothing in the live publishing path enforced these. The generators are asked
// for 90-160 words (roughly 600-1100 characters) and ensurePostEngagement then
// appends an engagement line plus a hashtag line — so any post targeting X was
// several times over its 280-character limit and could only be rejected or
// truncated mid-sentence by the provider, losing the call to action and the
// hashtags. A user who ticked "Twitter" during onboarding had no way to know.
//
// One post goes to every network the user selected, so the binding limit is the
// tightest one among them.

export interface PlatformTextLimit {
  /** Canonical lowercase platform id. */
  platform: string;
  /** Label shown to the user. */
  label: string;
  /** Maximum characters the network accepts in the post body. */
  maxChars: number;
}

const LIMITS: Record<string, PlatformTextLimit> = {
  twitter: { platform: "twitter", label: "X / Twitter", maxChars: 280 },
  instagram: { platform: "instagram", label: "Instagram", maxChars: 2200 },
  linkedin: { platform: "linkedin", label: "LinkedIn", maxChars: 3000 },
  facebook: { platform: "facebook", label: "Facebook", maxChars: 63206 },
  tiktok: { platform: "tiktok", label: "TikTok", maxChars: 2200 },
};

/** Widest limit, used when no known platform is selected. */
const DEFAULT_LIMIT: PlatformTextLimit = {
  platform: "",
  label: "Réseaux sélectionnés",
  maxChars: 2200,
};

export function normalizePlatformId(value: string): string {
  const v = String(value || "").toLowerCase().trim();
  if (v === "x" || v.startsWith("twitter")) return "twitter";
  if (v.startsWith("insta")) return "instagram";
  if (v.startsWith("linkedin")) return "linkedin";
  if (v.startsWith("facebook") || v === "fb") return "facebook";
  if (v.startsWith("tiktok")) return "tiktok";
  return v;
}

/**
 * The binding limit for a post addressed to `platforms`: the tightest limit
 * among the recognised ones, together with the platform that imposes it.
 */
export function getTextLimit(platforms: string[] | null | undefined): PlatformTextLimit {
  const known = (platforms || [])
    .map((p) => LIMITS[normalizePlatformId(p)])
    .filter((limit): limit is PlatformTextLimit => Boolean(limit));
  if (known.length === 0) return DEFAULT_LIMIT;
  return known.reduce((tightest, limit) =>
    limit.maxChars < tightest.maxChars ? limit : tightest
  );
}

/**
 * Length budget handed to the model, leaving room for the engagement line and
 * the hashtag line that ensurePostEngagement appends afterwards. Returns null
 * when the limit is loose enough that the normal 90-160 word brief already fits.
 */
export function tightLengthBrief(limit: PlatformTextLimit): string | null {
  if (limit.maxChars > 1000) return null;
  // Keep roughly a third of the budget for the engagement line + hashtags.
  const bodyBudget = Math.max(80, Math.floor(limit.maxChars * 0.6));
  return `CONTRAINTE DE LONGUEUR STRICTE (${limit.label}): le corps du post doit tenir en ${bodyBudget} caractères MAXIMUM, hashtags et question finale NON compris. ` +
    `Le réseau le plus contraignant sélectionné n'accepte que ${limit.maxChars} caractères au total. ` +
    `Écris court, dense et percutant : une seule idée, pas d'introduction, pas de remplissage. ` +
    `Cette contrainte prime sur toute autre indication de longueur.`;
}

/**
 * Does this content fit every selected network? Used to warn the user before
 * they schedule, and to fail a publish with an actionable reason rather than an
 * opaque provider error.
 */
export function checkTextFits(
  content: string,
  platforms: string[] | null | undefined,
): { fits: boolean; limit: PlatformTextLimit; length: number; overBy: number } {
  const limit = getTextLimit(platforms);
  // Count the way the networks do: by Unicode code points, so an emoji is one
  // character rather than the two UTF-16 units `String.length` reports.
  const length = [...String(content || "")].length;
  return {
    fits: length <= limit.maxChars,
    limit,
    length,
    overBy: Math.max(0, length - limit.maxChars),
  };
}
