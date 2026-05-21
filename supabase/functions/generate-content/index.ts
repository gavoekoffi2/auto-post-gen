// deno-lint-ignore-file no-explicit-any
//
// generate-content: text-only generation. Image is generated separately
// by the `generate-image` function so users see the text instantly and
// the image is attached asynchronously.
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

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
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
  company_name?: string;
  description?: string;
  image_people_type?: string;
  use_custom_images?: boolean;
  custom_image_urls?: string[];
}

interface WebResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}

// User-Agent that identifies us politely. Required by several free
// services (Wikipedia, some news endpoints reject empty UAs).
const HTTP_UA = "ProSocialAI/1.0 (+https://prosocial.ai)";

// Strip HTML tags and decode the most common entities so RSS/HTML
// snippets are clean enough to feed into the LLM.
function htmlToText(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? htmlToText(m[1]) : "";
}

// --- FREE SOURCES (no API key needed) ----------------------------

// Google News RSS: officially provided by Google, no auth, fresh news
// filtered by language/region. Best free source for sector trends.
async function googleNewsRssSearch(
  query: string,
  lang = "fr",
  region = "FR",
): Promise<WebResult[]> {
  try {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", lang);
    url.searchParams.set("gl", region);
    url.searchParams.set("ceid", `${region}:${lang}`);
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": HTTP_UA, Accept: "application/rss+xml" },
    });
    if (!resp.ok) {
      console.error("Google News RSS:", resp.status);
      return [];
    }
    const xml = await resp.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.slice(0, 5).map((block) => ({
      title: pickTag(block, "title"),
      snippet: pickTag(block, "description").slice(0, 400),
      url: pickTag(block, "link"),
      source: "google-news",
    }));
  } catch (err) {
    console.error("Google News RSS threw:", err);
    return [];
  }
}

// Wikipedia REST API: free, no key, no rate-limit, reliable from any
// IP including datacenter IPs (unlike DuckDuckGo). Great for the
// foundational context of any topic. Multilingual via subdomain.
async function wikipediaSearch(query: string, lang = "fr"): Promise<WebResult[]> {
  try {
    // 1. opensearch for matching article titles
    const searchUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    searchUrl.searchParams.set("action", "opensearch");
    searchUrl.searchParams.set("search", query);
    searchUrl.searchParams.set("limit", "5");
    searchUrl.searchParams.set("format", "json");
    const searchResp = await fetch(searchUrl.toString(), {
      headers: { "User-Agent": HTTP_UA },
    });
    if (!searchResp.ok) {
      console.error("Wikipedia search:", searchResp.status);
      return [];
    }
    const data = await searchResp.json();
    // opensearch returns [query, [titles], [descriptions], [urls]]
    const titles: string[] = data[1] || [];
    const descriptions: string[] = data[2] || [];
    const urls: string[] = data[3] || [];

    const results: WebResult[] = [];
    for (let i = 0; i < titles.length && results.length < 4; i++) {
      // Fetch the summary for richer snippet (descriptions array is
      // often empty in opensearch).
      try {
        const sumUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titles[i])}`;
        const sumResp = await fetch(sumUrl, { headers: { "User-Agent": HTTP_UA } });
        let snippet = descriptions[i] || "";
        if (sumResp.ok) {
          const sumData = await sumResp.json();
          snippet = sumData.extract || snippet;
        }
        results.push({
          title: titles[i],
          snippet: snippet.slice(0, 400),
          url: urls[i] || "",
          source: "wikipedia",
        });
      } catch (_) {
        // Skip this article on error.
      }
    }
    return results;
  } catch (err) {
    console.error("Wikipedia threw:", err);
    return [];
  }
}

// DuckDuckGo HTML — best-effort additional source. DDG aggressively
// blocks datacenter IPs (HTTP 503) so we don't rely on it but try it
// anyway; if it works on a given runtime, we get free extra results.
async function duckduckgoHtmlSearch(query: string): Promise<WebResult[]> {
  try {
    const resp = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": HTTP_UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query }).toString(),
    });
    if (!resp.ok) return []; // silent failure; DDG often rejects from datacenter IPs
    const html = await resp.text();
    const results: WebResult[] = [];
    const blocks = html.match(/<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g) || [];
    for (const block of blocks.slice(0, 8)) {
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i);
      if (titleMatch) {
        results.push({
          title: htmlToText(titleMatch[1]),
          snippet: htmlToText(snippetMatch?.[1] || "").slice(0, 400),
          url: urlMatch?.[1] || "",
          source: "duckduckgo",
        });
      }
      if (results.length >= 4) break;
    }
    return results;
  } catch (_) {
    return [];
  }
}

// --- PREMIUM SOURCES (API key, better quality) -------------------

async function tavilySearch(query: string): Promise<WebResult[]> {
  const apiKey = Deno.env.get("TAVILY_API_KEY");
  if (!apiKey) return [];
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: false,
      }),
    });
    if (!resp.ok) {
      console.error("Tavily error:", resp.status);
      return [];
    }
    const data = await resp.json();
    return (data.results || [])
      .slice(0, 5)
      .map((r: any) => ({
        title: String(r.title || "").slice(0, 200),
        snippet: String(r.content || "").slice(0, 400),
        url: String(r.url || ""),
        source: "tavily",
      }));
  } catch (err) {
    console.error("Tavily threw:", err);
    return [];
  }
}

async function braveSearch(query: string): Promise<WebResult[]> {
  const apiKey = Deno.env.get("BRAVE_SEARCH_API_KEY");
  if (!apiKey) return [];
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    const resp = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    if (!resp.ok) {
      console.error("Brave error:", resp.status);
      return [];
    }
    const data = await resp.json();
    const items = data?.web?.results || [];
    return items.slice(0, 5).map((r: any) => ({
      title: String(r.title || "").slice(0, 200),
      snippet: String(r.description || "").slice(0, 400),
      url: String(r.url || ""),
      source: "brave",
    }));
  } catch (err) {
    console.error("Brave threw:", err);
    return [];
  }
}

async function researchInspiration(
  sector: string,
  _companyName: string,
): Promise<WebResult[]> {
  const year = new Date().getFullYear();
  const queries = [
    `tendances ${sector} ${year}`,
    `actualité ${sector}`,
    `conseils ${sector}`,
  ];

  // Strategy: always try the free sources first. Google News RSS is
  // the most reliable (fresh news, multilingual). Wikipedia gives us
  // foundational context. DuckDuckGo is best-effort. Tavily/Brave are
  // optional upgrades. Results from all sources are merged so the
  // LLM gets the richest pool of inspiration possible.
  const results: WebResult[] = [];

  // 1. Google News RSS — fresh, multilingual, reliable
  for (const q of queries) {
    if (results.length >= 5) break;
    const news = await googleNewsRssSearch(q);
    for (const r of news) {
      if (results.length >= 5) break;
      results.push(r);
    }
  }

  // 2. Wikipedia — encyclopedic context, very reliable from any IP
  if (results.length < 4) {
    const wiki = await wikipediaSearch(sector);
    for (const r of wiki) {
      if (results.length >= 6) break;
      results.push(r);
    }
  }

  // 3. DuckDuckGo — best-effort additional source
  if (results.length < 4) {
    const ddg = await duckduckgoHtmlSearch(queries[0]);
    for (const r of ddg) {
      if (results.length >= 6) break;
      results.push(r);
    }
  }

  // Upgrade tier: Tavily / Brave. Only spent if their keys are
  // configured. We append rather than replace so we keep the breadth.
  if (Deno.env.get("TAVILY_API_KEY")) {
    const tav = await tavilySearch(queries[0]);
    for (const r of tav) {
      if (results.length >= 8) break;
      results.push(r);
    }
  }
  if (Deno.env.get("BRAVE_SEARCH_API_KEY") && results.length < 8) {
    const br = await braveSearch(queries[0]);
    for (const r of br) {
      if (results.length >= 8) break;
      results.push(r);
    }
  }

  return results;
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

    // Rate limit
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { count: usageCount } = await supabase
      .from("generation_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("function_name", "generate-content")
      .gte("created_at", since);

    if ((usageCount ?? 0) >= RATE_LIMIT_MAX) {
      return new Response(
        JSON.stringify({
          error: `Limite de ${RATE_LIMIT_MAX} générations par heure atteinte. Réessayez plus tard.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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

    // Optional web inspiration. Fails soft, never blocks generation.
    const webResults = await researchInspiration(sector, companyName);
    const inspiration = webResults.length
      ? `\nINSPIRATION RÉCENTE DU WEB (utilise comme matière brute, NE PAS recopier mot pour mot):\n${
          webResults
            .slice(0, 5)
            .map((r, i) => `${i + 1}. [${r.source}] ${r.title}${r.snippet ? " — " + r.snippet : ""}`)
            .join("\n")
        }\n`
      : "";

    const systemPrompt = `Tu es un expert en création de contenu pour les réseaux sociaux, spécialisé dans le secteur: ${sector}.

PROFIL DU CLIENT:
Nom de l'entreprise: ${companyName}
Secteur: ${sector}
Types de contenu privilégiés: ${contentTypes.join(", ")}
Tonalité: ${tone}
${styleExample ? `Style préféré: ${styleExample}` : ""}

TYPE DE POST: ${postType === "value" ? "VALEUR (expertise, conseil)" : "PROMOTIONNEL (services/produits)"}
ANGLE IMPOSÉ: ${angle.name} — ${angle.brief}

${postType === "value"
  ? `INSTRUCTIONS CONTENU DE VALEUR:
- Suis STRICTEMENT l'angle "${angle.name}": ${angle.brief}
- Apporte une VRAIE valeur concrète au lecteur du secteur ${sector}
- Positionne ${companyName} comme expert sans promotion directe
- Mentionne ${companyName} subtilement en fin (1 phrase max)`
  : `INSTRUCTIONS POST PROMOTIONNEL:
- Présente les services/produits de ${companyName} de manière engageante
- Mets en avant un bénéfice client concret
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

    const textResponse = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          // Higher temperature for more diversity across calls.
          temperature: 0.95,
          top_p: 0.95,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: prompt ||
                `Génère un post pertinent avec l'angle "${angle.name}" pour mon audience.`,
            },
          ],
        }),
      },
    );

    if (!textResponse.ok) {
      if (textResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de taux atteinte, réessayez plus tard." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (textResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: "Crédit insuffisant, veuillez recharger votre compte." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      console.error("AI Gateway text status:", textResponse.status);
      throw new Error("AI Gateway error");
    }

    const textData = await textResponse.json();
    const generatedContent =
      textData?.choices?.[0]?.message?.content?.trim() || "";

    if (!generatedContent) {
      throw new Error("AI returned empty content");
    }

    // Record success
    await supabase.from("generation_usage").insert({
      user_id: userId,
      function_name: "generate-content",
      status: "success",
    });

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
    await supabase
      .from("generation_usage")
      .insert({
        user_id: userId,
        function_name: "generate-content",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => {});
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
