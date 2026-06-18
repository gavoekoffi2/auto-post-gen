// deno-lint-ignore-file no-explicit-any
//
// generate-image: image-only generation. Split from generate-content so
// the frontend can show the text instantly (text gen is fast) and
// asynchronously fill in the image (image gen is slow). Also used as
// the "regenerate image" endpoint from the dashboard.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
// Image generation for Pro Social AI must produce real poster layouts.
// Keep this endpoint dedicated to Graphiste GPT poster output rather than
// generic image providers.

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGraphisteJobId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = obj.job_id || obj.jobId || obj.request_id || obj.requestId || obj.id || obj.task_id || obj.taskId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const key of ["data", "result", "job", "request", "generation"]) {
    const nested = extractGraphisteJobId(obj[key]);
    if (nested) return nested;
  }
  return null;
}

function extractGraphisteStatusUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = obj.statusUrl || obj.status_url || obj.pollUrl || obj.poll_url || obj.checkUrl || obj.check_url;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const key of ["data", "result", "job", "request", "generation"]) {
    const nested = extractGraphisteStatusUrl(obj[key]);
    if (nested) return nested;
  }
  return null;
}

function graphisteStatusCandidates(endpoint: string, statusUrl: string | null, jobId: string | null): string[] {
  const out: string[] = [];
  if (statusUrl) out.push(statusUrl.startsWith("http") ? statusUrl : new URL(statusUrl, endpoint).toString());
  if (jobId) {
    const u = new URL(endpoint);
    const base = `${u.origin}${u.pathname.replace(/\/generate\/?$/, "")}`;
    out.push(`${base}/${encodeURIComponent(jobId)}`);
    out.push(`${base}/status/${encodeURIComponent(jobId)}`);
    out.push(`${base}/jobs/${encodeURIComponent(jobId)}`);
    out.push(`${u.origin}/functions/v1/api-v1/v1/jobs/${encodeURIComponent(jobId)}`);
  }
  return [...new Set(out)];
}

async function pollGraphisteGptJob(endpoint: string, key: string, firstData: unknown, signal: AbortSignal): Promise<string | null> {
  const jobId = extractGraphisteJobId(firstData);
  const statusUrl = extractGraphisteStatusUrl(firstData);
  const candidates = graphisteStatusCandidates(endpoint, statusUrl, jobId);
  if (candidates.length === 0) return null;

  const started = Date.now();
  let delay = 4000;
  while (Date.now() - started < 90_000) {
    await sleep(delay);
    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal,
        });
        if (!resp.ok) continue;
        const text = await resp.text();
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        const imageUrl = extractGraphisteImageUrl(data, false);
        if (imageUrl) return imageUrl;
      } catch (_err) {
        // Try next candidate / next poll tick.
      }
    }
    delay = Math.min(delay + 3000, 12000);
  }
  return null;
}

function extractGraphisteImageUrl(value: unknown, allowTemplateImage = false): string | null {
  if (!value) return null;
  if (isImageUrl(value)) return absoluteGraphisteUrl(value);
  if (typeof value === "string") {
    const dataMatch = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (dataMatch?.[0]) return dataMatch[0];
    const urlMatch = value.match(/https?:\/\/[^\s)"']+/);
    if (urlMatch?.[0]) return absoluteGraphisteUrl(urlMatch[0]);
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractGraphisteImageUrl(item, allowTemplateImage);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.b64_json === "string" && obj.b64_json.length > 100) {
      return `data:image/png;base64,${obj.b64_json}`;
    }
    if (typeof obj.base64 === "string" && obj.base64.length > 100) {
      return obj.base64.startsWith("data:image/") ? obj.base64 : `data:image/png;base64,${obj.base64}`;
    }
    const finalImage =
      extractGraphisteImageUrl(obj.poster_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.posterUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.final_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.finalUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.final_image_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.finalImageUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.generated_image_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.generatedImageUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.asset_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.assetUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.image_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.imageUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.publicUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.public_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.download_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.downloadUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.secure_url, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.secureUrl, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.file, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.asset, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.poster, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.image, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.data, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.output, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.outputs, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.result, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.results, allowTemplateImage) ||
      extractGraphisteImageUrl(obj.images, allowTemplateImage);
    if (finalImage) return finalImage;
    if (allowTemplateImage) return extractGraphisteImageUrl(obj.template_used, true);
  }
  return null;
}

function graphisteDomain(sector: string, description: string, postContent = ""): string {
  const haystack = `${sector} ${description} ${postContent}`.toLowerCase();
  if (/restaurant|food|cuisine|bar|burger|pizza|menu|boisson|plat|midi|réservez|reservez/.test(haystack)) return "restaurant";
  if (/église|eglise|church|pasteur|minist/.test(haystack)) return "church";
  if (/formation|cours|école|ecole|academy|coaching|webinar|atelier|apprendre/.test(haystack)) return "formation";
  if (/event|événement|evenement|concert|conférence|conference|festival/.test(haystack)) return "event";
  if (/ecommerce|commerce|boutique|produit|shop|vente|promo|promotion|offre/.test(haystack)) return "ecommerce";
  if (/mode|fashion|vêtement|vetement|beauté|beaute/.test(haystack)) return "fashion";
  if (/immobilier|real.?estate|maison|terrain|appartement/.test(haystack)) return "realestate";
  if (/santé|sante|health|clinique|médical|medical|pharma/.test(haystack)) return "health";
  // Avoid Graphiste GPT's broken "service" references; formation has reliable templates and still works for generic business posts.
  return "formation";
}

function buildGraphistePosterPrompt(params: {
  postContent: string;
  sector: string;
  description: string;
  companyName: string;
  primary: string;
  secondary: string;
  accent: string;
}): string {
  const businessContext = [
    `Entreprise: ${params.companyName || "Entreprise"}`,
    params.sector ? `Secteur: ${params.sector}` : null,
    params.description ? `Activité: ${params.description.slice(0, 260)}` : null,
  ].filter(Boolean).join("\n");

  return `Créer une AFFICHE PUBLICITAIRE PROFESSIONNELLE complète en français pour les réseaux sociaux.

${businessContext}

MESSAGE À TRANSFORMER EN AFFICHE:
${params.postContent.slice(0, 900)}

EXIGENCE PRINCIPALE:
- Ne pas générer une image vide, un simple fond, ou une affiche sans contenu.
- L'affiche doit contenir une vraie composition complète: titre principal lisible, visuel fort, blocs graphiques, hiérarchie claire, contraste premium.
- Ajouter 2 à 5 mots-clés courts issus du message, mais éviter les longs paragraphes.
- Prévoir un espace CTA visuel du type "Contactez-nous", "Réservez", "Découvrez", ou équivalent selon le message.
- Utiliser les affiches/templates internes Graphiste GPT comme inspiration professionnelle de structure, pas comme contrainte stricte.
- Si le message ne correspond pas parfaitement au domaine fourni, créer librement une affiche adaptée au message en appliquant les bonnes pratiques Graphiste GPT: hiérarchie forte, mise en page remplie, contraste, CTA, visuel central, équilibre typographique.

STYLE:
- Qualité premium, rendu publicitaire professionnel, moderne, non vide.
- Format social/poster vertical ou carré avec une composition remplie.
- Couleurs de marque à intégrer visiblement: primaire ${params.primary}, secondaire ${params.secondary}, accent ${params.accent}.
- Si des personnes sont représentées, privilégier des personnes africaines/noires professionnelles et crédibles.

SORTIE ATTENDUE:
Une affiche finale complète, prête à publier, pas une image standard et pas un template vide.`;
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
  const prompt = buildGraphistePosterPrompt(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        domain: graphisteDomain(params.sector, params.description, params.postContent),
        subject,
        prompt,
        usageType: "social",
        // Graphiste GPT quality modes: "fast" uses the quick model; "premium" uses OpenAI GPT Image 2.
        // Pro Social AI runs generation asynchronously, so prefer poster quality over speed.
        quality: "premium",
        waitForCompletion: true,
        sync: true,
        returnImage: true,
        returnUrl: true,
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
    const polledImageUrl = await pollGraphisteGptJob(endpoint, key, data, controller.signal);
    if (polledImageUrl) return { imageUrl: polledImageUrl, warning: null };
    return {
      imageUrl: null,
      warning: `Graphiste GPT did not return a final image URL after polling; response only contains metadata/template data: ${JSON.stringify(data).slice(0, 500)}`,
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
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({ error: "Server misconfigured (missing Supabase server configuration)" }),
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

    const imageStyle: string = profile?.image_style || "photorealistic";
    const primary = profile?.brand_primary_color || "#8B5CF6";
    const secondary = profile?.brand_secondary_color || "#3B82F6";
    const accent = profile?.brand_accent_color || "#F59E0B";
    const sector = profile?.sector || "";
    const description = profile?.description || "";

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

    const rawImageUrl = graphiste.imageUrl;
    const lastError = graphiste.warning;
    let imageUrl: string | null = rawImageUrl;

    let usedFallback = false;
    if (!imageUrl) {
      console.error("Graphiste GPT poster generation failed:", lastError);
      const allowFallback = Deno.env.get("ALLOW_BRANDED_IMAGE_FALLBACK") === "true";
      if (!allowFallback) {
        return new Response(
          JSON.stringify({
            error: "Graphiste GPT n'a pas retourné une vraie image finale. Génération annulée pour éviter le même SVG vide.",
            warning: lastError,
            fallback: false,
            provider: "graphiste-gpt",
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
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
      JSON.stringify({
        imageUrl,
        fallback: usedFallback,
        provider: usedFallback ? "branded-fallback" : "graphiste-gpt",
        warning: usedFallback ? lastError : undefined,
      }),
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
