import type { FastifyReply, FastifyRequest } from "fastify";
import { readSession, type SessionUser } from "./session.js";
import { HttpError } from "./errors.js";

// The tenant boundary.
//
// There is no row-level security behind this API: every query runs as the
// same database role. The `profile_id = $1` predicate added here IS the
// boundary, and the id it uses comes from the session cookie the server
// verified — never from the body, the query string, or a header.
//
// The shape below exists to make the unsafe version hard to write. A route
// receives a `TenantContext`, not a raw request, and the only profile id it
// can reach is `ctx.profileId`. If a handler wants to act on another
// account's row, it has to go out of its way to say so, and there is nowhere
// in the request for it to get that id from.

export interface TenantContext {
  /** The authenticated account. Every user-owned query is scoped by this. */
  readonly profileId: string;
  readonly user: SessionUser;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

/**
 * Resolves the tenant for a request, or throws 401.
 *
 * Use this in every route that touches user data. A route that does not call
 * it has no profile id at all, which is the intended failure mode: it cannot
 * accidentally read one from user input.
 */
export async function requireTenant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TenantContext> {
  const user = await readSession(request);
  if (!user) {
    throw new HttpError(401, "Votre session a expiré. Reconnectez-vous.", "unauthenticated");
  }
  return { profileId: user.id, user, request, reply };
}

/**
 * Resolves the tenant AND requires an operator role.
 *
 * The role is read from the database row behind the session, so promoting
 * yourself would mean writing to `profiles.role` — which no user-facing route
 * exposes.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TenantContext> {
  const ctx = await requireTenant(request, reply);
  if (ctx.user.role !== "admin" && ctx.user.role !== "super_admin") {
    throw new HttpError(403, "Vous n'avez pas accès à cette ressource.", "forbidden");
  }
  return ctx;
}

/**
 * The client's IP, for rate limiting the public endpoints.
 *
 * nginx sits in front, so the socket address is always the proxy. Fastify's
 * `trustProxy` is enabled in index.ts, which is what makes `request.ip` the
 * real client rather than 127.0.0.1 — and why this must NOT read a raw
 * X-Forwarded-For header itself, which any client can set.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}
