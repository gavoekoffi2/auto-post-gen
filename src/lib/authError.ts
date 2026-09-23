/**
 * Turns a Supabase auth / network failure into something a French-speaking
 * user can act on.
 *
 * supabase-js surfaces provider messages verbatim, in English: "Invalid login
 * credentials", "User already registered", "Email not confirmed". A failed
 * request surfaces the browser's own "Failed to fetch". All of it reached our
 * toasts untranslated — on a product whose entire interface is French, for a
 * market where mobile connections drop regularly, the most common error a real
 * user meets was three English words that explain nothing.
 *
 * Unknown messages fall through to the supplied fallback rather than being
 * shown raw, so a provider wording we have not seen never leaks to the UI.
 */

const PATTERNS: Array<{ match: RegExp; message: string }> = [
  {
    // Network: fetch rejects before any HTTP status exists.
    match: /failed to fetch|networkerror|network request failed|load failed|err_(internet|network|connection|tunnel)/i,
    message:
      "Connexion au serveur impossible. Vérifiez votre connexion internet et réessayez.",
  },
  {
    match: /invalid login credentials|invalid email or password/i,
    message: "Email ou mot de passe incorrect.",
  },
  {
    match: /email not confirmed|email address not confirmed/i,
    message:
      "Votre email n'est pas encore confirmé. Ouvrez le lien de confirmation que nous vous avons envoyé.",
  },
  {
    match: /user already registered|already been registered/i,
    message: "Un compte existe déjà avec cet email. Connectez-vous ou réinitialisez votre mot de passe.",
  },
  {
    match: /password should be at least|password is too short/i,
    message: "Le mot de passe est trop court.",
  },
  {
    match: /unable to validate email|invalid email/i,
    message: "Cette adresse email n'est pas valide.",
  },
  {
    match: /email rate limit exceeded|over_email_send_rate_limit/i,
    message: "Trop d'emails demandés. Patientez quelques minutes avant de réessayer.",
  },
  {
    match: /for security purposes|rate limit|too many requests/i,
    message: "Trop de tentatives. Patientez quelques instants avant de réessayer.",
  },
  {
    match: /token has expired|invalid token|expired/i,
    message: "Ce lien a expiré. Demandez-en un nouveau.",
  },
  {
    match: /same password|new password should be different/i,
    message: "Le nouveau mot de passe doit être différent de l'ancien.",
  },
  {
    match: /signups not allowed|signup is disabled/i,
    message: "Les inscriptions sont momentanément fermées.",
  },
];

export function authErrorMessage(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (error as { message?: string } | null)?.message || "";
  if (!raw) return fallback;
  for (const { match, message } of PATTERNS) {
    if (match.test(raw)) return message;
  }
  // Log the untranslated text so an unmapped provider wording is findable,
  // without showing English to the user.
  console.warn("Unmapped auth error:", raw);
  return fallback;
}
