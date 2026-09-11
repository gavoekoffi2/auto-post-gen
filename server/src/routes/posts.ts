import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { query, queryOne, transaction } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { clientIp, requireTenant } from "../lib/tenant.js";
import { hitRateLimit } from "../lib/rateLimit.js";
import {
  asImageUrl,
  asInstant,
  asObject,
  asString,
  asStringArray,
  asUuid,
} from "../lib/validate.js";
import { checkTextFits, normalizePlatformId } from "../shared/platformTextLimits.js";
import { publishPost } from "../services/publish.js";

const PLATFORMS_ALLOWED = [
  "Instagram",
  "Facebook",
  "Twitter",
  "Twitter (X)",
  "LinkedIn",
] as const;

const POST_COLUMNS = `
  id, title, content, content_category, platforms, status, scheduled_for, published_at,
  image_url, image_status, image_job_id, publish_error, publish_attempts,
  external_post_ids, created_at
`;

/**
 * Loads one post THAT BELONGS TO THIS ACCOUNT.
 *
 * The profile_id predicate is not an optimisation: it is what makes a post id
 * belonging to someone else indistinguishable from one that does not exist.
 * Every route below goes through this rather than selecting by id alone.
 */
interface PostRow {
  id: string;
  title: string;
  content: string;
  content_category: string | null;
  platforms: string[];
  status: string;
  scheduled_for: Date | null;
  published_at: Date | null;
  image_url: string | null;
  image_status: string | null;
  image_job_id: string | null;
  publish_error: string | null;
  publish_attempts: number;
  external_post_ids: Record<string, string>;
  created_at: Date;
}

async function loadOwnedPost(profileId: string, postId: string): Promise<PostRow> {
  const row = await queryOne<PostRow>(
    `SELECT ${POST_COLUMNS} FROM posts WHERE id = $1 AND profile_id = $2`,
    [postId, profileId],
  );
  if (!row) throw notFound("Publication introuvable.");
  return row;
}

export async function postRoutes(app: FastifyInstance): Promise<void> {
  app.get("/posts", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const posts = await query(
      `SELECT ${POST_COLUMNS} FROM posts WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [ctx.profileId],
    );
    return { posts };
  });

  app.post("/posts", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = asObject(request.body, "body");

    const title = asString(body.title, "title", { max: 200, optional: true }) || "Publication";
    const content = asString(body.content, "content", { min: 1, max: 10000 });
    const platforms = asStringArray(body.platforms, "platforms", {
      maxItems: 8,
      maxLength: 40,
      allowed: PLATFORMS_ALLOWED,
    });
    const category = asString(body.contentCategory, "contentCategory", { max: 20, optional: true });
    if (category && !["value", "research", "promo"].includes(category)) {
      throw badRequest("Catégorie éditoriale inconnue.");
    }

    const row = await queryOne(
      `INSERT INTO posts (profile_id, title, content, content_category, platforms,
                          scheduled_for, image_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING ${POST_COLUMNS}`,
      [
        ctx.profileId,
        title,
        content,
        category || null,
        platforms,
        asInstant(body.scheduledFor, "scheduledFor"),
        asImageUrl(body.imageUrl, "imageUrl"),
      ],
    );
    return reply.code(201).send(row);
  });

  app.patch("/posts/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const postId = asUuid((request.params as { id?: string }).id, "id");
    const body = asObject(request.body, "body");

    await loadOwnedPost(ctx.profileId, postId);

    const assignments: string[] = [];
    const params: unknown[] = [postId, ctx.profileId];
    const set = (column: string, value: unknown) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if ("title" in body) set("title", asString(body.title, "title", { max: 200, optional: true }));
    if ("content" in body) set("content", asString(body.content, "content", { min: 1, max: 10000 }));
    if ("platforms" in body) {
      set(
        "platforms",
        asStringArray(body.platforms, "platforms", {
          maxItems: 8,
          maxLength: 40,
          allowed: PLATFORMS_ALLOWED,
        }),
      );
    }
    if ("scheduled_for" in body) {
      set("scheduled_for", asInstant(body.scheduled_for, "scheduled_for"));
      // Rescheduling means "try at this new time": drop the backoff left from
      // a previous failure so the new slot is honoured, not held back by it.
      set("publish_attempts", 0);
      set("next_publish_attempt_at", new Date().toISOString());
    }
    if ("image_url" in body) {
      const imageUrl = asImageUrl(body.image_url, "image_url");
      set("image_url", imageUrl);
      if (imageUrl === null) {
        // Clearing the image also drops the poster job that produced it.
        // Leaving the job attached meant the next page load resumed a render
        // whose result no longer matches what the post says.
        set("image_job_id", null);
        set("image_status", null);
      }
    }
    // `status` is deliberately NOT settable here. Moving a post to
    // 'validated' or 'published' goes through the routes below, which own the
    // retry budget and the publish transition.

    if (assignments.length === 0) return loadOwnedPost(ctx.profileId, postId);

    await query(
      `UPDATE posts SET ${assignments.join(", ")} WHERE id = $1 AND profile_id = $2`,
      params,
    );
    return loadOwnedPost(ctx.profileId, postId);
  });

  app.delete("/posts/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const postId = asUuid((request.params as { id?: string }).id, "id");
    const deleted = await query(
      `DELETE FROM posts WHERE id = $1 AND profile_id = $2 RETURNING id`,
      [postId, ctx.profileId],
    );
    if (deleted.length === 0) throw notFound("Publication introuvable.");
    return reply.code(204).send();
  });

  app.post("/posts/:id/validate", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const postId = asUuid((request.params as { id?: string }).id, "id");
    await loadOwnedPost(ctx.profileId, postId);

    // The retry budget is the server's to grant. Resetting it here — rather
    // than letting the browser write publish_attempts — is what stops a client
    // from handing itself unlimited publish attempts.
    const row = await queryOne(
      `UPDATE posts
          SET status = 'validated',
              publish_error = NULL,
              publish_attempts = 0,
              next_publish_attempt_at = now()
        WHERE id = $1 AND profile_id = $2
        RETURNING ${POST_COLUMNS}`,
      [postId, ctx.profileId],
    );
    if (!row) throw notFound("Publication introuvable.");
    return row;
  });

  app.post("/posts/:id/publish", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const postId = asUuid((request.params as { id?: string }).id, "id");
    const post = await loadOwnedPost(ctx.profileId, postId);

    if (post.status !== "validated") {
      throw badRequest("Validez la publication avant de la publier.");
    }

    // An over-limit caption can only be rejected or cut mid-sentence by the
    // provider, losing the call to action and the hashtags. Say so here, with
    // the network and the overage, rather than surfacing an opaque error.
    const platforms = post.platforms ?? [];
    const fit = checkTextFits(post.content, platforms);
    if (!fit.fits) {
      const over = platforms.filter((p) => normalizePlatformId(p) === fit.limit.platform);
      if (over.length === platforms.length) {
        throw badRequest(
          `Le texte fait ${fit.length} caractères, soit ${fit.overBy} de trop pour ` +
            `${fit.limit.label} (maximum ${fit.limit.maxChars}). Raccourcissez la publication, ` +
            `ou retirez ce réseau de ses cibles.`,
        );
      }
    }

    const results = await publishPost(ctx.profileId, postId);
    return { results, post: await loadOwnedPost(ctx.profileId, postId) };
  });

  /**
   * Validation from the emailed link. No session: the one-time token IS the
   * authority, and the server decides whether it is still valid, unused and
   * in date.
   */
  app.post("/posts/validate-by-token", async (request) => {
    await hitRateLimit(`validate-token:${clientIp(request)}`, 60, 3600);
    const body = asObject(request.body, "body");
    const token = asString(body.token, "token", { max: 200 });
    const tokenHash = createHash("sha256").update(`${token}:${env.sessionSecret}`).digest("hex");

    const postId = await transaction(async (client) => {
      // Claiming the token and validating the post are one unit, so a crash
      // between them cannot burn a token without validating, or leave a used
      // token replayable.
      const claimed = await client.query<{ profile_id: string; subject_id: string | null }>(
        `UPDATE one_time_tokens
            SET used_at = now()
          WHERE token_hash = $1
            AND purpose = 'post_validation'
            AND used_at IS NULL
            AND expires_at > now()
          RETURNING profile_id, subject_id`,
        [tokenHash],
      );
      const claim = claimed.rows[0];
      if (!claim?.subject_id) {
        throw badRequest("Ce lien de validation est invalide, expiré ou déjà utilisé.");
      }

      // Only a post still awaiting approval may be validated this way: a
      // leaked link must not be able to roll back one that is already
      // published or failed.
      const updated = await client.query<{ id: string }>(
        `UPDATE posts
            SET status = 'validated',
                publish_error = NULL,
                publish_attempts = 0,
                next_publish_attempt_at = now()
          WHERE id = $1 AND profile_id = $2 AND status = 'pending'
          RETURNING id`,
        [claim.subject_id, claim.profile_id],
      );
      if (updated.rows.length === 0) {
        throw badRequest("Cette publication n'est plus en attente de validation.");
      }
      return claim.subject_id;
    });

    return { ok: true, postId };
  });

  app.get("/posts/statistics", async (request, reply) => {
    const ctx = await requireTenant(request, reply);

    const rows = await query<{ status: string; platforms: string[]; created_at: Date }>(
      `SELECT status, platforms, created_at FROM posts WHERE profile_id = $1`,
      [ctx.profileId],
    );

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const weekly = Array.from({ length: 4 }, (_, index) => {
      const offset = 3 - index;
      const from = new Date(now);
      from.setDate(now.getDate() - (now.getDay() + 7 * offset));
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(from.getDate() + 7);
      return {
        name: `Sem. ${index + 1}`,
        posts: rows.filter((r) => r.created_at >= from && r.created_at < to).length,
      };
    });

    const platformCounts = new Map<string, number>();
    for (const row of rows) {
      for (const platform of row.platforms ?? []) {
        platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);
      }
    }

    return {
      totalPosts: rows.length,
      publishedPosts: rows.filter((r) => r.status === "published").length,
      pendingPosts: rows.filter((r) => r.status === "pending").length,
      validatedPosts: rows.filter((r) => r.status === "validated").length,
      postsThisWeek: rows.filter((r) => r.created_at >= startOfWeek).length,
      postsThisMonth: rows.filter((r) => r.created_at >= startOfMonth).length,
      weekly,
      platforms: [...platformCounts].map(([name, value]) => ({ name, value })),
    };
  });
}
