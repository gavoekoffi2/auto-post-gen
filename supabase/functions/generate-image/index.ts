// deno-lint-ignore-file no-explicit-any
//
// generate-image: image-only generation. Split from generate-content so
// the frontend can show the text instantly (text gen is fast) and
// asynchronously fill in the image (image gen is slow). Also used as
// the "regenerate image" endpoint from the dashboard.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { generateImageUrl, getOpenRouterKey } from "../_shared/ai.ts";

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

const MAX_PAYLOAD_BYTES = 64 * 1024;

const GRAPHISTE_GPT_DEFAULT_URL =
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

function safeColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function fallbackSvgDataUrl(primary: string, secondary: string, accent: string, style: string): string {
  const p = safeColor(primary, "#8B5CF6");
  const s = safeColor(secondary, "#3B82F6");
  const a = safeColor(accent, "#F59E0B");
  const isMinimal = style === "minimalist" || style === "flat_design";
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p}"/>
      <stop offset="55%" stop-color="${s}"/>
      <stop offset="100%" stop-color="${a}"/>
    </linearGradient>
    <radialGradient id="glow" cx="65%" cy="35%" r="55%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.62"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="34"/>
    </filter>
  </defs>
  <rect width="1200" height="1200" fill="url(#bg)"/>
  <circle cx="790" cy="320" r="420" fill="url(#glow)"/>
  <circle cx="180" cy="980" r="330" fill="#000000" opacity="0.12" filter="url(#soft)"/>
  <path d="M180 760 C330 575 500 560 650 690 C805 825 965 820 1080 650 L1080 1080 L180 1080 Z" fill="#ffffff" opacity="${isMinimal ? "0.22" : "0.18"}"/>
  <path d="M80 260 C250 120 470 110 620 250 C760 380 900 405 1120 260" fill="none" stroke="#ffffff" stroke-width="36" stroke-linecap="round" opacity="0.28"/>
  <circle cx="355" cy="405" r="90" fill="#ffffff" opacity="0.22"/>
  <circle cx="905" cy="750" r="130" fill="#ffffff" opacity="0.16"/>
  <rect x="230" y="230" width="740" height="740" rx="96" fill="none" stroke="#ffffff" stroke-width="5" opacity="0.35"/>
</svg>`.trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function isImageUrl(value: unknown): value is string {
  return typeof value === "string" && (
    value.startsWith("data:image/") ||
    /^https?:\/\/\S+/i.test(value) ||
    value.startsWith("/reference-templates/")
  );
}

function absoluteGraphisteUrl(value: string): string {
  if (value.startsWith("/")) return `https://graphistegpt.pro${value}`;
  return value;
}

function extractGraphisteImageUrl(value: unknown, allowTemplateImage = false): string | null {
  if (!value) return null;
  if (isImageUrl(value)) return absoluteGraphisteUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractGraphisteImageUrl(item, allowTemplateImage);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const finalImage =
      extractGraphisteImageUrl(obj.image_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.imageUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.publicUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.download_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.output, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.result, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.images, allowTemplateImage);
    if (finalImage) return finalImage;
    if (allowTemplateImage) return extractGraphisteImageUrl(obj.template_used, true);
  }
  return null;
}

function graphisteDomain(sector: string, description: string): string {
  const haystack = `${sector} ${description}`.toLowerCase();
  if (/restaurant|food|cuisine|bar|burger|pizza|menu|boisson/.test(haystack)) return "restaurant";
  if (/église|eglise|church|pasteur|minist/.test(haystack)) return "church";
  if (/formation|cours|école|ecole|academy|coaching|webinar/.test(haystack)) return "formation";
  if (/event|événement|evenement|concert|conférence|conference|festival/.test(haystack)) return "event";
  if (/ecommerce|commerce|boutique|produit|shop|vente/.test(haystack)) return "ecommerce";
  if (/mode|fashion|vêtement|vetement|beauté|beaute/.test(haystack)) return "fashion";
  if (/immobilier|real.?estate|maison|terrain|appartement/.test(haystack)) return "realestate";
  if (/santé|sante|health|clinique|médical|medical|pharma/.test(haystack)) return "health";
  return "service";
}

async function tryGraphisteGptPoster(params: {
  postContent: string;
  sector: string;
  description: string;
  companyName: string;
  primary: string;
  secondary: string;
  accent: string;
}): Promise<{ imageUrl: string | null; warning: string | null }> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) return { imageUrl: null, warning: "GRAPHISTE_GPT_API_KEY not configured" };

  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const subject = `${params.companyName} — ${params.postContent}`.slice(0, 600);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        domain: graphisteDomain(params.sector, params.description),
        subject,
        mode: "quality",
        aspectRatio: "4:5",
        resolution: "1K",
        prompt:
          `Affiche professionnelle en français pour réseaux sociaux. Marque: ${params.companyName}. ` +
          `Couleurs: ${params.primary}, ${params.secondary}, ${params.accent}. Sujet: ${subject}`,
      }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) return { imageUrl: null, warning: `Graphiste GPT ${resp.status}: ${text.slice(0, 300)}` };
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { imageUrl: null, warning: `Graphiste GPT returned non-JSON: ${text.slice(0, 120)}` };
    }
    const imageUrl = extractGraphisteImageUrl(data, false);
    if (imageUrl) return { imageUrl, warning: null };
    return {
      imageUrl: null,
      warning: "Graphiste GPT did not return a final image URL yet; response only contains metadata/template data.",
    };
  } catch (err) {
    return { imageUrl: null, warning: `Graphiste GPT threw: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey || !getOpenRouterKey()) {
    return new Response(
      JSON.stringify({ error: "Server misconfigured (missing OPENROUTER_API_KEY?)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Authenticate
  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) {
    return new Response(
      JSON.stringify({ error: "Not authenticated" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return new Response(
      JSON.stringify({ error: "Invalid token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const userId = userData.user.id;

  try {
    const body = await req.json().catch(() => ({}));
    const postContent: string = (body?.postContent || "").toString().slice(0, 2000);
    const postId: string | null = body?.postId || null;

    if (!postContent) {
      return new Response(
        JSON.stringify({ error: "postContent is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Pull the user's brand preferences from their profile so every
    // image respects the same visual identity.
    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "image_people_type, image_style, brand_primary_color, brand_secondary_color, brand_accent_color, brand_font, sector, description, company_name",
      )
      .eq("id", userId)
      .maybeSingle();

    const peopleType = (body?.peopleType as string) || profile?.image_people_type || "african";
    const imageStyle: string = profile?.image_style || "photorealistic";
    const primary = profile?.brand_primary_color || "#8B5CF6";
    const secondary = profile?.brand_secondary_color || "#3B82F6";
    const accent = profile?.brand_accent_color || "#F59E0B";
    const font = profile?.brand_font || "Inter";
    const sector = profile?.sector || "";
    const description = profile?.description || "";

    const peopleDescription = peopleType === "african"
      ? "des personnes africaines/noires"
      : "des personnes caucasiennes/blanches";

    // Translate the image_style enum into a concrete artistic brief.
    const STYLE_BRIEFS: Record<string, string> = {
      photorealistic:
        "Style PHOTO ULTRA-RÉALISTE: photographie professionnelle, éclairage naturel cinématique, profondeur de champ, détails de peau et de matière réalistes, qualité magazine.",
      illustration:
        "Style ILLUSTRATION numérique soignée: rendu dessiné moderne, traits propres, palette de couleurs harmonieuse, ambiance chaleureuse, NE PAS ressembler à une photo.",
      minimalist:
        "Style MINIMALISTE et abstrait: composition épurée, beaucoup d'espace négatif, formes géométriques simples, 2-3 couleurs maximum, élégance sobre.",
      corporate:
        "Style CORPORATE professionnel sobre: ambiance bureau premium, lignes nettes, ton institutionnel, palette restreinte, sérieux et crédibilité.",
      flat_design:
        "Style FLAT DESIGN vectoriel: aplats de couleurs, formes géométriques, pas d'ombres réalistes, design vectoriel propre type illustration UI moderne.",
    };
    const styleBrief = STYLE_BRIEFS[imageStyle] || STYLE_BRIEFS.photorealistic;

    const includesPeople = imageStyle === "photorealistic" || imageStyle === "illustration";

    const imagePrompt = `Crée un visuel professionnel pour ce post sur les réseaux sociaux: "${postContent.substring(0, 200)}..."

CONTEXTE BUSINESS:
- Entreprise: ${profile?.company_name || "Entreprise"}
- Secteur: ${sector}
${description ? `- Activité: ${description.slice(0, 200)}` : ""}

STYLE VISUEL (À RESPECTER STRICTEMENT):
${styleBrief}

CHARTE GRAPHIQUE (IMPÉRATIF):
- Couleur principale dominante: ${primary}
- Couleur secondaire d'appui: ${secondary}
- Couleur d'accent (touche): ${accent}
- L'image doit visuellement évoquer ces 3 couleurs (en arrière-plan, accessoires, vêtements, éléments graphiques)
${font ? `- Si du texte doit apparaître, utilise une typographie type "${font}"` : ""}

${includesPeople
  ? `PERSONNAGES:
- Inclure ${peopleDescription} en situation professionnelle pertinente au secteur "${sector}"
- Expressions naturelles, attitudes engagées et crédibles
- Tenue cohérente avec le secteur`
  : `PAS DE PERSONNAGES — composition centrée sur des objets, formes ou métaphores visuelles liées au secteur.`}

RÈGLES CRITIQUES:
- AUCUN texte, mot, lettre ou chiffre visible dans l'image
- Format carré 1:1 ou portrait 4:5 (réseaux sociaux)
- Qualité finale haute, contraste maîtrisé
- Le visuel doit immédiatement évoquer l'univers de "${sector}"
- COHÉRENT avec la marque (les couleurs de la charte doivent être visibles)`;

    const graphiste = await tryGraphisteGptPoster({
      postContent,
      sector,
      description,
      companyName: profile?.company_name || "Entreprise",
      primary,
      secondary,
      accent,
    });
    if (graphiste.warning) console.warn("Graphiste GPT unavailable:", graphiste.warning);

    const { imageUrl: rawImageUrl, lastError } = graphiste.imageUrl
      ? { imageUrl: graphiste.imageUrl, lastError: null }
      : await generateImageUrl(imagePrompt);
    let imageUrl: string | null = rawImageUrl;

    let usedFallback = false;
    if (!imageUrl) {
      console.error("AI image generation failed, using branded fallback:", lastError);
      imageUrl = fallbackSvgDataUrl(primary, secondary, accent, imageStyle);
      usedFallback = true;
    }

    // Re-host to user-assets/ so the URL is permanent.
    if (!imageUrl.startsWith(supabaseUrl)) {
      try {
        let bytes: Uint8Array;
        let contentType = "image/png";
        if (imageUrl.startsWith("data:")) {
          const commaIdx = imageUrl.indexOf(",");
          const meta = imageUrl.slice(5, commaIdx);
          const payload = imageUrl.slice(commaIdx + 1);
          contentType = (meta.split(";")[0] || "image/png").trim();
          if (meta.includes(";base64")) {
            const bin = atob(payload);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else {
            bytes = new TextEncoder().encode(decodeURIComponent(payload));
          }
        } else {
          const fetched = await fetch(imageUrl);
          if (!fetched.ok) throw new Error(`Image fetch ${fetched.status}`);
          const ab = await fetched.arrayBuffer();
          bytes = new Uint8Array(ab);
          contentType = fetched.headers.get("content-type") || "image/png";
        }
        const ext = (contentType.split("/")[1] || "png").split(";")[0].replace(/[^a-z0-9]/gi, "") || "png";
        const path = `${userId}/ai-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("user-assets")
          .upload(path, bytes, { contentType, upsert: true });
        if (!upErr) {
          const { data } = supabase.storage.from("user-assets").getPublicUrl(path);
          imageUrl = data.publicUrl;
        }
      } catch (rehostErr) {
        console.error("rehost failed:", rehostErr);
        // Keep the original URL as best-effort fallback.
      }
    }

    // If a postId was given, attach the image directly so the dashboard
    // can rely on the row update instead of round-tripping the URL.
    if (postId) {
      const { error: updateErr } = await supabase
        .from("posts")
        .update({ image_url: imageUrl })
        .eq("id", postId)
        .eq("user_id", userId);
      if (updateErr) {
        console.error("Failed to attach image to post:", updateErr);
      }
    }

    return new Response(
      JSON.stringify({ imageUrl, fallback: usedFallback, warning: usedFallback ? lastError : undefined }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("generate-image error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
