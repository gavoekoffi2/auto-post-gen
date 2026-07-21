// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { chatText, getOpenRouterKey, getTextModel } from "../_shared/ai.ts";
import { buildAudiencePrompt, normalizeAudiences } from "../_shared/audience.ts";
import { ensurePostEngagement } from "../_shared/post-engagement.ts";
import { buildInspirationBlock, researchInspiration } from "../_shared/research.ts";
import { rehostToUserAssets, startPosterJob } from "../_shared/graphiste.ts";


// ISO 8601 week number (1..53)
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const DAY_MAPPING: Record<string, number> = {
  Dimanche: 0,
  Lundi: 1,
  Mardi: 2,
  Mercredi: 3,
  Jeudi: 4,
  Vendredi: 5,
  Samedi: 6,
};

// Maximum posts a single profile can receive per weekly run, defends against
// runaway configs and platform spam limits.
const HARD_MAX_POSTS_PER_RUN = 20;

// Rotated so the week's posts don't all share the same shape.
const AUTO_ANGLES = [
  "Astuce concrète applicable tout de suite",
  "Erreur courante à éviter dans ce métier",
  "Statistique ou tendance récente, avec ton interprétation",
  "Mini-checklist en 3-5 points",
  "Idée reçue à démonter",
  "Coulisses ou leçon tirée du terrain",
];

type ContentCategory = "value" | "research" | "promo";

function buildEditorialPlan(
  targets: Record<ContentCategory, number>,
  existing: Record<ContentCategory, number>,
  slots: number,
): ContentCategory[] {
  const remaining: Record<ContentCategory, number> = {
    value: Math.max(0, targets.value - existing.value),
    research: Math.max(0, targets.research - existing.research),
    promo: Math.max(0, targets.promo - existing.promo),
  };
  const plan: ContentCategory[] = [];
  const order: ContentCategory[] = ["value", "research", "promo"];
  while (plan.length < slots && Object.values(remaining).some((count) => count > 0)) {
    for (const category of order) {
      if (plan.length >= slots) break;
      if (remaining[category] > 0) {
        plan.push(category);
        remaining[category] -= 1;
      }
    }
  }
  while (plan.length < slots) plan.push("value");
  return plan;
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Authorize the cron caller via a shared secret (set CRON_SECRET in Supabase).
  // Fail CLOSED: with verify_jwt = false this endpoint is otherwise public, so a
  // missing/empty CRON_SECRET must deny every request rather than allow them.
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (!expectedSecret) {
    console.error("CRON_SECRET is not configured; refusing to run.");
    return new Response(
      JSON.stringify({ error: "Server not configured" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const provided =
    req.headers.get("x-cron-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expectedSecret) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    console.log("Starting weekly auto-generation...");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase service credentials are not configured");
    }
    if (!getOpenRouterKey()) {
      throw new Error("OPENROUTER_API_KEY is not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Wall-clock budget for the whole run. Post creation is never skipped, but
    // once this passes we stop kicking (blocking) poster jobs so the image work
    // can't push the cron past the edge runtime limit; those posts just go out
    // text-only. publish-post still publishes everything on schedule.
    const posterDeadline = Date.now() + 90_000;

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("*")
      .eq("auto_publish", true);

    if (profilesError) throw profilesError;

    console.log(`Found ${profiles?.length || 0} profile(s) with auto_publish enabled`);

    const results: any[] = [];

    for (const profile of profiles || []) {
      try {
        const postsNeeded = Math.min(
          HARD_MAX_POSTS_PER_RUN,
          Math.max(1, profile.post_frequency || 2),
        );

        const now = new Date();
        const weekNumber = isoWeekNumber(now); // only used to vary the content angle

        // Idempotency keyed on the SCHEDULED window, not the calendar week of
        // "now". Posts are scheduled 1-7 days ahead, so keying on week_number of
        // "now" made the next run think the upcoming week was empty and generate
        // a SECOND full batch — duplicate content, double AI spend and double
        // auto-publishing. Instead count what is already queued (not yet
        // published) for the next 7 days and only top up the difference.
        const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const { data: existingPosts } = await supabase
          .from("posts")
          .select("id, content_category, title")
          .eq("user_id", profile.id)
          .in("status", ["pending", "validated", "publishing"])
          .gte("scheduled_for", now.toISOString())
          .lt("scheduled_for", windowEnd.toISOString());

        const postsToGenerate = Math.max(0, postsNeeded - (existingPosts?.length || 0));

        if (postsToGenerate === 0) {
          results.push({ userId: profile.id, postsGenerated: 0, skipped: true });
          continue;
        }

        const preferredDays: string[] = Array.isArray(profile.preferred_days) && profile.preferred_days.length > 0
          ? profile.preferred_days
          : ["Lundi", "Mercredi", "Vendredi"];

        const platforms: string[] = Array.isArray(profile.platforms) && profile.platforms.length > 0
          ? profile.platforms
          : ["Instagram"];

        // Time of day the user picked for automatic posts (defaults to 10:00).
        const [rawHour, rawMinute] = String(profile.preferred_time || "10:00")
          .split(":")
          .map((n) => parseInt(n, 10));
        const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 10;
        const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;

        // Build the exact user-selected weekly editorial mix. Existing queued
        // posts retain their persisted category, so a retry only fills missing
        // value/research/promo slots instead of creating extra promotions.
        const promoTarget = Math.min(
          Math.max(0, profile.promo_posts_per_week ?? 1),
          postsNeeded,
        );
        const researchTarget = Math.min(
          Math.max(0, profile.research_posts_per_week ?? 1),
          Math.max(0, postsNeeded - promoTarget),
        );
        const editorialTargets: Record<ContentCategory, number> = {
          promo: promoTarget,
          research: researchTarget,
          value: Math.max(0, postsNeeded - promoTarget - researchTarget),
        };
        const existingCategoryCounts: Record<ContentCategory, number> = {
          value: 0,
          research: 0,
          promo: 0,
        };
        for (const post of existingPosts || []) {
          const category = post.content_category as ContentCategory | null;
          if (category && category in existingCategoryCounts) {
            existingCategoryCounts[category] += 1;
          } else if (post.title === "Post promotionnel") {
            // Classify rows created before content_category existed.
            existingCategoryCounts.promo += 1;
          } else {
            existingCategoryCounts.value += 1;
          }
        }
        const editorialPlan = buildEditorialPlan(
          editorialTargets,
          existingCategoryCounts,
          postsToGenerate,
        );

        // Research the business ONCE per user and reuse the inspiration for
        // every post generated this week. This grounds automatic posts in
        // real, current, sector-specific facts (the same enrichment the
        // manual generator uses) while keeping the cron fast.
        const companyName = profile.company_name || "notre entreprise";
        const sector = profile.sector || "Business";
        const description = profile.description || "";
        const approvedAudiences = normalizeAudiences(profile.target_audiences);
        // Each weekly post rotates through target_audiences. buildAudiencePrompt
        // expands pain_points/goals into explicit DOULEURS and OBJECTIFS.
        let inspirationBlock = "";
        try {
          const webResults = await researchInspiration(sector, companyName, description, {
            deadlineMs: 9000,
          });
          inspirationBlock = buildInspirationBlock(
            webResults,
            description.slice(0, 120) || sector,
          );
        } catch (researchErr) {
          console.error(`Research failed for ${profile.id}:`, researchErr);
        }

        const generatedThisRun: string[] = [];
        let generated = 0;

        for (let i = 0; i < postsToGenerate; i++) {
          const contentCategory = editorialPlan[i];
          const isPromo = contentCategory === "promo";
          const isResearch = contentCategory === "research";
          const audienceBlock = buildAudiencePrompt(approvedAudiences, i + weekNumber);
          const avoidBlock = generatedThisRun.length
            ? `\nNE répète NI le sujet NI l'accroche de ces posts déjà générés cette semaine:\n${
                generatedThisRun.map((c, k) => `${k + 1}. ${c.slice(0, 150)}`).join("\n")
              }\n`
            : "";

          let contentPrompt: string;
          if (isPromo) {
            contentPrompt = `Tu es Claude, rédacteur marketing senior. Tu écris avec précision, naturel et une compréhension fine du lecteur. Reste STRICTEMENT dans le domaine décrit.

PROFIL DU CLIENT:
- Nom de l'entreprise: ${companyName}
- Secteur: ${sector}
${description ? `- Description de l'activité: ${description}` : ""}
- Ton: ${profile.tone || "Professionnel"}
${audienceBlock}
${inspirationBlock}
OBJECTIF DE CE POST: présenter ce que propose ${companyName} et donner envie de faire appel à ses services.

RÈGLES:
- 100% en français
- 90-160 mots, denses et sans remplissage
- 2-3 émojis pertinents
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
          } else if (isResearch) {
            contentPrompt = `Tu es Claude, journaliste sectoriel et pédagogue rigoureux. Tu transformes une recherche web récente en publication claire, exacte et réellement utile. Reste STRICTEMENT dans le domaine décrit.

SECTEUR: ${sector}
${description ? `ACTIVITÉ PRÉCISE: ${description}` : ""}
TON: ${profile.tone || "Professionnel"}
${audienceBlock}

OBJECTIF ACTUALITÉ/RECHERCHE: informer l'audience sur une nouveauté, une évolution, une étude ou une tendance récente réellement pertinente pour ce métier.
${inspirationBlock}
RÈGLES:
- 100% en français, 100-180 mots, 2-3 émojis pertinents
- Écris pour UNE CIBLE PRIORITAIRE et relie chaque fait à ses DOULEURS ou OBJECTIFS
- Appuie le post sur les faits trouvés dans la matière web; n'invente jamais de chiffre, date, étude ou nouveauté
- Explique concrètement ce que cette information change pour l'audience
- N'écris JAMAIS le nom de l'entreprise : ce post informe, il ne fait aucune promotion
- Aucune offre, aucun prix, aucun appel à acheter ou à contacter
- Termine par une question utile qui ouvre la discussion et invite explicitement à répondre EN COMMENTAIRE
- Termine la publication par une ligne de 3-5 hashtags spécifiques au sujet, au métier et à l'audience
${avoidBlock}
Génère uniquement le texte du post, sans titre ni explication.`;
          } else {
            contentPrompt = `Tu es Claude, rédacteur éditorial senior et pédagogue. Tu crées un contenu de forte valeur, précis, naturel et immédiatement applicable. Reste STRICTEMENT dans le domaine décrit, ne généralise pas vers d'autres sujets.

SECTEUR: ${sector}
${description ? `ACTIVITÉ PRÉCISE: ${description}` : ""}
TON: ${profile.tone || "Professionnel"}
${audienceBlock}
ANGLE IMPOSÉ: ${AUTO_ANGLES[(i + weekNumber) % AUTO_ANGLES.length]}

RÈGLES:
- 100% en français, 90-160 mots, 2-3 émojis pertinents
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

          let generatedContent = "";
          try {
            generatedContent = await chatText({
              model: getTextModel(),
              messages: [{ role: "user", content: contentPrompt }],
              temperature: 0.65,
              top_p: 0.9,
            });
          } catch (genErr) {
            console.error(
              `AI text generation failed for ${profile.id}:`,
              genErr instanceof Error ? genErr.message : genErr,
            );
            continue;
          }

          if (!generatedContent.trim()) {
            console.error(`Empty content returned for ${profile.id}`);
            continue;
          }
          generatedContent = ensurePostEngagement({
            content: generatedContent,
            category: contentCategory,
            sector,
            companyName,
          });
          // Track for intra-run de-duplication.
          generatedThisRun.push(generatedContent.trim());

          const targetDay = preferredDays[i % preferredDays.length];
          const targetDayNumber = DAY_MAPPING[targetDay] ?? 1;

          const scheduledDate = new Date(now);
          const currentDay = scheduledDate.getDay();
          let daysUntilTarget = (targetDayNumber - currentDay + 7) % 7;
          if (daysUntilTarget === 0) {
            // Target day is today: keep today only if the chosen time is still
            // ahead; otherwise push to next week. (The old `|| 7` always pushed
            // a same-day target a full week out, dropping this week's post.)
            const todayAtTime = new Date(now);
            todayAtTime.setHours(hour, minute, 0, 0);
            if (todayAtTime.getTime() <= now.getTime()) daysUntilTarget = 7;
          }
          scheduledDate.setDate(scheduledDate.getDate() + daysUntilTarget);
          scheduledDate.setHours(hour, minute, 0, 0);

          // Pick the visual. A custom image library wins (free, instant);
          // otherwise we kick off a Graphiste GPT poster job further below.
          const customImages: string[] = profile.use_custom_images && Array.isArray(profile.custom_image_urls)
            ? profile.custom_image_urls.filter((u: unknown): u is string => typeof u === "string" && !!u)
            : [];
          const customImage = customImages.length
            ? customImages[Math.floor(Math.random() * customImages.length)]
            : null;

          const { data: inserted, error: insertError } = await supabase
            .from("posts")
            .insert({
              user_id: profile.id,
              title:
                contentCategory === "promo"
                  ? "Post promotionnel"
                  : contentCategory === "research"
                    ? "Actualité et recherche"
                    : "Conseil et valeur",
              content: generatedContent,
              content_category: contentCategory,
              platforms,
              // When auto_publish is on, mark as validated so the publisher
              // can pick them up; the user has pre-approved the workflow.
              status: "validated",
              week_number: weekNumber,
              scheduled_for: scheduledDate.toISOString(),
              image_url: customImage,
            })
            .select("id")
            .single();

          if (insertError || !inserted) {
            console.error(`Insert error for ${profile.id}:`, insertError);
            continue;
          }
          generated += 1;

          // No custom image → start an async Graphiste GPT poster. The job
          // finishes within minutes; publish-post resumes it and attaches the
          // poster before the post (scheduled days from now) is published, so
          // image-only networks like Instagram work. Best-effort: a failure
          // here just leaves the post text-only.
          if (!customImage && Deno.env.get("GRAPHISTE_GPT_API_KEY") && Date.now() < posterDeadline) {
            try {
              const poster = await startPosterJob({
                postContent: generatedContent,
                contentCategory,
                sector,
                description,
                companyName,
                primary: profile.brand_primary_color || "#8B5CF6",
                secondary: profile.brand_secondary_color || "#3B82F6",
                accent: profile.brand_accent_color || "#F59E0B",
                logoUrl: profile.logo_url || null,
                platforms,
              });
              if (poster.imageUrl) {
                // Fast path: a finished poster came back immediately.
                let finalUrl = poster.imageUrl;
                try {
                  finalUrl = await rehostToUserAssets(supabase, poster.imageUrl, profile.id);
                } catch (rehostErr) {
                  console.error(`Poster rehost failed for ${profile.id}:`, rehostErr);
                }
                await supabase.from("posts")
                  .update({ image_url: finalUrl, image_status: "done" })
                  .eq("id", inserted.id);
              } else if (poster.status === "processing" && (poster.jobId || poster.statusUrl)) {
                await supabase.from("posts")
                  .update({
                    image_job_id: poster.jobId,
                    image_status_url: poster.statusUrl,
                    image_status: "processing",
                  })
                  .eq("id", inserted.id);
              } else {
                console.error(`Poster kick failed for ${profile.id}:`, poster.error);
              }
            } catch (posterErr) {
              console.error(`Poster job error for ${profile.id}:`, posterErr);
            }
          }
        }

        results.push({ userId: profile.id, postsGenerated: generated });
      } catch (userError) {
        console.error(`Error processing user ${profile.id}:`, userError);
        results.push({ userId: profile.id, error: String(userError), success: false });
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in auto-generate-weekly:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
