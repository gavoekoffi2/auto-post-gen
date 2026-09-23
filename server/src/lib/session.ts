import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { query, queryOne } from "./db.js";
import { env } from "./env.js";

// Session handling.
//
// The cookie carries a random secret and nothing else — no user id, no role,
// no expiry the client could edit. Everything about the session is looked up
// server-side from its hash, so a forged or altered cookie resolves to no
// session at all rather than to a different account.
//
// Only the HASH is stored. A dump of the sessions table therefore cannot be
// replayed as a live login.

export const SESSION_COOKIE = "psa_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  // The token is 32 random bytes, so a plain SHA-256 is the right tool: there
  // is no low-entropy secret here for a slow KDF to protect.
  return createHash("sha256").update(`${token}:${env.sessionSecret}`).digest("hex");
}

export interface SessionUser {
  id: string;
  email: string;
  role: "user" | "admin" | "super_admin";
  plan: string;
  createdAt: string;
  blockedAt: string | null;
}

/** Issues a session and sets the cookie. Returns nothing the client can forge. */
export async function createSession(
  reply: FastifyReply,
  profileId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await query(
    `INSERT INTO sessions (profile_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [profileId, hashToken(token), meta.userAgent ?? null, meta.ip ?? null, expiresAt],
  );

  reply.setCookie(SESSION_COOKIE, token, {
    // Unreadable to JavaScript, so an XSS cannot exfiltrate the session.
    httpOnly: true,
    // HTTPS only in production. Left off in local development, where there
    // is no TLS and the cookie would otherwise never be set at all.
    secure: env.isProduction,
    // The frontend and API are same-origin behind nginx, so "lax" is enough
    // and still refuses the cross-site POSTs that CSRF depends on.
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Reads and validates the session behind a request, or null. */
export async function readSession(request: FastifyRequest): Promise<SessionUser | null> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  const row = await queryOne<{
    id: string;
    email: string;
    role: SessionUser["role"];
    plan: string;
    created_at: Date;
    blocked_at: Date | null;
  }>(
    `SELECT p.id, p.email, p.role, p.plan, p.created_at, p.blocked_at
       FROM sessions s
       JOIN profiles p ON p.id = s.profile_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) return null;

  // A blocked account keeps its cookie but loses its session: the block takes
  // effect immediately, without waiting for the cookie to expire.
  if (row.blocked_at) return null;

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    plan: row.plan,
    createdAt: row.created_at.toISOString(),
    blockedAt: null,
  };
}

/** Destroys the current session and clears the cookie. */
export async function destroySession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token) {
    await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Drops every session for an account.
 *
 * Called when the password changes: a password change that left other
 * sessions alive would not lock out whoever prompted it.
 */
export async function destroyAllSessions(profileId: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE profile_id = $1`, [profileId]);
}

/** Removes expired rows. Called by the daily maintenance (services/scheduler.ts). */
export async function pruneExpiredSessions(): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH deleted AS (DELETE FROM sessions WHERE expires_at <= now() RETURNING 1)
     SELECT count(*)::text AS count FROM deleted`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Constant-time comparison for shared secrets (the cron header).
 *
 * `!==` on a secret leaks its length and its matching prefix through timing.
 */
export function secretMatches(provided: string | undefined, expected: string | null): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
