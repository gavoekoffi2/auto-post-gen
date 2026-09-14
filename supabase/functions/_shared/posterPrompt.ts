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
  const parts = [
    `PHOTO RÉELLE FOURNIE (reference_image_url): c'est la photo de la personne à mettre en avant sur l'affiche.`,
    `Intègre CETTE personne dans la composition: détourage net et propre (aucun reste de l'arrière-plan d'origine), placée ${side.person}, cadrage buste ou pied selon la photo, occupant environ 40% de la hauteur de l'affiche.`,
    `Fidélité absolue: conserve exactement son visage, sa carnation, sa coiffure, sa barbe, ses lunettes et sa tenue. Ne la remplace jamais par une personne générée, ne rajeunis pas, n'éclaircis pas la peau, ne déforme ni les traits ni les mains, n'ajoute pas de membre ni de second visage.`,
    `Ancrage professionnel: ombre portée douce sous la personne, léger halo ou aplat aux couleurs de la marque derrière elle, lumière du décor cohérente avec celle de la photo, bords nets sans contour blanc.`,
    `Réserve l'espace ${side.text} pour le titre et le texte de l'affiche: aucun texte ne doit recouvrir le visage ni le buste de la personne.`,
  ];
  if (person.label) {
    parts.push(
      `Sous la personne, écris le texte exact "${person.label}" en petit, propre et lisible (nom/rôle). Ne le reformule pas.`,
    );
  }
  parts.push(
    `Direction (EN): cut out the supplied real person photo and composite it into the poster, preserve the exact same face and outfit, soft contact shadow, brand-colored backdrop, headline text on the opposite side, never cover the face.`,
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
