import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { query, queryOne, transaction } from "../lib/db.js";
import { badRequest, conflict, forbidden, unauthorized } from "../lib/errors.js";
import {
  MIN_PASSWORD_LENGTH,
  fakeVerifyDelay,
  hashPassword,
  verifyPassword,
} from "../lib/password.js";
import {
  createSession,
  destroyAllSessions,
  destroySession,
  readSession,
} from "../lib/session.js";
import { clientIp, requireTenant } from "../lib/tenant.js";
import { asEmail, asString } from "../lib/validate.js";
import { hitRateLimit } from "../lib/rateLimit.js";
import { sendMail } from "../lib/mail.js";
import { env } from "../lib/env.js";

const RESET_TTL_MS = 60 * 60 * 1000;

function hashOneTimeToken(token: string): string {
  return createHash("sha256").update(`${token}:${env.sessionSecret}`).digest("hex");
}

interface ProfileAuthRow {
  id: string;
  email: string;
  role: "user" | "admin" | "super_admin";
  plan: string;
  created_at: Date;
  blocked_at: Date | null;
  password_hash: string | null;
  password_salt: string | null;
}

function publicUser(row: {
  id: string;
  email: string;
  role: string;
  created_at: Date;
}) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    // Registration is unauthenticated, so it is rate limited per IP: without
    // it, this endpoint is a free way to fill the accounts table.
    await hitRateLimit(`register:${clientIp(request)}`, 10, 3600);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = asEmail(body.email);
    const password = asString(body.password, "password", { min: MIN_PASSWORD_LENGTH, max: 200 });

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM profiles WHERE email = $1`,
      [email],
    );
    if (existing) {
      // This one DOES disclose that the address is taken, because a signup
      // form has to: the alternative is an account the user cannot create and
      // cannot explain. Login and password reset stay silent (see below).
      throw conflict("Un compte existe déjà pour cette adresse email.", "email_taken");
    }

    const { hash, salt } = await hashPassword(password);
    const created = await queryOne<ProfileAuthRow>(
      `INSERT INTO profiles (email, password_hash, password_salt)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, plan, created_at, blocked_at, password_hash, password_salt`,
      [email, hash, salt],
    );
    if (!created) throw badRequest("La création du compte a échoué.");

    await createSession(reply, created.id, {
      userAgent: request.headers["user-agent"],
      ip: clientIp(request),
    });
    return reply.code(201).send({ user: publicUser(created) });
  });

  app.post("/auth/login", async (request, reply) => {
    await hitRateLimit(`login:${clientIp(request)}`, 20, 900);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = asEmail(body.email);
    const password = asString(body.password, "password", { max: 200 });

    const row = await queryOne<ProfileAuthRow>(
      `SELECT id, email, role, plan, created_at, blocked_at, password_hash, password_salt
         FROM profiles WHERE email = $1`,
      [email],
    );

    if (!row) {
      // Burn comparable time before answering. Returning immediately would
      // make "no such account" measurably faster than "wrong password", which
      // turns this endpoint into an account-enumeration oracle.
      await fakeVerifyDelay();
      throw unauthorized("Email ou mot de passe incorrect.");
    }

    const ok = await verifyPassword(password, {
      hash: row.password_hash,
      salt: row.password_salt,
    });
    // Deliberately the same message and status as the unknown-account case.
    if (!ok) throw unauthorized("Email ou mot de passe incorrect.");

    if (row.blocked_at) {
      throw forbidden("Ce compte est suspendu. Contactez le support.");
    }

    await createSession(reply, row.id, {
      userAgent: request.headers["user-agent"],
      ip: clientIp(request),
    });
    return { user: publicUser(row) };
  });

  app.post("/auth/logout", async (request, reply) => {
    await destroySession(request, reply);
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request) => {
    const user = await readSession(request);
    if (!user) throw unauthorized();
    return {
      user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt },
    };
  });

  app.patch("/auth/password", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const currentPassword = asString(body.currentPassword, "currentPassword", { max: 200 });
    const newPassword = asString(body.newPassword, "newPassword", {
      min: MIN_PASSWORD_LENGTH,
      max: 200,
    });

    const row = await queryOne<{ password_hash: string | null; password_salt: string | null }>(
      `SELECT password_hash, password_salt FROM profiles WHERE id = $1`,
      [ctx.profileId],
    );
    if (!row) throw unauthorized();

    // Verified server-side, in the same request that changes it: a session
    // left open on a shared machine is not on its own enough to take over an
    // account. Checking in a separate call would leave a window between the
    // check and the change.
    const ok = await verifyPassword(currentPassword, { hash: row.password_hash, salt: row.password_salt });
    if (!ok) throw badRequest("Mot de passe actuel incorrect.");

    const { hash, salt } = await hashPassword(newPassword);
    await query(
      `UPDATE profiles SET password_hash = $1, password_salt = $2 WHERE id = $3`,
      [hash, salt, ctx.profileId],
    );

    // Every other session dies with the old password. A password change that
    // left them alive would not lock out whoever prompted it.
    await destroyAllSessions(ctx.profileId);
    await createSession(reply, ctx.profileId, {
      userAgent: request.headers["user-agent"],
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.post("/auth/password-reset/request", async (request) => {
    await hitRateLimit(`reset:${clientIp(request)}`, 5, 3600);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = asEmail(body.email);

    const row = await queryOne<{ id: string }>(`SELECT id FROM profiles WHERE email = $1`, [email]);

    if (row) {
      const token = randomBytes(32).toString("base64url");
      await query(
        `INSERT INTO one_time_tokens (profile_id, purpose, token_hash, expires_at)
         VALUES ($1, 'password_reset', $2, $3)`,
        [row.id, hashOneTimeToken(token), new Date(Date.now() + RESET_TTL_MS)],
      );
      const link = `${env.appPublicUrl}/reset-password?token=${encodeURIComponent(token)}`;
      await sendMail({
        to: email,
        subject: `Réinitialisation de votre mot de passe ${env.appName}`,
        html:
          `<p>Vous avez demandé à réinitialiser votre mot de passe.</p>` +
          `<p><a href="${link}">Choisir un nouveau mot de passe</a></p>` +
          `<p>Ce lien expire dans une heure et ne peut servir qu'une fois. ` +
          `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`,
      }).catch((err) => {
        // A mail failure must not change the answer below, or the timing and
        // the response would reveal whether the address exists.
        request.log.error({ err }, "password reset email failed");
      });
    }

    // Identical answer either way: this endpoint must not reveal which
    // addresses have an account.
    return { ok: true };
  });

  app.post("/auth/password-reset/confirm", async (request) => {
    await hitRateLimit(`reset-confirm:${clientIp(request)}`, 20, 3600);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = asString(body.token, "token", { max: 200 });
    const password = asString(body.password, "password", {
      min: MIN_PASSWORD_LENGTH,
      max: 200,
    });

    const { hash, salt } = await hashPassword(password);

    await transaction(async (client) => {
      // Claiming the token and changing the password are one unit: a crash
      // between them would either burn a token without changing anything, or
      // leave a used token replayable.
      const claimed = await client.query<{ profile_id: string }>(
        `UPDATE one_time_tokens
            SET used_at = now()
          WHERE token_hash = $1
            AND purpose = 'password_reset'
            AND used_at IS NULL
            AND expires_at > now()
          RETURNING profile_id`,
        [hashOneTimeToken(token)],
      );
      const profileId = claimed.rows[0]?.profile_id;
      if (!profileId) {
        throw badRequest("Ce lien de réinitialisation est invalide ou a expiré.", "invalid_token");
      }
      await client.query(
        `UPDATE profiles SET password_hash = $1, password_salt = $2 WHERE id = $3`,
        [hash, salt, profileId],
      );
      // Anyone holding an old session is signed out: a reset is normally a
      // response to a compromise.
      await client.query(`DELETE FROM sessions WHERE profile_id = $1`, [profileId]);
    });

    return { ok: true };
  });
}
