import { badRequest } from "./errors.js";

// Input validation.
//
// Every value that arrives from the browser passes through one of these. They
// reject rather than coerce: silently turning a bad value into a plausible one
// is how a validation layer stops being a boundary.
//
// Length ceilings are not cosmetic — they are what stops a single request
// from filling a column, a disk, or an AI provider's token budget.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function asString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; optional?: boolean } = {},
): string {
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return "";
    throw badRequest(`Le champ « ${field} » est requis.`);
  }
  if (typeof value !== "string") {
    throw badRequest(`Le champ « ${field} » doit être du texte.`);
  }
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) {
    throw badRequest(`Le champ « ${field} » doit contenir au moins ${opts.min} caractères.`);
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw badRequest(`Le champ « ${field} » ne doit pas dépasser ${opts.max} caractères.`);
  }
  return trimmed;
}

export function asEmail(value: unknown, field = "email"): string {
  const email = asString(value, field, { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest("Adresse email invalide.");
  return email;
}

export function asBoolean(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`Le champ « ${field} » est requis.`);
  }
  if (typeof value !== "boolean") throw badRequest(`Le champ « ${field} » doit être un booléen.`);
  return value;
}

export function asInteger(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number {
  if (value === undefined || value === null) {
    if (opts.fallback !== undefined) return opts.fallback;
    throw badRequest(`Le champ « ${field} » est requis.`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) throw badRequest(`Le champ « ${field} » doit être un entier.`);
  if (opts.min !== undefined && n < opts.min) {
    throw badRequest(`Le champ « ${field} » doit être au moins ${opts.min}.`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw badRequest(`Le champ « ${field} » ne doit pas dépasser ${opts.max}.`);
  }
  return n;
}

export function asStringArray(
  value: unknown,
  field: string,
  opts: { maxItems?: number; maxLength?: number; allowed?: readonly string[] } = {},
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`Le champ « ${field} » doit être une liste.`);
  const max = opts.maxItems ?? 50;
  if (value.length > max) {
    throw badRequest(`Le champ « ${field} » ne peut pas contenir plus de ${max} éléments.`);
  }
  return value.map((item, index) => {
    const entry = asString(item, `${field}[${index}]`, { max: opts.maxLength ?? 500 });
    if (opts.allowed && !opts.allowed.includes(entry)) {
      throw badRequest(`Valeur non autorisée dans « ${field} » : ${entry}.`);
    }
    return entry;
  });
}

/**
 * An ISO instant, or null.
 *
 * A naive "YYYY-MM-DDTHH:MM:SS" without a zone is REJECTED rather than
 * guessed: reading it as UTC is exactly the bug that shifted every edited
 * post by the user's offset. The client sends a real instant or nothing.
 */
export function asInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const raw = asString(value, field, { max: 40 });
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    throw badRequest(
      `Le champ « ${field} » doit être une date complète avec fuseau horaire (format ISO 8601).`,
    );
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw badRequest(`Date invalide dans « ${field} ».`);
  return date.toISOString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A UUID from a path parameter.
 *
 * Checked before it reaches the database so a malformed id is a clean 400
 * rather than a driver error — and so the shape of a "not found" is identical
 * whether the id is nonsense or simply belongs to another account.
 */
export function asUuid(value: unknown, field: string): string {
  const id = asString(value, field, { max: 36 });
  if (!UUID_RE.test(id)) throw badRequest(`Identifiant invalide : ${field}.`);
  return id.toLowerCase();
}

/** A plain JSON object, rejecting arrays and primitives. */
export function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`Le champ « ${field} » doit être un objet.`);
  }
  return value as Record<string, unknown>;
}

/** Removes CR/LF, which are the injection primitive in an email header. */
export function asHeaderSafe(value: unknown, field: string, max = 200): string {
  return asString(value, field, { max, optional: true }).replace(/[\r\n]+/g, " ").trim();
}

// Hosts an image URL must never point at. These are not reachable from the
// public internet, so a legitimate image is never there — but the servers
// that fetch these URLs on our behalf (the poster renderer, the publishing
// provider) sit inside networks where they resolve to something, including
// cloud instance metadata.
const PRIVATE_HOST =
  /^(?:localhost|\[?::1\]?|0\.0\.0\.0|10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

/**
 * Validates a URL that will be handed to an image renderer or a publisher.
 *
 * Two shapes are accepted and no others:
 *   - a relative path under /api/media/, which is this server's own storage;
 *   - an absolute https:// URL on a public host.
 *
 * Everything else is refused. http:// is refused because the fetch would be
 * in clear; a private or link-local host is refused because the fetch happens
 * from inside someone else's network, where such a URL is an SSRF probe
 * whose result can be rendered into a poster the caller then reads back.
 */
export function asImageUrl(value: unknown, field: string, max = 500): string | null {
  const raw = asString(value, field, { max, optional: true }).trim();
  if (!raw) return null;

  if (raw.startsWith("/api/media/")) {
    // No scheme, no host, no traversal: it can only address this server.
    if (raw.includes("..") || raw.includes("//")) {
      throw badRequest(`Le champ « ${field} » contient un chemin invalide.`);
    }
    return raw;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`Le champ « ${field} » doit être une URL https valide.`);
  }
  if (url.protocol !== "https:") {
    throw badRequest(`Le champ « ${field} » doit utiliser https.`);
  }
  if (PRIVATE_HOST.test(url.hostname) || url.hostname.endsWith(".local")) {
    throw badRequest(`Le champ « ${field} » ne peut pas pointer vers une adresse interne.`);
  }
  return raw;
}
