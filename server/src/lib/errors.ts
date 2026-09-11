/**
 * An error carrying the status and the message the client should see.
 *
 * The message is written for the user, in French, and says what to do about
 * it. Everything else — stack traces, provider responses, SQL — stays in the
 * logs: an error body is a place a server leaks its internals if you let it.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, code?: string) => new HttpError(400, message, code);
export const unauthorized = (message = "Votre session a expiré. Reconnectez-vous.") =>
  new HttpError(401, message, "unauthenticated");
export const forbidden = (message = "Vous n'avez pas accès à cette ressource.") =>
  new HttpError(403, message, "forbidden");
export const notFound = (message = "Ressource introuvable.") =>
  new HttpError(404, message, "not_found");
export const conflict = (message: string, code?: string) => new HttpError(409, message, code);
export const tooLarge = (message = "Le fichier envoyé est trop volumineux.") =>
  new HttpError(413, message, "payload_too_large");
export const rateLimited = (message: string, code = "rate_limited") =>
  new HttpError(429, message, code);

/**
 * A capability is unavailable because the operator has not configured its
 * key. 503 rather than 500: the request was fine, the deployment is not, and
 * the message names the exact secret so an operator can fix it without
 * reading the code.
 */
export const notConfigured = (message: string) =>
  new HttpError(503, message, "not_configured");
