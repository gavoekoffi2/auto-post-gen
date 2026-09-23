// Public-facing identity of the product, in one place.
//
// The support address was hardcoded in three files, two of them LEGAL pages
// (Terms and Privacy) where it is the contact of record for a data-protection
// request. Changing it meant remembering all three — and if the domain is not
// actually owned and receiving mail, every one of those promises is broken.
// Override at build time with VITE_SUPPORT_EMAIL.
export const SUPPORT_EMAIL =
  import.meta.env.VITE_SUPPORT_EMAIL?.trim() || "contact@prosocialai.com";

export const APP_NAME = "Pro Social AI";

/**
 * Public social profiles linked from the footer, configurable per deployment.
 *
 * These were hardcoded to `prosocialai` handles. A footer link to a profile
 * that does not exist sends a prospective customer to a 404 on the very page
 * meant to build trust — so an entry is rendered only when it is configured.
 * Set the ones you actually own and leave the rest empty.
 */
export const SOCIAL_LINKS: Array<{ label: string; url: string }> = [
  { label: "Twitter", url: import.meta.env.VITE_SOCIAL_TWITTER?.trim() || "" },
  { label: "LinkedIn", url: import.meta.env.VITE_SOCIAL_LINKEDIN?.trim() || "" },
  { label: "Instagram", url: import.meta.env.VITE_SOCIAL_INSTAGRAM?.trim() || "" },
].filter((link) => link.url.startsWith("https://"));

/**
 * Date the terms and the privacy policy were last revised.
 *
 * Both pages rendered `new Date()`, so they always claimed to have been
 * updated today. On a legal document that field is a material statement — it
 * is how a user knows whether the terms changed since they accepted them — and
 * one that recomputes daily says nothing at all.
 *
 * Bump this, in the same commit, whenever you change either document.
 */
export const LEGAL_LAST_UPDATED = "2026-09-23";

export function formatLegalDate(iso: string = LEGAL_LAST_UPDATED): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Where customers send Mobile Money payments, per channel, configured at build
 * time. A value is a phone number to transfer to, or an https:// payment link
 * (a Wave merchant link, for instance). Only configured channels are offered;
 * with none, the subscription page asks the customer to contact support
 * rather than inventing a number.
 */
export const PAYMENT_ACCOUNTS: Array<{ method: "wave" | "orange_money" | "mtn_momo" | "moov_money"; value: string }> = [
  { method: "wave" as const, value: import.meta.env.VITE_PAYMENT_WAVE?.trim() || "" },
  { method: "orange_money" as const, value: import.meta.env.VITE_PAYMENT_ORANGE_MONEY?.trim() || "" },
  { method: "mtn_momo" as const, value: import.meta.env.VITE_PAYMENT_MTN_MOMO?.trim() || "" },
  { method: "moov_money" as const, value: import.meta.env.VITE_PAYMENT_MOOV_MONEY?.trim() || "" },
].filter((account) => account.value.length > 0);

/** Name the customer should see on the receiving account. */
export const PAYMENT_BENEFICIARY = import.meta.env.VITE_PAYMENT_BENEFICIARY?.trim() || APP_NAME;
