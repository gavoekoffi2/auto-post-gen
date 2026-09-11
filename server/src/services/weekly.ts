import { query, queryOne } from "../lib/db.js";
import { env } from "../lib/env.js";
import { buildAudiencePrompt, normalizeAudiences } from "../shared/audience.js";
import { ensurePostEngagement } from "../shared/postEngagement.js";
import { getTextLimit, tightLengthBrief } from "../shared/platformTextLimits.js";
import { callClaude } from "./text.js";
import { startPosterJob } from "./generation.js";
import {
  buildEditorialPlan,
  isoWeekNumber,
  slotInstant,
  type ContentCategory,
} from "../shared/weeklyPlan.js";

// Automatic weekly generation.
//
// This is the "auto" in Auto Post Gen: without it post_frequency,
// preferred_days, preferred_time and the promo/research quotas are settings
// that change nothing. It tops the next seven days up to the user's chosen
// cadence, honouring the mix they asked for, and never generates a second
// batch for a week that is already full.

const HARD_MAX_POSTS_PER_RUN = 20;

const AUTO_ANGLES = [
  "Astuce concrète et applicable immédiatement",
  "Erreur courante à éviter dans le secteur",
  "Mini-checklist en 3-5 points",
  "Méthode expliquée étape par étape",
  "Idée reçue démontée avec un argument précis",
  "Comparaison avant/après concrète",
];

const TITLES: Record<ContentCategory, string> = {
  promo: "Post promotionnel",
  research: "Actualité et recherche",
  value: "Conseil et valeur",
};

interface WeeklyProfile {
  id: string;
  company_name: string | null;
  sector: string | null;
  description: string | null;
  tone: string | null;
  platforms: string[] | null;
  preferred_days: string[] | null;
  preferred_time: string | null;
  post_frequency: number | null;
  promo_posts_per_week: number | null;
  research_posts_per_week: number | null;
  target_audiences: unknown;
  auto_publish: boolean;
  use_custom_images: boolean;
  custom_image_urls: string[] | null;
  poster_footer_text: string | null;
  brand_primary_color: string | null;
  brand_secondary_color: string | null;
  brand_accent_color: string | null;
  logo_url: string | null;
}

const PROFILE_COLUMNS = `
  id, company_name, sector, description, tone, platforms, preferred_days, preferred_time,
  post_frequency, promo_posts_per_week, research_posts_per_week, target_audiences,
  auto_publish, use_custom_images, custom_image_urls, poster_footer_text,
  brand_primary_color, brand_secondary_color, brand_accent_color, logo_url
`;

export { buildEditorialPlan, slotInstant } from "../shared/weeklyPlan.js";

export interface WeeklyResult {
  profileId: string;
  generated: number;
  skipped?: string;
}

/** Generates one account's missing posts for the next seven days. */
export async function generateWeekFor(profileId: string): Promise<WeeklyResult> {
  const profile = await queryOne<WeeklyProfile>(
    `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = $1 AND blocked_at IS NULL`,
    [profileId],
  );
  if (!profile) return { profileId, generated: 0, skipped: "profile_not_found" };
  if (!env.openRouterKey) return { profileId, generated: 0, skipped: "text_generation_unavailable" };

  const now = new Date();
  const wanted = Math.min(
    HARD_MAX_POSTS_PER_RUN,
    Math.max(0, Number(profile.post_frequency ?? 2)),
  );

  // What is already queued for the coming week. Counting it is what makes a
  // second run in the same week a no-op instead of a duplicate batch.
  const existing = await query<{ content_category: string | null }>(
    `SELECT content_category FROM posts
      WHERE profile_id = $1
        AND status IN ('pending', 'validated')
        AND scheduled_for >= now()
        AND scheduled_for < now() + interval '7 days'`,
    [profileId],
  );
  const toGenerate = Math.max(0, wanted - existing.length);
  if (toGenerate === 0) return { profileId, generated: 0, skipped: "week_already_full" };

  const platforms = profile.platforms?.length ? profile.platforms : ["LinkedIn"];
  const preferredDays = profile.preferred_days?.length
    ? profile.preferred_days
    : ["Lundi", "Mercredi", "Vendredi"];
  const [rawHour, rawMinute] = String(profile.preferred_time || "10:00").split(":").map(Number);
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour!)) : 10;
  const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute!)) : 0;

  const textLimit = getTextLimit(platforms);
  const lengthBrief = tightLengthBrief(textLimit);
  const lengthRule = lengthBrief
    ? `- ${lengthBrief}`
    : "- 100% en français, 100-180 mots, 2-3 émojis pertinents";

  // The week's quotas are ceilings on the WHOLE week, so what is already
  // queued counts against them: a top-up must not add a third promo to a week
  // the user capped at two.
  const alreadyPromo = existing.filter((p) => p.content_category === "promo").length;
  const alreadyResearch = existing.filter((p) => p.content_category === "research").length;
  const promoTarget = Math.max(0, Number(profile.promo_posts_per_week ?? 1) - alreadyPromo);
  const researchTarget = Math.max(0, Number(profile.research_posts_per_week ?? 1) - alreadyResearch);
  const plan = buildEditorialPlan(promoTarget, researchTarget, toGenerate);

  const companyName = profile.company_name?.trim() || "notre entreprise";
  const sector = profile.sector || "Business";
  const description = profile.description || "";
  const tone = profile.tone || "Professionnel";
  const audiences = normalizeAudiences(profile.target_audiences);
  const weekNumber = isoWeekNumber(now);

  const customImages =
    profile.use_custom_images && Array.isArray(profile.custom_image_urls)
      ? profile.custom_image_urls.filter((u): u is string => typeof u === "string" && Boolean(u))
      : [];

  const generatedThisRun: string[] = [];
  let generated = 0;

  for (let i = 0; i < toGenerate; i++) {
    const category = plan[i] ?? "value";
    const audienceBlock = buildAudiencePrompt(audiences, i + weekNumber);
    const avoidBlock = generatedThisRun.length
      ? `\nNE répète NI le sujet NI l'accroche de ces posts déjà générés cette semaine:\n${generatedThisRun
          .map((c, k) => `${k + 1}. ${c.slice(0, 150)}`)
          .join("\n")}\n`
      : "";

    const prompt = buildPrompt({
      category,
      companyName,
      sector,
      description,
      tone,
      audienceBlock,
      lengthRule,
      lengthBrief,
      avoidBlock,
      angle: AUTO_ANGLES[(i + weekNumber) % AUTO_ANGLES.length]!,
    });

    let content = "";
    try {
      content = await callClaude({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.65,
        topP: 0.9,
      });
    } catch (err) {
      // One failed post must not abandon the rest of the week.
      console.error(`[weekly] generation failed for ${profileId}:`, (err as Error).message);
      continue;
    }
    if (!content.trim()) continue;

    content = ensurePostEngagement({
      content,
      category,
      sector,
      companyName,
      // The engagement and hashtag lines are appended after the model has
      // written, so they can push a tight post over the limit on their own.
      maxChars: textLimit.maxChars,
    });
    generatedThisRun.push(content.trim());

    // Continue past whatever is already queued, so a top-up run does not reuse
    // the days the existing posts already sit on.
    const scheduled = slotInstant(now, existing.length + i, preferredDays, hour, minute);
    const customImage = customImages.length
      ? customImages[Math.floor(Math.random() * customImages.length)]!
      : null;

    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO posts (profile_id, title, content, content_category, platforms,
                          status, scheduled_for, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        profileId,
        TITLES[category],
        content,
        category,
        platforms,
        // auto_publish means the user pre-approved the workflow, so the post
        // goes straight into the publish queue. Otherwise it waits for them.
        profile.auto_publish ? "validated" : "pending",
        scheduled.toISOString(),
        customImage,
      ],
    );
    if (!inserted) continue;
    generated++;

    // No custom image → start a poster. Best-effort: a failure here leaves the
    // post text-only rather than losing the text that was just generated.
    if (!customImage && env.graphisteKey) {
      try {
        await startPosterJob({
          profileId,
          postId: inserted.id,
          postContent: content,
          contentCategory: category,
          platforms,
          companyName,
          sector,
          description,
          footerText: profile.poster_footer_text || "",
          colors: [
            profile.brand_primary_color,
            profile.brand_secondary_color,
            profile.brand_accent_color,
          ].filter((c): c is string => Boolean(c)),
          logoUrl: profile.logo_url,
        });
      } catch (err) {
        console.error(`[weekly] poster failed for ${inserted.id}:`, (err as Error).message);
      }
    }
  }

  return { profileId, generated };
}

/** Runs a weekly top-up for every account that has finished onboarding. */
export async function runWeeklyGeneration(): Promise<WeeklyResult[]> {
  const profiles = await query<{ id: string }>(
    `SELECT id FROM profiles
      WHERE blocked_at IS NULL
        AND sector IS NOT NULL AND sector <> ''
        AND post_frequency > 0
      ORDER BY created_at ASC`,
  );
  const results: WeeklyResult[] = [];
  for (const profile of profiles) {
    try {
      results.push(await generateWeekFor(profile.id));
    } catch (err) {
      console.error(`[weekly] account ${profile.id} failed:`, (err as Error).message);
      results.push({ profileId: profile.id, generated: 0, skipped: "error" });
    }
  }
  return results;
}

function buildPrompt(input: {
  category: ContentCategory;
  companyName: string;
  sector: string;
  description: string;
  tone: string;
  audienceBlock: string;
  lengthRule: string;
  lengthBrief: string | null;
  avoidBlock: string;
  angle: string;
}): string {
  const { companyName, sector, description, tone, audienceBlock, lengthRule, avoidBlock } = input;

  if (input.category === "promo") {
    return `Tu es Claude, rédacteur marketing senior. Tu écris avec précision, naturel et une compréhension fine du lecteur. Reste STRICTEMENT dans le domaine décrit.

PROFIL DU CLIENT:
- Nom de l'entreprise: ${companyName}
- Secteur: ${sector}
${description ? `- Description de l'activité: ${description}` : ""}
- Ton: ${tone}
${audienceBlock}
OBJECTIF DE CE POST: présenter ce que propose ${companyName} et donner envie de faire appel à ses services.

RÈGLES:
- 100% en français
${lengthRule}
- Écris pour UNE CIBLE PRIORITAIRE, jamais pour « tout le monde »
- Nomme au moins une situation, douleur ou ambition concrète de cette cible
- Commence par un bénéfice concret pour le client (jamais par "Nous sommes...")
- Présente clairement le service ou la valeur que ${companyName} apporte, sans promesses irréalistes
- Écris "${companyName}" tel quel, jamais entre crochets ni en placeholder
- Termine par un appel à l'action clair et naturel, avec une intention commerciale (contacter, écrire, réserver…)
- Ajoute ensuite une question naturelle qui invite explicitement l'audience à donner son avis ou son besoin EN COMMENTAIRE
- Termine la publication par une ligne de 3-5 hashtags spécifiques au sujet, au métier et à l'audience
${avoidBlock}
Génère uniquement le texte du post, sans titre ni explication.`;
  }

  if (input.category === "research") {
    return `Tu es Claude, journaliste sectoriel et pédagogue rigoureux. Tu transformes une évolution récente du secteur en publication claire, exacte et réellement utile. Reste STRICTEMENT dans le domaine décrit.

SECTEUR: ${sector}
${description ? `ACTIVITÉ PRÉCISE: ${description}` : ""}
TON: ${tone}
${audienceBlock}

OBJECTIF ACTUALITÉ/RECHERCHE: informer l'audience sur une nouveauté, une évolution, une étude ou une tendance récente réellement pertinente pour ce métier.

RÈGLES:
${lengthRule}
- Écris pour UNE CIBLE PRIORITAIRE et relie chaque fait à ses DOULEURS ou OBJECTIFS
- N'invente JAMAIS de chiffre, de date, d'étude ni de nouveauté : si tu n'es pas certain d'un fait, reste sur ce qui est structurellement vrai du métier
- Explique concrètement ce que cette information change pour l'audience
- N'écris JAMAIS le nom de l'entreprise : ce post informe, il ne fait aucune promotion
- Aucune offre, aucun prix, aucun appel à acheter ou à contacter
- Termine par une question utile qui ouvre la discussion et invite explicitement à répondre EN COMMENTAIRE
- Termine la publication par une ligne de 3-5 hashtags spécifiques au sujet, au métier et à l'audience
${avoidBlock}
Génère uniquement le texte du post, sans titre ni explication.`;
  }

  return `Tu es Claude, rédacteur éditorial senior et pédagogue. Tu crées un contenu de forte valeur, précis, naturel et immédiatement applicable. Reste STRICTEMENT dans le domaine décrit, ne généralise pas vers d'autres sujets.

SECTEUR: ${sector}
${description ? `ACTIVITÉ PRÉCISE: ${description}` : ""}
TON: ${tone}
${audienceBlock}
ANGLE IMPOSÉ: ${input.angle}

RÈGLES:
${lengthRule}
- Écris pour UNE CIBLE PRIORITAIRE et montre que tu comprends ses DOULEURS et OBJECTIFS
- Apporte une valeur CONCRÈTE et SPÉCIFIQUE à ce métier : conseil, méthode, checklist, explication ou erreur à éviter
- Inclus au moins une étape, un critère, un exemple ou une méthode immédiatement applicable
- Vérifie silencieusement qu'aucune phrase n'est du remplissage générique
- Ce post sert uniquement à AIDER ou FORMER l'audience : aucune promotion, aucun prix, aucune offre
- N'écris JAMAIS le nom de l'entreprise, même subtilement, et ne parle pas de ses services
- Termine par une question engageante qui invite explicitement à partager un avis ou une expérience EN COMMENTAIRE
- Termine la publication par une ligne de 3-5 hashtags spécifiques au sujet, au métier et à l'audience
${avoidBlock}
Génère uniquement le texte du post, sans titre ni explication.`;
}
