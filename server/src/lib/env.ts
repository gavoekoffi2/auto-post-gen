// Configuration, read once at boot.
//
// Two rules hold here:
//
//   * Nothing in this file is ever sent to the browser. Provider keys are
//     read by the API and used by the API; there is no route that echoes
//     one back, and the frontend has no build-time configuration at all.
//   * A missing value that would make the server behave INSECURELY is a
//     boot failure, not a warning. A missing value that only disables a
//     feature is reported once and the feature says so at the point of use,
//     rather than silently doing nothing.

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is not set. The API refuses to start without it — see .env.example.`,
    );
  }
  return value.trim();
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

const isProduction = process.env.NODE_ENV === "production";

// A short secret would make session cookies guessable, so the length is
// enforced rather than suggested.
function sessionSecret(): string {
  const secret = required("SESSION_COOKIE_SECRET");
  if (secret.length < 32) {
    throw new Error(
      "SESSION_COOKIE_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32",
    );
  }
  return secret;
}

/**
 * The database connection string.
 *
 * Two ways in, and the second is the one Compose uses:
 *
 *   1. DATABASE_URL — a complete connection string. Local development, CI,
 *      and anything running outside Compose.
 *   2. PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE — the parts, which
 *      this function assembles.
 *
 * Why the parts matter in production: a URL built by string interpolation in
 * a YAML file embeds the password in the resolved configuration, so
 * `docker compose config` prints it (or masks it, which reads like the file
 * itself contains a literal mask and sends an operator hunting a bug that is
 * not there). Worse, it is silently WRONG for a password containing @ : / ? #
 * or any other character that means something inside a URL — the connection
 * then fails with an authentication error that points nowhere near the cause.
 *
 * Assembling here fixes both: the password travels as its own variable, and
 * every part is percent-encoded exactly once.
 */
function databaseUrl(): string {
  const direct = optional("DATABASE_URL");
  if (direct) return direct;

  const host = optional("PGHOST");
  const user = optional("PGUSER");
  const password = optional("PGPASSWORD");
  const database = optional("PGDATABASE");
  const port = optional("PGPORT") ?? "5432";

  if (!host || !user || !database) {
    throw new Error(
      "No database configuration. Set DATABASE_URL, or PGHOST / PGUSER / PGPASSWORD / PGDATABASE " +
        "(PGPORT defaults to 5432) — see .env.selfhosted.example.",
    );
  }

  const credentials = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `postgres://${credentials}@${host}:${port}/${encodeURIComponent(database)}`;
}

export const env = {
  isProduction,
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",

  databaseUrl: databaseUrl(),
  sessionSecret: sessionSecret(),

  /** Absolute path of the local volume uploads are written to. */
  mediaRoot: process.env.MEDIA_ROOT ?? "/app/media",

  /** Public origin, used to build links inside emails. */
  appPublicUrl: optional("APP_PUBLIC_URL") ?? "",
  appName: optional("APP_NAME") ?? "Pro Social AI",

  // --- Providers. Server-side only, every one of them. ---
  openRouterKey: optional("OPENROUTER_API_KEY"),
  openRouterTextModel: optional("OPENROUTER_TEXT_MODEL"),
  graphisteKey: optional("GRAPHISTE_GPT_API_KEY"),
  graphisteUrl: optional("GRAPHISTE_GPT_API_URL"),
  zernioKey: optional("ZERNIO_API_KEY"),
  zernioUrl: optional("ZERNIO_API_URL") ?? "https://zernio.com/api/v1",
  resendKey: optional("RESEND_API_KEY"),
  resendFrom: optional("RESEND_FROM"),
  contactTo: optional("CONTACT_TO"),
  cronSecret: optional("CRON_SECRET"),
  // TAVILY_API_KEY / BRAVE_SEARCH_API_KEY are deliberately absent: web
  // research is not implemented on this stack (see the handoff). Declaring
  // them would advertise a capability nothing reads.
} as const;

/**
 * Features that are unavailable because their key is missing. Reported once
 * at boot so an operator sees it in the logs, and surfaced again — with the
 * same wording — by the route that needs it, so a user never gets a silent
 * no-op.
 */
export function missingCapabilities(): string[] {
  const missing: string[] = [];
  if (!env.openRouterKey) missing.push("OPENROUTER_API_KEY — text generation is unavailable");
  if (!env.graphisteKey || !env.graphisteUrl) {
    // Both halves, because a key without an endpoint used to mean "send the
    // posters to a hardcoded third-party project" rather than "unavailable".
    missing.push(
      "GRAPHISTE_GPT_API_KEY / GRAPHISTE_GPT_API_URL — poster generation is unavailable",
    );
  }
  if (!env.zernioKey) missing.push("ZERNIO_API_KEY — social publishing is unavailable");
  if (!env.resendKey || !env.resendFrom) {
    missing.push("RESEND_API_KEY / RESEND_FROM — outbound email is unavailable");
  }
  // Not a secret, but the same class of problem: without it a post whose
  // poster is stored locally cannot be published, because there is no
  // absolute URL to hand the provider.
  if (!env.appPublicUrl) {
    missing.push("APP_PUBLIC_URL — email links and locally stored post images are unavailable");
  }
  return missing;
}
