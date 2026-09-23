import type { FastifyInstance } from "fastify";
import { query, queryOne, transaction } from "../lib/db.js";
import { badRequest, conflict, notConfigured, notFound } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { mailEnabled, sendMail } from "../lib/mail.js";
import { deleteProfileMedia } from "../lib/media.js";
import { hitRateLimit } from "../lib/rateLimit.js";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "../lib/password.js";
import { destroyAllSessions, destroySession, secretMatches } from "../lib/session.js";
import { clientIp, requireAdmin, requireTenant } from "../lib/tenant.js";
import { asEmail, asHeaderSafe, asObject, asString, asUuid } from "../lib/validate.js";
import { runPublishTick } from "../services/scheduler.js";
import { generateWeekFor, runWeeklyGeneration } from "../services/weekly.js";
import {
  decideRequest,
  extendTrial,
  listRequestsForAdmin,
  runSubscriptionReminders,
  setPlanManually,
} from "../services/subscriptions.js";
import { isPlanId } from "../shared/plans.js";

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
    //
    // Whoever finishes it must enforce what the plans sell, as the rest of
    // the API does: `requireActiveEntitlement(ctx.profileId)` for a NEW
    // network (re-authorising one already linked stays allowed — it is a
    // repair), and refuse beyond `entitlement.limits.socialAccounts` active
    // accounts with code "plan_limit_reached". The pricing page advertises
    // 2 / 3 / 8 networks.
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
      // Shaped for the console (src/pages/Admin.tsx). It used to return flat
      // rows the page did not expect, so the first render read
      // `user.posts.total` on undefined and the console never displayed.
      const rows = await query<{
        id: string;
        email: string | null;
        role: "user" | "admin" | "super_admin";
        blocked: boolean;
        created_at: Date;
        last_sign_in_at: Date | null;
        company_name: string | null;
        sector: string | null;
        plan: string;
        subscription_status: string;
        trial_plan: string;
        trial_ends_at: Date | null;
        current_period_ends_at: Date | null;
        posts_total: number;
        posts_published: number;
        generations: number;
        connections: number;
      }>(
        `SELECT p.id, p.email::text AS email, p.role, (p.blocked_at IS NOT NULL) AS blocked,
                p.created_at, p.company_name, p.sector, p.plan,
                p.subscription_status, p.trial_plan, p.trial_ends_at, p.current_period_ends_at,
                (SELECT max(s.created_at) FROM sessions s WHERE s.profile_id = p.id) AS last_sign_in_at,
                (SELECT count(*) FROM posts x WHERE x.profile_id = p.id)::int AS posts_total,
                (SELECT count(*) FROM posts x WHERE x.profile_id = p.id AND x.status = 'published')::int
                  AS posts_published,
                (SELECT count(*) FROM generation_usage g WHERE g.profile_id = p.id)::int AS generations,
                (SELECT count(*) FROM social_connections c WHERE c.profile_id = p.id AND c.is_active)::int
                  AS connections
           FROM profiles p ORDER BY p.created_at DESC LIMIT 500`,
      );
      const stats = await queryOne(
        `SELECT (SELECT count(*) FROM profiles)::int AS users,
                (SELECT count(*) FROM profiles WHERE blocked_at IS NULL)::int AS active,
                (SELECT count(*) FROM profiles WHERE blocked_at IS NOT NULL)::int AS blocked,
                (SELECT count(*) FROM profiles WHERE role IN ('admin', 'super_admin'))::int AS admins,
                (SELECT count(*) FROM posts)::int AS posts,
                (SELECT count(*) FROM posts WHERE status = 'published')::int AS published,
                (SELECT count(*) FROM generation_usage)::int AS generations,
                (SELECT count(*) FROM social_connections WHERE is_active)::int AS connections,
                (SELECT count(*) FROM subscription_requests WHERE status = 'pending')::int
                  AS "pendingSubscriptions"`,
      );
      const iso = (d: Date | null) => (d ? d.toISOString() : null);
      const users = rows.map((r) => ({
        id: r.id,
        email: r.email ?? "",
        role: r.role,
        blocked: r.blocked,
        createdAt: r.created_at.toISOString(),
        lastSignInAt: iso(r.last_sign_in_at),
        // Sent by the server so the page does not have to embed an owner's
        // address in the public bundle to grey out these controls.
        protectedOwner:
          r.id === ctx.profileId || (r.role === "super_admin" && ctx.user.role !== "super_admin"),
        profile: {
          company_name: r.company_name,
          sector: r.sector,
          plan: r.plan,
          subscription_status: r.subscription_status,
          trial_plan: r.trial_plan,
          trial_ends_at: iso(r.trial_ends_at),
          current_period_ends_at: iso(r.current_period_ends_at),
        },
        posts: { total: r.posts_total, published: r.posts_published },
        generations: r.generations,
        connections: r.connections,
      }));
      return { users, stats };
    }

    if (action === "create_user") {
      // For complimentary accounts and customers onboarded by hand. With a
      // plan, the operator is granting it (no end date); without one the
      // account gets the same free trial as a self-service signup.
      const email = asEmail(body.email);
      const password = asString(body.password, "password", { min: MIN_PASSWORD_LENGTH, max: 200 });
      const companyName = asString(body.companyName, "companyName", { max: 160, optional: true }) || null;
      const plan = asString(body.plan, "plan", { max: 40, optional: true });
      if (plan && !isPlanId(plan)) throw badRequest("Plan inconnu.");
      const role = asString(body.role, "role", { max: 20, optional: true }) || "user";
      if (!["user", "admin", "super_admin"].includes(role)) throw badRequest("Rôle inconnu.");
      if (role === "super_admin" && ctx.user.role !== "super_admin") {
        throw badRequest("Seul un super-administrateur peut accorder ce rôle.");
      }
      if (await queryOne(`SELECT 1 FROM profiles WHERE email = $1`, [email])) {
        throw conflict("Un compte existe déjà pour cette adresse email.", "email_taken");
      }
      const { hash, salt } = await hashPassword(password);
      const created = await queryOne<{ id: string }>(
        plan
          ? `INSERT INTO profiles (email, password_hash, password_salt, company_name, role,
                                   plan, subscription_status, current_period_ends_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'active', NULL) RETURNING id`
          : `INSERT INTO profiles (email, password_hash, password_salt, company_name, role)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        plan ? [email, hash, salt, companyName, role, plan] : [email, hash, salt, companyName, role],
      ).catch((err: { code?: string }) => {
        // Created concurrently (a double click): the unique index decides.
        if (err.code === "23505") {
          throw conflict("Un compte existe déjà pour cette adresse email.", "email_taken");
        }
        throw err;
      });
      return { ok: true, id: created?.id };
    }

    // Payment declarations to verify, pending first.
    if (action === "subscriptions") {
      return { requests: await listRequestsForAdmin() };
    }

    if (action === "approve_subscription" || action === "reject_subscription") {
      const requestId = asUuid(body.requestId, "requestId");
      const note = asString(body.note, "note", { max: 500, optional: true }) || null;
      return {
        ok: true,
        ...(await decideRequest({
          requestId,
          approve: action === "approve_subscription",
          note,
          deciderId: ctx.profileId,
        })),
      };
    }

    if (action === "extend_trial") {
      const targetId = asUuid(body.userId, "userId");
      await extendTrial(targetId, Number(body.days));
      return { ok: true };
    }

    if (action === "reset_password" || action === "delete_user") {
      const targetId = asUuid(body.userId, "userId");
      const target = await queryOne<{ role: string }>(`SELECT role FROM profiles WHERE id = $1`, [targetId]);
      if (!target) throw notFound("Compte introuvable.");
      // An operator cannot take over or erase an owner account, and nobody
      // deletes their own account from here (that path asks for the password).
      if (target.role === "super_admin" && ctx.user.role !== "super_admin") {
        throw badRequest("Ce compte ne peut pas être modifié.");
      }
      if (action === "reset_password") {
        const password = asString(body.password, "password", { min: MIN_PASSWORD_LENGTH, max: 200 });
        const { hash, salt } = await hashPassword(password);
        await query(`UPDATE profiles SET password_hash = $2, password_salt = $3 WHERE id = $1`, [
          targetId,
          hash,
          salt,
        ]);
        // Whoever was signed in with the old password is signed out.
        await destroyAllSessions(targetId);
        return { ok: true };
      }
      if (targetId === ctx.profileId || target.role === "super_admin") {
        throw badRequest("Ce compte ne peut pas être supprimé depuis la console.");
      }
      await transaction(async (client) => {
        await client.query(`DELETE FROM profiles WHERE id = $1`, [targetId]);
      });
      await deleteProfileMedia(targetId);
      return { ok: true };
    }

    if (action === "set_blocked" || action === "set_plan" || action === "set_role") {
      const targetId = asUuid(body.userId, "userId");
      // The founder account cannot be demoted or locked out by another
      // operator: losing every admin is unrecoverable without database access.
      if (action === "set_role" || action === "set_blocked") {
        // Blocking or demoting yourself locks the console's last operator out.
        if (targetId === ctx.profileId) throw badRequest("Vous ne pouvez pas modifier votre propre accès.");
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
        if (!isPlanId(plan)) throw badRequest("Plan inconnu.");
        // Granting a plan by hand activates it (see setPlanManually): setting
        // `plan` alone would leave a trialing or expired account unchanged.
        await setPlanManually(targetId, plan);
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
    const [profile, posts, comments, media, subscriptionRequests] = await Promise.all([
      queryOne(`SELECT * FROM profiles WHERE id = $1`, [ctx.profileId]),
      query(`SELECT * FROM posts WHERE profile_id = $1`, [ctx.profileId]),
      query(`SELECT * FROM social_comments WHERE profile_id = $1`, [ctx.profileId]),
      query(
        `SELECT id, kind, mime_type, size_bytes, created_at FROM media_assets WHERE profile_id = $1`,
        [ctx.profileId],
      ),
      query(
        `SELECT id, plan, billing_period, amount_fcfa, payment_method, payer_phone,
                payment_reference, status, admin_note, decided_at, created_at
           FROM subscription_requests WHERE profile_id = $1 ORDER BY created_at`,
        [ctx.profileId],
      ),
    ]);
    // Secrets are stripped: an export is the user's data, not the server's.
    const safeProfile = { ...(profile ?? {}) };
    delete (safeProfile as Record<string, unknown>).password_hash;
    delete (safeProfile as Record<string, unknown>).password_salt;
    return {
      exportedAt: new Date().toISOString(),
      profile: safeProfile,
      posts,
      comments,
      media,
      subscriptionRequests,
    };
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

  /**
   * Drives the publish queue from outside the process.
   *
   * Authorised by a shared secret compared in constant time — never by a
   * session, because there is no user here. Provided for a host that prefers
   * its own scheduler; the in-process runner covers the default deployment.
   */
  app.post("/cron/publish", async (request, reply) => {
    if (!env.cronSecret) {
      throw notConfigured("Le déclenchement externe n'est pas configuré (CRON_SECRET).");
    }
    const provided = request.headers["x-cron-secret"];
    if (!secretMatches(typeof provided === "string" ? provided : undefined, env.cronSecret)) {
      // Deliberately a 404: an endpoint that answers 401 confirms it exists.
      return reply.code(404).send({ error: "Ressource introuvable.", code: "not_found" });
    }
    return runPublishTick();
  });

  app.post("/cron/subscription-reminders", async (request, reply) => {
    if (!env.cronSecret) {
      throw notConfigured("Le déclenchement externe n'est pas configuré (CRON_SECRET).");
    }
    const provided = request.headers["x-cron-secret"];
    if (!secretMatches(typeof provided === "string" ? provided : undefined, env.cronSecret)) {
      return reply.code(404).send({ error: "Ressource introuvable.", code: "not_found" });
    }
    return runSubscriptionReminders();
  });

  app.post("/cron/weekly", async (request, reply) => {
    if (!env.cronSecret) {
      throw notConfigured("Le déclenchement externe n'est pas configuré (CRON_SECRET).");
    }
    const provided = request.headers["x-cron-secret"];
    if (!secretMatches(typeof provided === "string" ? provided : undefined, env.cronSecret)) {
      return reply.code(404).send({ error: "Ressource introuvable.", code: "not_found" });
    }
    return { results: await runWeeklyGeneration() };
  });

  /**
   * Generates this account's missing posts for the coming week, now.
   *
   * The same top-up the daily runner performs, for a user who does not want
   * to wait for it. It is a no-op when the week is already full, so it cannot
   * be used to generate an unbounded number of posts.
   */
  app.post("/posts/generate-week", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    await hitRateLimit(
      `generate-week:${ctx.profileId}`,
      6,
      3600,
      "Trop de demandes de génération de la semaine. Réessayez dans une heure.",
    );
    return generateWeekFor(ctx.profileId);
  });

  app.get("/health", async () => ({ ok: true }));
}
