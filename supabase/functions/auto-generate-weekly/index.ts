// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { chatText, getOpenRouterKey, getTextModel } from "../_shared/ai.ts";

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

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Authorize the cron caller via a shared secret (set CRON_SECRET in Supabase).
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (expectedSecret) {
    const provided =
      req.headers.get("x-cron-secret") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== expectedSecret) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
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

        let generated = 0;

        for (let i = 0; i < postsToGenerate; i++) {
          const contentPrompt = `Tu es un expert en création de contenu pour les réseaux sociaux.

Génère un post engageant en français pour une entreprise avec ces caractéristiques:
- Secteur: ${profile.sector || "Business"}
- Ton: ${profile.tone || "Professionnel"}
- Description: ${profile.description || "Entreprise innovante"}
- Nom: ${profile.company_name || "Notre entreprise"}

Le post doit:
- Être en français uniquement
- Faire 60-100 mots maximum
- Inclure 2-3 émojis pertinents
- Apporter de la valeur (conseil, astuce, information)
- Être engageant et professionnel

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

          const targetDay = preferredDays[i % preferredDays.length];
          const targetDayNumber = DAY_MAPPING[targetDay] ?? 1;

          const scheduledDate = new Date(now);
          const currentDay = scheduledDate.getDay();
          const daysUntilTarget = ((targetDayNumber - currentDay + 7) % 7) || 7;
          scheduledDate.setDate(scheduledDate.getDate() + daysUntilTarget);
          scheduledDate.setHours(10, 0, 0, 0);

          const { error: insertError } = await supabase
            .from("posts")
            .insert({
              user_id: profile.id,
              title: "Contenu automatique",
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
