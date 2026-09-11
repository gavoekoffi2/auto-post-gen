import type { FastifyInstance } from "fastify";
import { queryOne } from "../lib/db.js";
import { badRequest, notConfigured, notFound, rateLimited } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { requireTenant } from "../lib/tenant.js";
import { asObject, asString, asStringArray, asUuid } from "../lib/validate.js";
import { consumeQuota, releaseQuota } from "../services/quota.js";
import { readJob, startPosterJob, type JobRow } from "../services/generation.js";
import { generateText } from "../services/text.js";

const IMAGE_HOURLY_MAX = 30;
const TEXT_HOURLY_MAX = 20;

function presentJob(job: JobRow) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.result_url ? { url: job.result_url } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.format ? { format: job.format } : {}),
  };
}

export async function generationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/generations/text", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = asObject(request.body, "body");

    const platforms = asStringArray(body.platforms, "platforms", { maxItems: 8, maxLength: 40 });
    const prompt = asString(body.prompt, "prompt", { max: 2000, optional: true });

    if (!env.openRouterKey) {
      throw notConfigured(
        "La génération de texte n'est pas configurée sur ce serveur (OPENROUTER_API_KEY).",
      );
    }

    const reserved = await consumeQuota(ctx.profileId, "generate-text", TEXT_HOURLY_MAX, 3600);
    if (!reserved) {
      throw rateLimited(
        `Limite de ${TEXT_HOURLY_MAX} générations de texte par heure atteinte. Réessayez plus tard.`,
      );
    }

    try {
      const result = await generateText({ profileId: ctx.profileId, platforms, prompt });
      // A canned fallback is not a generation. Give the reservation back so a
      // provider outage does not burn the user's hourly budget, and tell the
      // client it is filler so the UI can say so instead of passing it off as
      // a real result.
      if (result.fallback) await releaseQuota(ctx.profileId, "generate-text");
      return result;
    } catch (err) {
      await releaseQuota(ctx.profileId, "generate-text");
      throw err;
    }
  });

  app.post("/generations/image", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = asObject(request.body, "body");

    const postId = asUuid(body.postId, "postId");
    const platforms = asStringArray(body.platforms, "platforms", { maxItems: 8, maxLength: 40 });
    const requested = asString(body.contentCategory, "contentCategory", { max: 20, optional: true });

    // The post must belong to this account. Looking it up with the profile id
    // is what stops a caller from spending its own quota rendering a poster
    // onto someone else's post.
    const post = await queryOne<{
      id: string;
      content: string;
      content_category: string | null;
      platforms: string[];
    }>(
      `SELECT id, content, content_category, platforms
         FROM posts WHERE id = $1 AND profile_id = $2`,
      [postId, ctx.profileId],
    );
    if (!post) throw notFound("Publication introuvable.");

    const profile = await queryOne<{
      company_name: string | null;
      sector: string | null;
      description: string | null;
      poster_footer_text: string | null;
      brand_primary_color: string | null;
      brand_secondary_color: string | null;
      brand_accent_color: string | null;
      logo_url: string | null;
    }>(
      `SELECT company_name, sector, description, poster_footer_text,
              brand_primary_color, brand_secondary_color, brand_accent_color, logo_url
         FROM profiles WHERE id = $1`,
      [ctx.profileId],
    );
    if (!profile) throw notFound("Profil introuvable.");

    const category = (requested || post.content_category || "value") as
      | "value" | "research" | "promo";
    if (!["value", "research", "promo"].includes(category)) {
      throw badRequest("Catégorie éditoriale inconnue.");
    }

    const reserved = await consumeQuota(ctx.profileId, "generate-image", IMAGE_HOURLY_MAX, 3600);
    if (!reserved) {
      throw rateLimited(
        `Limite de ${IMAGE_HOURLY_MAX} affiches par heure atteinte. Réessayez plus tard.`,
      );
    }

    let job: JobRow;
    try {
      job = await startPosterJob({
        profileId: ctx.profileId,
        postId: post.id,
        postContent: post.content,
        contentCategory: category,
        platforms: platforms.length ? platforms : post.platforms,
        companyName: profile.company_name ?? "Entreprise",
        sector: profile.sector ?? "",
        description: profile.description ?? "",
        footerText: profile.poster_footer_text ?? "",
        colors: [
          profile.brand_primary_color,
          profile.brand_secondary_color,
          profile.brand_accent_color,
        ].filter((c): c is string => Boolean(c && /^#[0-9a-f]{6}$/i.test(c))),
        logoUrl: profile.logo_url,
      });
    } catch (err) {
      await releaseQuota(ctx.profileId, "generate-image");
      throw err;
    }

    // A provider failure that happened before any billable render gives the
    // reservation back: a bad key must not eat the user's hourly budget.
    if (job.status === "failed") {
      await releaseQuota(ctx.profileId, "generate-image");
    }

    return presentJob(job);
  });

  app.post("/generations/video", async () => {
    // Not implemented. Stated plainly rather than returning a stub that looks
    // like a queued job the client would then poll forever.
    throw notConfigured(
      "La génération vidéo n'est pas encore disponible sur ce serveur.",
    );
  });

  /**
   * Reads a job.
   *
   * This is the resume path. It is a STATUS READ: it never starts a new
   * render, so calling it after a reload — or repeatedly while polling —
   * cannot produce a second billable generation.
   */
  app.get("/generations/:id", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const jobId = asUuid((request.params as { id?: string }).id, "id");

    const job = await readJob(ctx.profileId, jobId);
    if (!job) throw notFound("Tâche de génération introuvable.");
    return presentJob(job);
  });
}
