// deno-lint-ignore-file no-explicit-any
//
// generate-image: image-only generation. Split from generate-content so
// the frontend can show the text instantly (text gen is fast) and
// asynchronously fill in the image (image gen is slow). Also used as
// the "regenerate image" endpoint from the dashboard.
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

const IMAGE_MODELS = [
  "google/gemini-3-pro-image-preview",
  "google/gemini-2.5-flash-image-preview",
  "google/gemini-2.5-flash",
];

const MAX_PAYLOAD_BYTES = 64 * 1024;

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
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!supabaseUrl || !supabaseServiceKey || !LOVABLE_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Server misconfigured" }),
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

    let imageUrl: string | null = null;
    let lastError: string | null = null;

    for (const model of IMAGE_MODELS) {
      try {
        const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: [{ type: "text", text: imagePrompt }] }],
            modalities: ["image", "text"],
          }),
        });
        if (!resp.ok) {
          lastError = `${model} ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
          console.error(lastError);
          continue;
        }
        const data = await resp.json();
        imageUrl =
          data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
          data?.choices?.[0]?.message?.image_url?.url ||
          null;
        if (imageUrl) break;
        lastError = `${model} returned no image`;
      } catch (err) {
        lastError = `${model} threw: ${err instanceof Error ? err.message : String(err)}`;
        console.error(lastError);
      }
    }

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: lastError || "Image generation failed" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
      JSON.stringify({ imageUrl }),
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
