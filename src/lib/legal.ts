// Date the terms and the privacy policy were last revised.
//
// Both pages rendered `new Date()`, so they always claimed to have been
// updated today. On a legal document that is a material statement — it is how
// a user knows whether the terms changed since they accepted them — and one
// that recomputes daily says nothing at all.
//
// Bump this, in the same commit, whenever you change either document.
export const LEGAL_LAST_UPDATED = "2026-09-23";

export function formatLegalDate(iso: string = LEGAL_LAST_UPDATED): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
