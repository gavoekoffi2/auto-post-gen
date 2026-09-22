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
