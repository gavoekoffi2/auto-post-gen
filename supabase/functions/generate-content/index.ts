// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const allowed =
    allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : allowedOrigins[0] === "*" ? "*" : allowedOrigins[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

// Per-user rate limit: how many AI generations are allowed per rolling window.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 20; // 20 generations / hour / user
const MAX_PAYLOAD_BYTES = 64 * 1024;

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

  // Reject oversized payloads early.
  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return new Response(
      JSON.stringify({ error: "Payload too large" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Authenticate the caller.
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
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

    // Enforce rate limit.
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

    const postTypes = ["value", "value", "value", "promo"] as const;
    const postType = postTypes[Math.floor(Math.random() * postTypes.length)];

    const companyName =
      userPreferences?.company_name?.trim() ||
      userPreferences?.description?.split(" ").slice(0, 3).join(" ") ||
      "notre entreprise";

    const peopleType = userPreferences?.image_people_type || "african";
    const peopleDescription =
      peopleType === "african"
        ? "des personnes africaines/noires ultra-réalistes"
        : "des personnes caucasiennes/blanches ultra-réalistes";

    const sector = userPreferences?.sector || "Business";
    const tone = userPreferences?.tone || "Professionnel";
    const contentTypes =
      userPreferences?.contentTypes ||
      userPreferences?.content_types ||
      ["mixed"];
    const styleExample =
      userPreferences?.styleExample || userPreferences?.style_example || "";

    const systemPrompt = `Tu es un expert en création de contenu pour les réseaux sociaux, spécialisé dans le secteur: ${sector}.

PROFIL DU CLIENT:
Nom de l'entreprise: ${companyName}
Secteur d'activité: ${sector}
Type de contenu: ${contentTypes.join(", ")}
Tonalité souhaitée: ${tone}
${styleExample ? `Style de contenu préféré: ${styleExample}` : ""}

TYPE DE POST À GÉNÉRER: ${postType === "value" ? "CONTENU DE VALEUR (conseil, astuce, expertise)" : "POST PROMOTIONNEL (présentation services/produits)"}

${
  postType === "value"
    ? `INSTRUCTIONS POUR CONTENU DE VALEUR:
- Partage une ASTUCE CONCRÈTE ou un CONSEIL PRATIQUE dans le domaine: ${sector}
- Positionne ${companyName} comme EXPERT du secteur
- Apporte une VRAIE VALEUR au lecteur
- Mentionne ${companyName} subtilement en fin de post
- NE FAIS PAS de promotion directe`
    : `INSTRUCTIONS POUR POST PROMOTIONNEL:
- Présente les services/produits de ${companyName} de manière engageante
- Mets en avant les bénéfices pour le client
- Inclus un appel à l'action clair`
}

RÈGLES CRITIQUES:
- Génère un post UNIQUE et ORIGINAL
- Contenu 100% en FRANÇAIS
- Utilise 2-4 émojis pertinents
- Respecte la tonalité: ${tone}
- ÉCRIS DIRECTEMENT "${companyName}" dans le post, JAMAIS entre crochets
- Structure COURTE: paragraphes de 1-2 lignes max
- Longueur idéale: 60-100 mots
- Termine par une question engageante
${styleExample ? `- Inspire-toi du style fourni` : ""}`;

    const textResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt || "Génère un post pertinent pour mon audience" },
        ],
      }),
    });

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

    let imageUrl: string | null = null;

    if (
      userPreferences?.use_custom_images &&
      Array.isArray(userPreferences?.custom_image_urls) &&
      userPreferences.custom_image_urls.length > 0
    ) {
      const idx = Math.floor(Math.random() * userPreferences.custom_image_urls.length);
      imageUrl = userPreferences.custom_image_urls[idx];
    } else {
      const imagePrompt = `Crée une image ultra-réaliste et professionnelle pour ce post: "${generatedContent.substring(0, 150)}..."

INSTRUCTIONS CRITIQUES:
- Inclure ${peopleDescription} dans l'image (personnages réalistes, expressions naturelles)
- Les personnes doivent être en situation professionnelle liée au contexte du post
- Image 100% visuelle SANS TEXTE (aucun mot, lettre ou chiffre)
- Style photo-réaliste, moderne et professionnel
- Éclairage naturel de haute qualité
- Couleurs vibrantes et attrayantes
- Format adapté pour réseaux sociaux (carré ou portrait)`;

      try {
        const imageResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-3-pro-image-preview",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: imagePrompt }],
              },
            ],
            modalities: ["image", "text"],
          }),
        });

        if (imageResponse.ok) {
          const imageData = await imageResponse.json();
          imageUrl =
            imageData?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
            imageData?.choices?.[0]?.message?.image_url?.url ||
            null;
        } else {
          console.error("Primary image model failed:", imageResponse.status);
        }

        // If the gateway returned a base64 data URL, transcode it to a
        // file in user-assets so the DB never holds megabytes of base64
        // and so downstream publishing (Instagram, LinkedIn) can fetch
        // a stable URL.
        if (imageUrl && imageUrl.startsWith("data:")) {
          try {
            const commaIdx = imageUrl.indexOf(",");
            const meta = imageUrl.slice(5, commaIdx);
            const payload = imageUrl.slice(commaIdx + 1);
            const contentType = (meta.split(";")[0] || "image/png").trim();
            const isBase64 = meta.includes(";base64");
            let bytes: Uint8Array;
            if (isBase64) {
              const bin = atob(payload);
              bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            } else {
              bytes = new TextEncoder().encode(decodeURIComponent(payload));
            }
            const ext = (contentType.split("/")[1] || "png").split(";")[0];
            const path = `${userId}/ai-${Date.now()}.${ext}`;
            const { error: upErr } = await supabase.storage
              .from("user-assets")
              .upload(path, bytes, { contentType, upsert: true });
            if (upErr) {
              console.error("Failed to rehost data URL:", upErr);
            } else {
              const { data } = supabase.storage.from("user-assets").getPublicUrl(path);
              imageUrl = data.publicUrl;
            }
          } catch (rehostErr) {
            console.error("data URL rehost threw:", rehostErr);
          }
        }
      } catch (imgError) {
        console.error("Image generation threw:", imgError);
      }
    }

    await supabase.from("generation_usage").insert({
      user_id: userId,
      function_name: "generate-content",
      status: "success",
    });

    return new Response(
      JSON.stringify({ content: generatedContent, imageUrl }),
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
