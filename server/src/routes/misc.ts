import type { FastifyInstance } from "fastify";
import { query, queryOne, transaction } from "../lib/db.js";
import { badRequest, notConfigured, notFound } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { mailEnabled, sendMail } from "../lib/mail.js";
import { deleteProfileMedia } from "../lib/media.js";
import { hitRateLimit } from "../lib/rateLimit.js";
import { verifyPassword } from "../lib/password.js";
import { destroySession } from "../lib/session.js";
import { clientIp, requireAdmin, requireTenant } from "../lib/tenant.js";
import { asEmail, asHeaderSafe, asObject, asString, asUuid } from "../lib/validate.js";

/** Social accounts, comment inbox, admin console, account lifecycle, contact. */
export async function miscRoutes(app: FastifyInstance): Promise<void> {
  // --- Social accounts ------------------------------------------------

  app.get("/social/accounts", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const rows = await query<{
      id: string;
      platform: string;
      username: string | null;
      account_name: string | null;
      is_active: boolean;
      created_at: Date;
      provider_profile_key: string | null;
    }>(
      `SELECT id, platform, username, account_name, is_active, created_at, provider_profile_key
         FROM social_connections WHERE profile_id = $1 ORDER BY created_at ASC`,
      [ctx.profileId],
    );
    return {
      // "Provisioned" means isolated: a row without a provider profile key is
      // not a usable connection, and reporting it as one would promise
      // publishing that cannot work.
      provisioned: rows.some((r) => Boolean(r.provider_profile_key)),
      accounts: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        username: r.username,
        display_name: r.account_name,
        is_active: r.is_active,
        connected_at: r.created_at.toISOString(),
      })),
    };
  });

  app.post("/social/connect", async (request, reply) => {
    await requireTenant(request, reply);
    if (!env.zernioKey) {
      throw notConfigured(
        "La connexion des réseaux sociaux n'est pas configurée sur ce serveur (ZERNIO_API_KEY).",
      );
    }
    // Implementing the provider handshake needs the operator's provider
    // account; see VPS_DEPLOYMENT_HANDOFF.md, "travail non terminé".
    throw notConfigured(
      "La connexion des réseaux sociaux doit être finalisée côté serveur (voir le handoff).",
    );
  });

  app.delete("/social/accounts/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");
    const rows = await query(
      `DELETE FROM social_connections WHERE id = $1 AND profile_id = $2 RETURNING id`,
      [id, ctx.profileId],
    );
    if (rows.length === 0) throw notFound("Compte social introuvable.");
    return reply.code(204).send();
  });

  // --- Comment inbox --------------------------------------------------

  app.get("/comments", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const status = (request.query as { status?: string } | undefined)?.status;
    const comments = await query(
      status
        ? `SELECT id, post_id, platform, external_comment_id, author_name, author_handle,
                  message, status, reply_text, replied_by, comment_created_at, created_at
             FROM social_comments WHERE profile_id = $1 AND status = $2
            ORDER BY comment_created_at DESC NULLS LAST, created_at DESC LIMIT 200`
        : `SELECT id, post_id, platform, external_comment_id, author_name, author_handle,
                  message, status, reply_text, replied_by, comment_created_at, created_at
             FROM social_comments WHERE profile_id = $1
            ORDER BY comment_created_at DESC NULLS LAST, created_at DESC LIMIT 200`,
      status ? [ctx.profileId, status] : [ctx.profileId],
    );
    return { comments };
  });

  app.patch("/comments/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const id = asUuid((request.params as { id?: string }).id, "id");
    const body = asObject(request.body, "body");
    const status = asString(body.status, "status", { max: 20 });
    if (!["new", "replied", "ignored", "hidden"].includes(status)) {
      throw badRequest("Statut de commentaire inconnu.");
    }
    const row = await queryOne(
      `UPDATE social_comments SET status = $3
        WHERE id = $1 AND profile_id = $2
        RETURNING id, post_id, platform, external_comment_id, author_name, author_handle,
                  message, status, reply_text, replied_by, comment_created_at, created_at`,
      [id, ctx.profileId, status],
    );
    if (!row) throw notFound("Commentaire introuvable.");
    return row;
  });

  app.post("/comments/sync", async (request, reply) => {
    await requireTenant(request, reply);
    throw notConfigured(
      "La synchronisation des commentaires doit être finalisée côté serveur (voir le handoff).",
    );
  });

  app.post("/comments/:id/draft", async (request, reply) => {
    await requireTenant(request, reply);
    throw notConfigured(
      "La rédaction assistée des réponses doit être finalisée côté serveur (voir le handoff).",
    );
  });

  app.post("/comments/:id/reply", async (request, reply) => {
    await requireTenant(request, reply);
    throw notConfigured(
      "L'envoi des réponses aux commentaires doit être finalisé côté serveur (voir le handoff).",
    );
  });

  // --- Admin ----------------------------------------------------------

  app.get("/admin/me", async (request, reply) => {
    const ctx = await requireAdmin(request, reply);
    return {
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        role: ctx.user.role,
        createdAt: ctx.user.createdAt,
      },
    };
  });

  app.post("/admin/actions", async (request, reply) => {
    // requireAdmin re-derives the caller from the session and refuses the
    // whole request unless they hold an operator role. The userId inside an
    // action names the account being acted ON — never who is calling.
    const ctx = await requireAdmin(request, reply);
    const body = asObject(request.body, "body");
    const action = asString(body.action, "action", { max: 40 });

    if (action === "overview") {
      const users = await query(
        `SELECT p.id, p.email, p.role, p.plan, p.company_name, p.sector,
                p.created_at, (p.blocked_at IS NOT NULL) AS blocked
           FROM profiles p ORDER BY p.created_at DESC LIMIT 500`,
      );
      const stats = await queryOne(
        `SELECT (SELECT count(*) FROM profiles)::int AS users,
                (SELECT count(*) FROM profiles WHERE blocked_at IS NULL)::int AS active,
                (SELECT count(*) FROM posts)::int AS posts,
                (SELECT count(*) FROM posts WHERE status = 'published')::int AS published,
                (SELECT count(*) FROM generation_usage)::int AS generations`,
      );
      return { users, stats };
    }

    if (action === "set_blocked" || action === "set_plan" || action === "set_role") {
      const targetId = asUuid(body.userId, "userId");
      // The founder account cannot be demoted or locked out by another
      // operator: losing every admin is unrecoverable without database access.
      if (action === "set_role" || action === "set_blocked") {
        const target = await queryOne<{ role: string }>(
          `SELECT role FROM profiles WHERE id = $1`,
          [targetId],
        );
        if (target?.role === "super_admin" && ctx.user.role !== "super_admin") {
          throw badRequest("Ce compte ne peut pas être modifié.");
        }
      }
      if (action === "set_blocked") {
        const blocked = body.blocked === true;
        await query(`UPDATE profiles SET blocked_at = $2 WHERE id = $1`, [
          targetId,
          blocked ? new Date().toISOString() : null,
        ]);
        // A blocked account's sessions die immediately rather than living on
        // until their cookie expires.
        if (blocked) await query(`DELETE FROM sessions WHERE profile_id = $1`, [targetId]);
        return { ok: true };
      }
      if (action === "set_plan") {
        const plan = asString(body.plan, "plan", { max: 40 });
        if (!["starter", "pro", "enterprise"].includes(plan)) {
          throw badRequest("Plan inconnu.");
        }
        await query(`UPDATE profiles SET plan = $2 WHERE id = $1`, [targetId, plan]);
        return { ok: true };
      }
      const role = asString(body.role, "role", { max: 20 });
      if (!["user", "admin", "super_admin"].includes(role)) throw badRequest("Rôle inconnu.");
      if (role === "super_admin" && ctx.user.role !== "super_admin") {
        throw badRequest("Seul un super-administrateur peut accorder ce rôle.");
      }
      await query(`UPDATE profiles SET role = $2 WHERE id = $1`, [targetId, role]);
      return { ok: true };
    }

    throw badRequest(`Action inconnue : ${action}.`);
  });

  // --- Account lifecycle ----------------------------------------------

  app.get("/account/export", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const [profile, posts, comments, media] = await Promise.all([
      queryOne(`SELECT * FROM profiles WHERE id = $1`, [ctx.profileId]),
      query(`SELECT * FROM posts WHERE profile_id = $1`, [ctx.profileId]),
      query(`SELECT * FROM social_comments WHERE profile_id = $1`, [ctx.profileId]),
      query(
        `SELECT id, kind, mime_type, size_bytes, created_at FROM media_assets WHERE profile_id = $1`,
        [ctx.profileId],
      ),
    ]);
    // Secrets are stripped: an export is the user's data, not the server's.
    const safeProfile = { ...(profile ?? {}) };
    delete (safeProfile as Record<string, unknown>).password_hash;
    delete (safeProfile as Record<string, unknown>).password_salt;
    return { exportedAt: new Date().toISOString(), profile: safeProfile, posts, comments, media };
  });

  app.delete("/account", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = asObject(request.body, "body");
    const password = asString(body.password, "password", { max: 200 });

    const row = await queryOne<{ password_hash: string | null; password_salt: string | null }>(
      `SELECT password_hash, password_salt FROM profiles WHERE id = $1`,
      [ctx.profileId],
    );
    // Irreversible, so an open session on a shared machine is not enough.
    if (!row || !(await verifyPassword(password, { hash: row.password_hash, salt: row.password_salt }))) {
      throw badRequest("Mot de passe incorrect.");
    }

    // Rows first, inside one transaction: a partial delete would leave data
    // the user can no longer reach or ask about. The media directory goes
    // afterwards — a leftover file is wasted space, a leftover row is a leak.
    await transaction(async (client) => {
      await client.query(`DELETE FROM profiles WHERE id = $1`, [ctx.profileId]);
    });
    await deleteProfileMedia(ctx.profileId);
    await destroySession(request, reply);

    return reply.code(204).send();
  });

  // --- Contact form (public) ------------------------------------------

  app.post("/contact", async (request) => {
    await hitRateLimit(`contact:${clientIp(request)}`, 5, 3600);
    const body = asObject(request.body, "body");

    // Honeypot: a real visitor never fills this hidden field. Answer success
    // so a bot learns nothing from the difference.
    if (asString(body.company, "company", { max: 200, optional: true })) return { ok: true };

    const name = asHeaderSafe(body.name, "name", 100);
    const email = asEmail(body.email);
    const subject = asHeaderSafe(body.subject, "subject", 200) || "Sans sujet";
    const message = asString(body.message, "message", { min: 1, max: 5000 });
    if (!name) throw badRequest("Le nom est requis.");

    if (!mailEnabled()) {
      throw notConfigured("Le service de messagerie n'est pas configuré sur ce serveur.");
    }

    const escape = (value: string) =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    await sendMail({
      to: env.contactTo ?? env.resendFrom!.replace(/^.*<|>.*$/g, ""),
      subject: `[Contact] ${subject}`,
      replyTo: email,
      html:
        `<h2>Nouveau message de contact</h2>` +
        `<p><strong>Nom :</strong> ${escape(name)}</p>` +
        `<p><strong>Email :</strong> ${escape(email)}</p>` +
        `<p><strong>Sujet :</strong> ${escape(subject)}</p><hr />` +
        `<p style="white-space:pre-wrap">${escape(message)}</p>`,
    });

    return { ok: true };
  });

  app.get("/health", async () => ({ ok: true }));
}
