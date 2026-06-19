// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { chatText, getOpenRouterKey, getTextModel } from "../_shared/ai.ts";
import { buildInspirationBlock, researchInspiration } from "../_shared/research.ts";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const allowed = allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin": allowed && origin ? origin : (allowedOrigins[0] === "*" ? "*" : allowedOrigins[0]),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

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
        const weekNumber = isoWeekNumber(now);

        const { data: existingPosts } = await supabase
          .from("posts")
          .select("id")
          .eq("user_id", profile.id)
          .eq("week_number", weekNumber);

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

        // How many of this run's posts orient toward the company's service
        // (promo). The rest are pure value (no promotion). Clamp to what we
        // actually generate now so it never exceeds the weekly frequency.
        const promoThisRun = Math.min(
          Math.max(0, profile.promo_posts_per_week ?? 1),
          postsToGenerate,
        );

        // Research the business ONCE per user and reuse the inspiration for
        // every post generated this week. This grounds automatic posts in
        // real, current, sector-specific facts (the same enrichment the
        // manual generator uses) while keeping the cron fast.
        const companyName = profile.company_name || "notre entreprise";
        const sector = profile.sector || "Business";
        const description = profile.description || "";
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
          const isPromo = i < promoThisRun;
          const avoidBlock = generatedThisRun.length
            ? `\nNE répète NI le sujet NI l'accroche de ces posts déjà générés cette semaine:\n${
                generatedThisRun.map((c, k) => `${k + 1}. ${c.slice(0, 150)}`).join("\n")
              }\n`
            : "";

          // Most posts are pure value (no promotion); a small, user-chosen
          // number are oriented toward the company's service.
          const contentPrompt = isPromo
            ? `Tu es un expert en marketing pour les réseaux sociaux, spécialisé dans le métier décrit ci-dessous. Reste STRICTEMENT dans ce domaine d'activité.

PROFIL DU CLIENT:
- Nom de l'entreprise: ${companyName}
- Secteur: ${sector}
${description ? `- Description de l'activité: ${description}` : ""}
- Ton: ${profile.tone || "Professionnel"}
${inspirationBlock}
OBJECTIF DE CE POST: présenter ce que propose ${companyName} et donner envie de faire appel à ses services.

RÈGLES:
- 100% en français
- 60-100 mots
- 2-3 émojis pertinents
- Commence par un bénéfice concret pour le client (jamais par "Nous sommes...")
- Présente clairement le service ou la valeur que ${companyName} apporte, sans promesses irréalistes
- Écris "${companyName}" tel quel, jamais entre crochets ni en placeholder
- Termine par un appel à l'action clair et naturel (contacter, écrire, réserver…)
${avoidBlock}
Génère uniquement le texte du post, sans titre ni explication.`
            : `Tu es un expert en création de contenu pour les réseaux sociaux, spécialisé dans le métier décrit ci-dessous. Reste STRICTEMENT dans ce domaine d'activité, ne généralise pas vers d'autres sujets.

PROFIL DU CLIENT:
- Secteur: ${sector}
${description ? `- Description de l'activité: ${description}` : ""}
- Ton: ${profile.tone || "Professionnel"}

ANGLE IMPOSÉ POUR CE POST: ${AUTO_ANGLES[(i + weekNumber) % AUTO_ANGLES.length]}
${inspirationBlock}
RÈGLES:
- 100% en français
- 60-100 mots
- 2-3 émojis pertinents
- Apporte une valeur CONCRÈTE et SPÉCIFIQUE à ce métier (un conseil, un chiffre ou un fait qu'un vrai connaisseur donnerait) — surtout pas du générique applicable à n'importe quelle entreprise
- Ce post sert à AIDER l'audience, pas à promouvoir l'entreprise : aucune promotion, aucun prix, aucune offre. Tu peux mentionner "${companyName}" une seule fois maximum, naturellement, et uniquement si c'est pertinent.
- Termine par une question engageante
${avoidBlock}
Génère uniquement le texte du post, sans titre ni explication.`;

          let generatedContent = "";
          try {
            generatedContent = await chatText({
              model: getTextModel(),
              messages: [{ role: "user", content: contentPrompt }],
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
          // Track for intra-run de-duplication.
          generatedThisRun.push(generatedContent.trim());

          const targetDay = preferredDays[i % preferredDays.length];
          const targetDayNumber = DAY_MAPPING[targetDay] ?? 1;

          const scheduledDate = new Date(now);
          const currentDay = scheduledDate.getDay();
          const daysUntilTarget = ((targetDayNumber - currentDay + 7) % 7) || 7;
          scheduledDate.setDate(scheduledDate.getDate() + daysUntilTarget);
          scheduledDate.setHours(hour, minute, 0, 0);

          const { error: insertError } = await supabase
            .from("posts")
            .insert({
              user_id: profile.id,
              title: isPromo ? "Post promotionnel" : "Contenu automatique",
              content: generatedContent,
              platforms,
              // When auto_publish is on, mark as validated so the publisher
              // can pick them up; the user has pre-approved the workflow.
              status: "validated",
              week_number: weekNumber,
              scheduled_for: scheduledDate.toISOString(),
            });

          if (insertError) {
            console.error(`Insert error for ${profile.id}:`, insertError);
          } else {
            generated += 1;
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
