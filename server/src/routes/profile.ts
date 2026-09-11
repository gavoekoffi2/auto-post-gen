import type { FastifyInstance } from "fastify";
import { query, queryOne } from "../lib/db.js";
import { requireTenant } from "../lib/tenant.js";
import { badRequest, notConfigured, notFound, rateLimited } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { consumeQuota, releaseQuota } from "../services/quota.js";
import { AudienceProfileIncomplete, detectAudiences } from "../services/audiences.js";
import {
  asBoolean,
  asImageUrl,
  asInteger,
  asObject,
  asString,
  asStringArray,
} from "../lib/validate.js";
import { normalizeAudiences } from "../shared/audience.js";

// Columns a user may write about their own account.
//
// This allow-list is the point of the route. `plan`, `role`, `blocked_at` and
// `leader_photo_consent_at` are absent on purpose: they are privileges and
// consents, and a PATCH body must never be able to grant one. Adding a column
// here makes it user-writable, so add deliberately.
const WRITABLE = {
  company_name: (v: unknown) => asString(v, "company_name", { max: 160, optional: true }) || null,
  sector: (v: unknown) => asString(v, "sector", { max: 120, optional: true }),
  description: (v: unknown) => asString(v, "description", { max: 4000, optional: true }) || null,
  tone: (v: unknown) => asString(v, "tone", { max: 80, optional: true }),
  content_types: (v: unknown) => asStringArray(v, "content_types", { maxItems: 12, maxLength: 80 }),
  post_frequency: (v: unknown) => asInteger(v, "post_frequency", { min: 1, max: 20, fallback: 2 }),
  platforms: (v: unknown) =>
    asStringArray(v, "platforms", {
      maxItems: 8,
      maxLength: 40,
      // Mirrors the posts.platforms CHECK constraint. Letting a profile hold
      // a network a post can never target is how a user ends up with a
      // connected account they can never publish to.
      allowed: ["Instagram", "Facebook", "Twitter", "Twitter (X)", "LinkedIn"],
    }),
  preferred_days: (v: unknown) =>
    asStringArray(v, "preferred_days", {
      maxItems: 7,
      maxLength: 12,
      allowed: ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"],
    }),
  preferred_time: (v: unknown) => {
    const time = asString(v, "preferred_time", { max: 5 });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw badRequest("L'heure doit être au format HH:MM.");
    }
    return time;
  },
  promo_posts_per_week: (v: unknown) =>
    asInteger(v, "promo_posts_per_week", { min: 0, max: 20, fallback: 1 }),
  research_posts_per_week: (v: unknown) =>
    asInteger(v, "research_posts_per_week", { min: 0, max: 20, fallback: 1 }),
  auto_publish: (v: unknown) => asBoolean(v, "auto_publish", false),
  style_example: (v: unknown) => asString(v, "style_example", { max: 4000, optional: true }) || null,
  style_examples: (v: unknown) => JSON.stringify(asStyleExamples(v)),
  image_people_type: (v: unknown) => asString(v, "image_people_type", { max: 40, optional: true }),
  image_style: (v: unknown) => asString(v, "image_style", { max: 80, optional: true }) || null,
  use_custom_images: (v: unknown) => asBoolean(v, "use_custom_images", false),
  // Every one of these is handed to the poster renderer, which fetches it
  // from its own network — so each is validated, not just length-capped.
  custom_image_urls: (v: unknown) =>
    asStringArray(v, "custom_image_urls", { maxItems: 60, maxLength: 500 })
      .map((url) => asImageUrl(url, "custom_image_urls[]"))
      .filter((url): url is string => Boolean(url)),
  brand_primary_color: (v: unknown) => asHexColor(v, "brand_primary_color"),
  brand_secondary_color: (v: unknown) => asHexColor(v, "brand_secondary_color"),
  brand_accent_color: (v: unknown) => asHexColor(v, "brand_accent_color"),
  brand_font: (v: unknown) => asString(v, "brand_font", { max: 80, optional: true }) || null,
  logo_url: (v: unknown) => asImageUrl(v, "logo_url"),
  poster_footer_text: (v: unknown) =>
    asString(v, "poster_footer_text", { max: 120, optional: true }) || null,
  audience_suggestions: (v: unknown) => JSON.stringify(normalizeAudiences(v)),
  target_audiences: (v: unknown) => JSON.stringify(normalizeAudiences(v)),
  audiences_confirmed_at: () => new Date().toISOString(),
  auto_reply_instructions: (v: unknown) =>
    asString(v, "auto_reply_instructions", { max: 2000, optional: true }) || null,
} as const;

function asHexColor(value: unknown, field: string): string | null {
  const raw = asString(value, field, { max: 7, optional: true });
  if (!raw) return null;
  if (!/^#[0-9a-f]{6}$/i.test(raw)) throw badRequest(`« ${field} » doit être une couleur #RRGGBB.`);
  return raw;
}

function asStyleExamples(value: unknown): Array<{ label?: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    const obj = asObject(item, "style_examples[]");
    const content = asString(obj.content, "style_examples[].content", { max: 4000, optional: true });
    if (!content) return [];
    const label = asString(obj.label, "style_examples[].label", { max: 80, optional: true });
    return [label ? { label, content } : { content }];
  });
}

const SELECT_COLUMNS = `
  id, email, company_name, sector, description, tone, content_types, post_frequency,
  platforms, preferred_days, preferred_time, promo_posts_per_week, research_posts_per_week,
  auto_publish, style_example, style_examples, image_people_type, image_style,
  use_custom_images, custom_image_urls, brand_primary_color, brand_secondary_color,
  brand_accent_color, brand_font, logo_url, poster_footer_text, audience_suggestions,
  target_audiences, audiences_confirmed_at, auto_reply_enabled, auto_reply_instructions,
  plan, leader_photo_consent_at
`;

export async function loadProfile(profileId: string) {
  const row = await queryOne(`SELECT ${SELECT_COLUMNS} FROM profiles WHERE id = $1`, [profileId]);
  if (!row) throw notFound("Profil introuvable.");
  return row;
}

const AUDIENCE_HOURLY_MAX = 10;

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/profile", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    return loadProfile(ctx.profileId);
  });

  app.patch("/profile", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = asObject(request.body, "body");

    const assignments: string[] = [];
    // $1 is the profile id in the WHERE clause, so values start at $2.
    const params: unknown[] = [ctx.profileId];

    for (const [column, parse] of Object.entries(WRITABLE)) {
      if (!(column in body)) continue;
      const parsed = (parse as (v: unknown) => unknown)(body[column]);
      params.push(parsed);
      // The column name comes from this file's own allow-list, never from the
      // request, so it is safe to interpolate; the VALUE is always a parameter.
      assignments.push(`${column} = $${params.length}`);
    }

    // auto_reply_enabled is gated on the plan, which only the server knows.
    // A client sending `true` on a starter account does not get the feature.
    if ("auto_reply_enabled" in body) {
      const wanted = asBoolean(body.auto_reply_enabled, "auto_reply_enabled", false);
      params.push(wanted && ctx.user.plan === "enterprise");
      assignments.push(`auto_reply_enabled = $${params.length}`);
    }

    if (assignments.length === 0) return loadProfile(ctx.profileId);

    await query(
      `UPDATE profiles SET ${assignments.join(", ")} WHERE id = $1`,
      params,
    );
    return loadProfile(ctx.profileId);
  });

  app.post("/profile/leader-photo-consent", async (request, reply) => {
    const ctx = await requireTenant(request, reply);
    const body = asObject(request.body, "body");
    const granted = asBoolean(body.granted, "granted");

    // Consent is an explicit, revocable act with its own endpoint. It is never
    // a side effect of saving the profile, and never inferred from the presence
    // of an uploaded photo — which is the whole point of recording it.
    await query(
      `UPDATE profiles SET leader_photo_consent_at = $2 WHERE id = $1`,
      [ctx.profileId, granted ? new Date().toISOString() : null],
    );
    return loadProfile(ctx.profileId);
  });

  /**
   * Proposes audience segments for THIS account.
   *
   * The body is ignored on purpose: the analysis is built from the caller's own
   * profile row, resolved from the session. Accepting a company description
   * from the browser would let any account pay for — and read — an analysis of
   * a business it does not own.
   */
  app.post("/profile/audiences/detect", async (request, reply) => {
    const ctx = await requireTenant(request, reply);

    if (!env.openRouterKey) {
      throw notConfigured(
        "L'analyse des cibles n'est pas configurée sur ce serveur (OPENROUTER_API_KEY).",
      );
    }

    const reserved = await consumeQuota(ctx.profileId, "detect-audiences", AUDIENCE_HOURLY_MAX, 3600);
    if (!reserved) {
      throw rateLimited("Limite d'analyses atteinte. Réessayez dans une heure.");
    }

    try {
      const audiences = await detectAudiences(ctx.profileId);
      // Only a suggestion is stored. target_audiences stays untouched: a
      // proposal becomes a target when a human selects it, never because the
      // analysis ran.
      await query(`UPDATE profiles SET audience_suggestions = $2::jsonb WHERE id = $1`, [
        ctx.profileId,
        JSON.stringify(audiences),
      ]);
      return { audiences };
    } catch (err) {
      // An analysis that produced nothing is not an analysis. Give the
      // reservation back, or a user hitting a provider outage burns their
      // hourly allowance without ever seeing a single target — during
      // onboarding, where there is nothing else to do.
      await releaseQuota(ctx.profileId, "detect-audiences");
      if (err instanceof AudienceProfileIncomplete) throw badRequest(err.message);
      request.log.error({ err }, "audience detection failed");
      throw notConfigured(
        "L'analyse des cibles n'a pas abouti. Réessayez dans quelques instants, " +
          "ou décrivez votre cible à la main.",
      );
    }
  });
}
