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
