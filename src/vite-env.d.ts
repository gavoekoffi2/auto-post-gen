/// <reference types="vite/client" />

// Typed frontend environment. Declaring these catches a typo in an env name at
// build time instead of shipping `undefined` into the bundle.
interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase anon / publishable key (safe in the browser; RLS protects data). */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** Supabase project ref. Informational only. */
  readonly VITE_SUPABASE_PROJECT_ID?: string;
  /** Public support address shown on the contact and legal pages. */
  readonly VITE_SUPPORT_EMAIL?: string;
  /** Footer social links. Only https URLs you actually own; empty = hidden. */
  readonly VITE_SOCIAL_TWITTER?: string;
  readonly VITE_SOCIAL_LINKEDIN?: string;
  readonly VITE_SOCIAL_INSTAGRAM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
