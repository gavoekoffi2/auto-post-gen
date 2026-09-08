// Onboarding and the profile page store SLUGS ("tech", "other",
// "professional", "educational") in profiles.sector / tone / content_types.
// Those slugs used to be injected verbatim into the French LLM prompts and
// into the web-research queries, producing nonsense like
//   "Secteur général: other"  /  "actualité other"
// which measurably degraded every generated post.
//
// This module turns a stored value into the human French label the prompts
// (and the research queries) actually need. Anything that is not a known
// slug is passed through untouched, so profiles that already hold free text
// keep working exactly as before.

const SECTOR_LABELS: Record<string, string> = {
  tech: "Technologie et numérique",
  fashion: "Mode et lifestyle",
  food: "Restauration et alimentation",
  health: "Santé et bien-être",
  education: "Éducation et formation",
  // "other" carries no information at all — the caller must fall back to the
  // free-text description, so we return an empty string rather than a label.
  other: "",
};

const TONE_LABELS: Record<string, string> = {
  professional: "Professionnel",
  casual: "Décontracté",
  fun: "Fun et enjoué",
  serious: "Sérieux",
  inspiring: "Inspirant",
};

const CONTENT_TYPE_LABELS: Record<string, string> = {
  educational: "Éducatif",
  promotional: "Promotionnel",
  inspirational: "Inspirant",
  entertaining: "Divertissant",
  mixed: "Mixte",
};

function label(map: Record<string, string>, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : trimmed;
}

/**
 * Human French sector label. Returns "" for a sector that carries no
 * information ("other", empty), so callers can fall back to the user's own
 * description instead of writing "Secteur: other" into the prompt.
 */
export function sectorLabel(value: unknown): string {
  return label(SECTOR_LABELS, value) ?? "";
}

/**
 * Sector label guaranteed to be non-empty — for the places that need a word
 * (research queries, prompt headers). Falls back to a neutral French term.
 */
export function sectorLabelOr(value: unknown, fallback = "Entreprise et services"): string {
  return sectorLabel(value) || fallback;
}

export function toneLabel(value: unknown, fallback = "Professionnel"): string {
  return label(TONE_LABELS, value) || fallback;
}

export function contentTypeLabels(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const item of list) {
    const mapped = label(CONTENT_TYPE_LABELS, item);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * The text used to classify a business (Graphiste domain, research queries).
 * The free-text description is the richest signal, so it leads; the sector
 * label only adds context when it is meaningful.
 */
export function businessDescriptor(sector: unknown, description: unknown): string {
  const desc = typeof description === "string" ? description.trim() : "";
  const sec = sectorLabel(sector);
  return [desc, sec].filter(Boolean).join(" — ");
}
