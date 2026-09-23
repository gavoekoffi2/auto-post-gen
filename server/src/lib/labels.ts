// The dashboard stores the onboarding choices as codes ("food", "casual",
// "educational"). Every prompt is written in French, and those codes went
// into it as they were — "Secteur : food", "Ton : casual" — in the brief
// Claude writes from and the one the poster renderer draws from.
//
// Unknown values (free text from an older profile) are passed through.

const SECTORS: Record<string, string> = {
  tech: "Technologie",
  fashion: "Mode et lifestyle",
  food: "Restauration",
  health: "Santé et bien-être",
  education: "Éducation",
  other: "Autre secteur (voir la description de l'activité)",
};

const TONES: Record<string, string> = {
  professional: "Professionnel",
  casual: "Décontracté",
  fun: "Fun et enjoué",
  serious: "Sérieux",
  inspiring: "Inspirant",
};

const CONTENT_TYPES: Record<string, string> = {
  educational: "Éducatif",
  promotional: "Promotionnel",
  inspirational: "Inspirant",
  entertaining: "Divertissant",
  mixed: "Mixte",
};

const label = (table: Record<string, string>, value: string | null | undefined): string => {
  const raw = (value ?? "").trim();
  return Object.prototype.hasOwnProperty.call(table, raw) ? table[raw]! : raw;
};

export const sectorLabel = (value: string | null | undefined) => label(SECTORS, value);
export const toneLabel = (value: string | null | undefined) => label(TONES, value);
export const contentTypeLabel = (value: string | null | undefined) => label(CONTENT_TYPES, value);
