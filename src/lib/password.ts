// One password policy for the whole app.
//
// The three places that accept a password used to disagree: signup and the
// reset form asked for 6 characters, the in-account change asked for 8. A user
// could therefore create a 6-character password that the settings screen would
// then refuse to let them re-enter. The deploy workflow configures the same
// minimum on the Supabase auth service, so the rule is enforced server-side
// too and not just in the browser.
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_RULE_HINT = `Au moins ${MIN_PASSWORD_LENGTH} caractères.`;

/** Returns an error message to show the user, or null when the password is acceptable. */
export function validatePassword(password: string, confirmation?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  }
  if (confirmation !== undefined && password !== confirmation) {
    return "Les mots de passe ne correspondent pas.";
  }
  return null;
}
