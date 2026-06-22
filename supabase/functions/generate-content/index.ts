// deno-lint-ignore-file no-explicit-any
//
// generate-content: text-only generation via OpenRouter. Image is
// generated separately by the `generate-image` function so users see
// the text instantly and the image is attached asynchronously.
//
// Quality safeguards baked in:
//   - The last 20 posts of the user are passed back to the LLM with
//     explicit instruction to avoid repetition.
//   - A pool of 12 post structures is randomised per call so the AI
//     can't fall into a single template.
//   - If TAVILY_API_KEY or BRAVE_SEARCH_API_KEY is configured, the
//     function does a quick web search on the user's sector and feeds
//     the top 3 results into the prompt as inspiration. This is
//     fail-soft: any search error is logged and ignored.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { AIQuotaError, chatCompletion, getOpenRouterKey, getTextModel } from "../_shared/ai.ts";
import { buildInspirationBlock, researchInspiration } from "../_shared/research.ts";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const wildcard = allowedOrigins.includes("*");
  const allowed = wildcard || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : wildcard ? "*" : allowedOrigins[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

// Per-user rate limit
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
// Soft monthly cap per user (cost control for the free beta).
const MONTHLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MONTHLY_LIMIT_MAX = 200;
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Pool of post structures. One is picked at random per generation to
// prevent the AI from settling into a single template across calls.
const POST_ANGLES = [
  { name: "astuce_pratique", brief: "Astuce concrète et applicable immédiatement" },
  { name: "erreur_courante", brief: "Erreur courante à éviter dans le secteur" },
  { name: "statistique_choc", brief: "Statistique surprenante avec interprétation" },
  { name: "histoire_courte", brief: "Mini-histoire ou anecdote inspirante" },
  { name: "question_provocante", brief: "Question qui remet en cause une idée reçue" },
  { name: "checklist", brief: "Mini-checklist en 3-5 points" },
  { name: "comparaison", brief: "Avant/Après ou A vs B percutant" },
  { name: "tendance_actu", brief: "Tendance ou actualité récente du secteur" },
  { name: "experience_perso", brief: "Leçon tirée d'une expérience vécue" },
  { name: "mythe_realite", brief: "Démolir un mythe répandu" },
  { name: "outil_methode", brief: "Présenter un outil ou méthode utile" },
  { name: "vision_futur", brief: "Vision sur l'évolution du secteur" },
];

const POST_TYPES = ["value", "value", "value", "value", "promo"] as const; // 80% value, 20% promo

interface UserPreferences {
  sector?: string;
  contentTypes?: string[];
  content_types?: string[];
  tone?: string;
  styleExample?: string;
  style_example?: string;
  style_examples?: Array<{ label?: string; content: string }>;
  company_name?: string;
  description?: string;
  image_people_type?: string;
  use_custom_images?: boolean;
  custom_image_urls?: string[];
}

function cleanSentence(value: string, fallback: string): string {
  return (value || fallback)
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220) || fallback;
}

// Clean, natural fallback used only when the AI text provider is unavailable.
// No "erreur" phrasing, no lowercased free-text, no placeholders — it must read
// like a real, publishable post. Value posts keep the company mention subtle;
// only promo posts push the service. One variant is picked at random so repeated
// fallbacks don't look identical.
function buildFallbackContent(params: {
  companyName: string;
  sector: string;
  description: string;
  postType: "value" | "promo";
}): string {
  const company = cleanSentence(params.companyName, "Notre entreprise");
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

  if (params.postType === "promo") {
    return pick([
      `Vous cherchez un partenaire fiable et professionnel ? 🤝\n\n${company} vous accompagne avec une approche claire, adaptée à vos objectifs, et des résultats concrets — sans jargon inutile.\n\nÉcrivez-nous pour en parler, on vous répond vite. 📩`,
      `Passez à l'action avec ${company}. 🚀\n\nDes solutions simples, un accompagnement sérieux et un suivi à chaque étape pour atteindre vos objectifs sereinement.\n\nContactez-nous dès aujourd'hui pour démarrer.`,
      `Et si cette semaine était la bonne pour avancer ? ✨\n\n${company} met son savoir-faire au service de votre projet, avec une méthode claire et des engagements tenus.\n\nParlons-en : envoyez-nous un message. 📩`,
    ]);
  }

  return pick([
    `💡 La régularité bat l'intensité : une seule action vraiment utile par semaine vaut mieux que dix idées jamais mises en œuvre.\n\nLe réflexe que nous recommandons : choisir une priorité claire, mesurer son impact, puis ajuster.\n\nQuelle est votre priorité cette semaine ?`,
    `🎯 Avant d'ajouter de nouveaux outils, clarifiez l'objectif : à quoi ressemble un bon résultat, concrètement ?\n\nUne fois la cible définie, les bonnes décisions deviennent beaucoup plus simples à prendre.\n\nVotre objectif numéro 1 ce mois-ci, c'est quoi ?`,
    `✅ Un principe qui change tout : se concentrer sur ce qui apporte le plus de résultat, et simplifier le reste.\n\nC'est souvent en faisant moins, mais mieux, qu'on progresse le plus vite.\n\nSur quoi pourriez-vous gagner du temps dès cette semaine ?`,
  ]);
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return new Response(
      JSON.stringify({ error: "Payload too large" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) {
    return new Response(
      JSON.stringify({ error: "Not authenticated" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({ error: "Server misconfigured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return new Response(
      JSON.stringify({ error: "Invalid token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const userId = userData.user.id;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 2000) : "";
    const userPreferences: UserPreferences = body.userPreferences || {};

    // Soft monthly cap (cost control for the free beta), checked before the
    // hourly atomic reservation below.
    const monthSince = new Date(Date.now() - MONTHLY_WINDOW_MS).toISOString();
    const { count: monthCount } = await supabase
      .from("generation_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("function_name", "generate-content")
      .gte("created_at", monthSince);
    if ((monthCount ?? 0) >= MONTHLY_LIMIT_MAX) {
      return new Response(
        JSON.stringify({ error: `Limite mensuelle de ${MONTHLY_LIMIT_MAX} générations atteinte.` }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Rate limit — atomic reservation via consume_generation_quota. This closes
    // the burst/parallel bypass the old "count then later insert" check had (a
    // user could fire many requests in parallel and all passed the count).
    const limitResponse = () =>
      new Response(
        JSON.stringify({
          error: `Limite de ${RATE_LIMIT_MAX} générations par heure atteinte. Réessayez plus tard.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    const { data: quotaOk, error: quotaErr } = await supabase.rpc("consume_generation_quota", {
      p_user: userId,
      p_function: "generate-content",
      p_max: RATE_LIMIT_MAX,
      p_window_seconds: Math.floor(RATE_LIMIT_WINDOW_MS / 1000),
    });
    if (quotaErr) {
      // RPC unavailable (e.g. migration not yet applied): degrade to the legacy
      // non-atomic count check + insert rather than failing the request.
      console.error("consume_generation_quota failed, using fallback check:", quotaErr.message);
      const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
      const { count } = await supabase
        .from("generation_usage")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("function_name", "generate-content")
        .gte("created_at", since);
      if ((count ?? 0) >= RATE_LIMIT_MAX) return limitResponse();
      await supabase.from("generation_usage").insert({
        user_id: userId,
        function_name: "generate-content",
        status: "reserved",
      });
    } else if (quotaOk === false) {
      return limitResponse();
    }

    const postType = POST_TYPES[Math.floor(Math.random() * POST_TYPES.length)];
    const angle = POST_ANGLES[Math.floor(Math.random() * POST_ANGLES.length)];

    const companyName =
      userPreferences?.company_name?.trim() ||
      userPreferences?.description?.split(" ").slice(0, 3).join(" ") ||
      "notre entreprise";

    const sector = userPreferences?.sector || "Business";
    const tone = userPreferences?.tone || "Professionnel";
    const contentTypes =
      userPreferences?.contentTypes ||
      userPreferences?.content_types ||
      ["mixed"];
    const styleExample =
      userPreferences?.styleExample || userPreferences?.style_example || "";

    // Style examples library: up to 3 picked at random per call, fed to
    // the LLM as concrete reference posts to imitate in tone/rhythm/
    // structure (but never copy verbatim).
    const allStyleExamples = (userPreferences?.style_examples || [])
      .filter((s) => s && typeof s.content === "string" && s.content.trim().length > 20);
    const shuffledStyles = [...allStyleExamples].sort(() => Math.random() - 0.5).slice(0, 3);
    const styleLibraryBlock = shuffledStyles.length
      ? `\nBIBLIOTHÈQUE DE STYLES À IMITER (ton, rythme, structure — JAMAIS le contenu):\n${
          shuffledStyles
            .map(
              (ex, i) =>
                `--- Exemple ${i + 1}${ex.label ? ` (${ex.label})` : ""} ---\n${ex.content.slice(0, 800)}`,
            )
            .join("\n")
        }\n--- Fin des exemples ---\n`
      : "";

    // Pull the last 20 posts of this user so the model knows what to
    // avoid repeating.
    const { data: recentPosts } = await supabase
      .from("posts")
      .select("content")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);

    const recentList = (recentPosts || [])
      .map((p: { content: string }, i: number) => `${i + 1}. ${p.content.slice(0, 200)}`)
      .join("\n");

    // Web inspiration with targeted queries built from the user's own
    // description and company name (much more relevant than just the
    // broad sector label).
    const description = userPreferences?.description || "";
    const webResults = await researchInspiration(sector, companyName, description);

    // The LLM gets the results AND explicit instructions on how to
    // handle them: filter for relevance, ignore irrelevant ones, and
    // if nothing is relevant fall back to its own expertise about
    // this specific business.
    const inspiration = buildInspirationBlock(webResults, description.slice(0, 120) || sector);

    const systemPrompt = `Tu es un expert en création de contenu pour les réseaux sociaux, spécialisé dans le métier décrit ci-dessous. Tu DOIS rester strictement dans le domaine d'activité du client — pas généraliser, pas dériver vers d'autres sujets.

═══════════════════════════════════════════════════════════
PROFIL PRÉCIS DU CLIENT (À RESPECTER EN TOUT TEMPS):
═══════════════════════════════════════════════════════════
Nom de l'entreprise: ${companyName}
Secteur général: ${sector}
${description ? `Description détaillée de l'activité: ${description}` : ""}
Types de contenu privilégiés: ${contentTypes.join(", ")}
Tonalité: ${tone}
${styleExample ? `Style préféré: ${styleExample}` : ""}
${styleLibraryBlock}
═══════════════════════════════════════════════════════════

RÈGLE D'OR — PERTINENCE MÉTIER:
Chaque post DOIT être directement utile à un lecteur qui s'intéresse à "${description.slice(0, 150) || sector}".
Si le post pourrait s'appliquer à n'importe quelle entreprise du secteur ${sector}, il est TROP GÉNÉRIQUE — recommence en y mettant un détail propre au métier décrit ci-dessus.

TYPE DE POST: ${postType === "value" ? "VALEUR (expertise, conseil)" : "PROMOTIONNEL (services/produits)"}
ANGLE IMPOSÉ: ${angle.name} — ${angle.brief}

${postType === "value"
  ? `INSTRUCTIONS CONTENU DE VALEUR:
- Suis STRICTEMENT l'angle "${angle.name}": ${angle.brief}
- Apporte une VRAIE valeur concrète et SPÉCIFIQUE au métier de ${companyName}
- Donne un conseil/info que SEUL un connaisseur de ce métier précis pourrait donner
- Positionne ${companyName} comme expert sans promotion directe
- Mentionne ${companyName} subtilement en fin (1 phrase max)`
  : `INSTRUCTIONS POST PROMOTIONNEL:
- Présente concrètement les services/produits de ${companyName} (basé sur la description)
- Mets en avant un bénéfice client précis lié à cette activité
- Termine par un appel à l'action clair`}
${inspiration}
RÈGLES CRITIQUES:
- Génère un post UNIQUE et ORIGINAL
- 100% en FRANÇAIS
- 2-4 émojis pertinents (PAS en début ni en fin de phrase clé)
- Tonalité: ${tone}
- ÉCRIS "${companyName}" tel quel, JAMAIS entre crochets ni en placeholder
- Paragraphes courts (1-2 lignes)
- Longueur: 60-100 mots
- Termine par une question engageante OU un appel à l'action
${styleExample ? "- Inspire-toi du style fourni sans le copier" : ""}

POSTS DÉJÀ GÉNÉRÉS POUR CE CLIENT (NE répète AUCUN sujet, AUCUN angle, AUCUNE accroche):
${recentList || "(aucun pour l'instant)"}

Réponds UNIQUEMENT avec le texte du post, sans titre ni explication, sans guillemets autour.`;

    const fallbackContent = (reason: string) => ({
      content: buildFallbackContent({ companyName, sector, description, postType }),
      angle: angle.name,
      postType,
      usedWebInspiration: webResults.length > 0,
      fallback: true,
      provider: "local-content-fallback",
      warning: reason,
    });

    let generatedContent = "";
    let fallbackReason = "";
    try {
      if (!getOpenRouterKey()) {
        throw new Error("OPENROUTER_API_KEY missing");
      }
      const textResponse = await chatCompletion({
        model: getTextModel(),
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: prompt ||
              `Génère un post pertinent avec l'angle "${angle.name}" pour mon audience.`,
          },
        ],
        temperature: 0.95,
        top_p: 0.95,
      });
      if (!textResponse.ok) {
        const detail = (await textResponse.text()).slice(0, 240);
        throw new Error(`OpenRouter ${textResponse.status}: ${detail}`);
      }
      const textData = await textResponse.json();
      generatedContent = textData?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      if (err instanceof AIQuotaError) {
        fallbackReason = err.code === "rate" ? "AI rate limit reached" : "AI credit exhausted";
      } else {
        fallbackReason = err instanceof Error ? err.message : String(err);
      }
      console.error("generate-content AI fallback:", fallbackReason);
    }

    if (!generatedContent) {
      const payload = fallbackContent(fallbackReason || "AI returned empty content");
      return new Response(
        JSON.stringify(payload),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        content: generatedContent,
        angle: angle.name,
        postType,
        usedWebInspiration: webResults.length > 0,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in generate-content:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
