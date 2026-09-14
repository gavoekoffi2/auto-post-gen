// Pure, dependency-free helpers shared by the two poster builders:
//
//   * generate-image/index.ts  — interactive generation (dashboard)
//   * _shared/graphiste.ts     — automatic generation (weekly cron)
//
// No Deno globals here, so this module is unit-testable from Node (the test
// suite imports it directly via type-stripping), exactly like graphisteParse.ts.
//
// Two things live here:
//
//  1. The user's saved VISUAL preferences (style, people type, brand font).
//     They are stored on the profile and were previously read from the DB but
//     never sent to the poster engine — every poster looked the same whatever
//     the user picked. These builders turn them into explicit art direction.
//
//  2. The optional PERSONAL PHOTO ("ma photo sur chaque affiche"). When the
//     user opts in and uploads a portrait, Graphiste GPT receives it as
//     `reference_image_url` and the subject carries the composition rules that
//     make the result a real poster: the person is cut out and integrated, the
//     poster text sits on the opposite side, and the face is never altered.

export type PosterPersonPlacement = "left" | "right" | "center";

export interface PosterPersonInput {
  enabled?: boolean | null;
  imageUrl?: string | null;
  label?: string | null;
  placement?: string | null;
}

export interface PosterPerson {
  imageUrl: string;
  label: string;
  placement: PosterPersonPlacement;
}

export const POSTER_PERSON_LABEL_MAX = 60;

function normalizePlacement(value: unknown): PosterPersonPlacement {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "left" || v === "right" || v === "center") return v;
  return "right";
}

// Returns the usable personal photo, or null when the feature is off / the
// stored URL is not something the poster API can fetch.
//
// Only absolute https URLs are accepted: Graphiste GPT downloads this URL
// server-side, so a data: URL, a relative path or a plain-http URL would either
// fail or leak the poster job into an insecure fetch.
export function normalizePosterPerson(
  input: PosterPersonInput | null | undefined,
): PosterPerson | null {
  if (!input || input.enabled !== true) return null;
  const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  if (!/^https:\/\/[^\s]+$/i.test(imageUrl) || imageUrl.length > 2000) return null;
  return {
    imageUrl,
    label: (typeof input.label === "string" ? input.label : "").trim().slice(0, POSTER_PERSON_LABEL_MAX),
    placement: normalizePlacement(input.placement),
  };
}

// True when the user asked for their photo on every poster but no usable photo
// is stored. The caller surfaces an actionable error instead of quietly
// producing a poster without the person the user was promised.
export function posterPersonMisconfigured(input: PosterPersonInput | null | undefined): boolean {
  return !!input && input.enabled === true && normalizePosterPerson(input) === null;
}

export const POSTER_PERSON_MISSING_MESSAGE =
  "Votre photo personnelle est activée pour vos affiches mais aucune photo valide n'est enregistrée. " +
  "Ajoutez-la dans Profil → Images → « Ma photo sur chaque affiche », puis relancez la génération.";

const PLACEMENT_SIDE: Record<PosterPersonPlacement, { person: string; text: string }> = {
  left: { person: "sur le tiers gauche", text: "à droite" },
  right: { person: "sur le tiers droit", text: "à gauche" },
  center: { person: "au centre, en pied", text: "en haut et en bas" },
};

// Art direction for the supplied portrait. Sent inside `subject` alongside the
// `reference_image_url` field so the engine treats the photo as the real person
// to feature, not as a mood/style reference.
export function posterPersonBlock(person: PosterPerson | null): string {
  if (!person) {
    return "Aucune photo réelle n'est fournie: n'ajoute pas de portrait de personne réelle identifiable.";
  }
  const side = PLACEMENT_SIDE[person.placement];
  // Deliberately dense: this block competes for room with the rest of the art
  // direction inside the subject budget (see assembleSubject).
  const parts = [
    `PHOTO RÉELLE FOURNIE (reference_image_url): intègre CETTE personne dans l'affiche — détourage net (aucun reste du fond d'origine), placée ${side.person}, occupant environ 40% de la hauteur, ombre portée douce et aplat aux couleurs de la marque derrière elle.`,
    `Fidélité absolue: conserve exactement son visage, sa carnation, sa coiffure et sa tenue; ne la remplace jamais par une personne générée, n'éclaircis pas la peau, ne déforme ni les traits ni les mains.`,
    `Réserve l'espace ${side.text} pour le titre et le texte: aucun texte ne doit recouvrir le visage ni le buste.`,
  ];
  if (person.label) {
    parts.push(`Sous la personne, écris le texte exact "${person.label}" en petit et lisible, sans le reformuler.`);
  }
  parts.push(
    `EN: composite the supplied real person, exact same face and outfit, clean cutout, soft contact shadow, headline on the opposite side, never cover the face.`,
  );
  return parts.join(" ");
}

// The saved "style d'image" preference (Profil → Images).
export function imageStyleDirection(style?: string | null): string {
  switch ((style || "").trim().toLowerCase()) {
    case "illustration":
      return "Style visuel: illustration vectorielle soignée, traits nets, aplats de couleur riches, ambiance dessinée haut de gamme (pas de photo).";
    case "minimalist":
      return "Style visuel: minimaliste et abstrait, beaucoup d'espace négatif, formes géométriques simples, palette réduite, typographie dominante.";
    case "corporate":
      return "Style visuel: corporate sobre et rassurant, photographie professionnelle discrète, grille stricte, couleurs maîtrisées, aucun effet tape-à-l'œil.";
    case "flat_design":
      return "Style visuel: flat design vectoriel, aplats sans dégradé complexe, icônes et pictogrammes simples, rendu graphique moderne.";
    case "photorealistic":
    default:
      return "Style visuel: photographie ultra-réaliste haut de gamme, profondeur de champ maîtrisée, textures et lumière crédibles.";
  }
}

// The saved "type de personnes" preference. Only relevant for the people the
// engine INVENTS — it never overrides the user's own supplied photo.
export function peopleTypeDirection(peopleType?: string | null): string {
  const value = (peopleType || "").trim().toLowerCase();
  if (value === "caucasian") {
    return "Si des personnes supplémentaires sont générées, privilégier des personnes caucasiennes professionnelles et crédibles.";
  }
  return "Si des personnes supplémentaires sont générées, privilégier des personnes africaines/noires professionnelles et crédibles.";
}

// The saved brand typography preference.
export function brandFontDirection(font?: string | null): string {
  const value = (font || "").trim();
  if (!value) return "";
  return `Typographie de marque: utilise une police proche de "${value.slice(0, 40)}" pour le titre et les textes de l'affiche.`;
}

// ---------------------------------------------------------------------------
// Subject assembly
//
// The creative brief sent as `subject` is capped. Joining every line and then
// slicing the result truncates the END of the brief — which is exactly where
// the art direction lives (interdictions, people direction, English direction).
// With a long activity description, a 120-character permanent message and a
// 700-character post excerpt, the cap was already reached before those lines,
// so they silently never reached the engine.
//
// assembleSubject keeps every DIRECTIVE intact and shortens only the flexible
// part (the quoted post excerpt), which the engine merely needs as context.
// ---------------------------------------------------------------------------

// Large enough for the full art direction INCLUDING the personal-photo block
// (~850 chars in the worst case) plus a useful excerpt of the post. The API
// documents no maximum for `subject`; callers retry once with
// SUBJECT_COMPACT_CHARS if it ever answers 400 on the length.
export const SUBJECT_MAX_CHARS = 3600;
export const SUBJECT_COMPACT_CHARS = 1500;

export interface FlexibleLine {
  /** Always kept in full. */
  prefix: string;
  /** Shortened first when the brief would overflow. */
  text: string;
  /** Never cut below this many characters (default 180). */
  min?: number;
  /** Never include more than this many characters (default 700). */
  max?: number;
}

export function assembleSubject(
  lines: Array<string | FlexibleLine | null | undefined>,
  cap: number = SUBJECT_MAX_CHARS,
): string {
  const kept = lines.filter((line): line is string | FlexibleLine =>
    typeof line === "string" ? line.trim().length > 0 : !!line
  );
  // Length of everything that is never shortened (+1 per newline separator).
  const fixed = kept.reduce(
    (total, line) => total + (typeof line === "string" ? line.length : line.prefix.length) + 1,
    0,
  );
  let budget = cap - fixed;
  const out = kept.map((line) => {
    if (typeof line === "string") return line;
    const min = line.min ?? 300;
    const max = line.max ?? 700;
    const allowed = Math.max(min, Math.min(max, budget));
    const text = line.text.slice(0, allowed);
    budget -= text.length;
    return line.prefix + text;
  });
  // Final safety net: a brief made only of directives can still be long.
  return out.join("\n").slice(0, cap);
}
