// deno-lint-ignore-file no-explicit-any
//
// generate-image: image-only generation. Split from generate-content so
// the frontend can show the text instantly (text gen is fast) and
// asynchronously fill in the image (image gen is slow). Also used as
// the "regenerate image" endpoint from the dashboard.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { getSocialImageSpec, type SocialImageSpec } from "../_shared/socialImageSpecs.ts";
// Image generation for Pro Social AI must produce real poster layouts.
// Keep this endpoint dedicated to Graphiste GPT poster output rather than
// generic image providers. The chosen output format always follows the post's
// target platforms (see _shared/socialImageSpecs.ts) so a LinkedIn post never
// comes back as a TikTok-shaped image and vice-versa.


const MAX_PAYLOAD_BYTES = 64 * 1024;

// Each image is a paid Graphiste GPT "premium 2K" poster — the expensive
// operation. Cap how many a single user can mint per hour (covers normal use
// plus a few regenerations). Enforced atomically via consume_generation_quota.
const IMAGE_RATE_LIMIT_MAX = 30;
// Soft monthly cap per user (cost control for the free beta).
const IMAGE_MONTHLY_MAX = 200;

const GRAPHISTE_GPT_DEFAULT_URL =
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

// Aspect ratios supported by the Graphiste GPT API (v1.1). We send the post's
// exact network ratio when supported (e.g. 1.91:1 for LinkedIn / Facebook) so
// the API never falls back to its 9:16 default; otherwise we map orientation to
// the closest standard ratio.
const GRAPHISTE_RATIOS = new Set(["9:16", "16:9", "1:1", "4:5", "5:4", "1.91:1", "4:3", "3:4", "2:3", "3:2"]);
function graphisteAspectRatio(spec: SocialImageSpec): string {
  if (GRAPHISTE_RATIOS.has(spec.aspectRatio)) return spec.aspectRatio;
  switch (spec.orientation) {
    case "story": return "9:16";
    case "portrait": return "4:5";
    case "landscape": return "16:9";
    default: return "1:1";
  }
}

function titleFromPost(postContent: string, companyName: string): string {
  const explicit = postContent.match(/(?:titre|title)\s*[:：-]\s*([^\n.]+)/i)?.[1]?.trim();
  if (explicit) return explicit.slice(0, 70);
  const firstSentence = postContent.split(/[.!?\n]/).find((s) => s.trim().length > 12)?.trim();
  return (firstSentence || companyName || "Offre professionnelle").slice(0, 70);
}

function ctaFromPost(postContent: string): string {
  const lower = postContent.toLowerCase();
  if (/réservez|reservez|reservation|rendez-vous/.test(lower)) return "Réservez maintenant";
  if (/contact|appel|whatsapp|téléphone|telephone/.test(lower)) return "Contactez-nous";
  if (/découvrez|decouvrez|voir|visitez/.test(lower)) return "Découvrez l’offre";
  if (/inscri|formation|cours|atelier/.test(lower)) return "Inscrivez-vous";
  return "Passez à l’action";
}

function orientationLabel(orientation: string): string {
  switch (orientation) {
    case "story": return "vertical plein écran 9:16";
    case "portrait": return "portrait 4:5";
    case "landscape": return "paysage";
    default: return "carré 1:1";
  }
}

function isStaticReferenceTemplateUrl(value: string): boolean {
  return value.includes("/reference-templates/") &&
    !value.includes("/reference-templates/generated/");
}

function isImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  // Graphiste stores completed raster jobs under reference-templates/generated/.
  // Reject only static template placeholders, not that generated output folder.
  if (isStaticReferenceTemplateUrl(v)) return false;
  if (/^data:image\/svg/i.test(v)) return false;
  if (v.startsWith("data:image/")) return true;
  if (/^https?:\/\//i.test(v)) return !/\.svg(\?|#|$)/i.test(v);
  if (v.startsWith("/")) return !/\.svg(\?|#|$)/i.test(v);
  return false;
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
  // The canonical field is data.job_id. Do NOT accept request_id here: the
  // v1.1 envelope carries a top-level request_id (an API trace id, not a
  // pollable job) that would otherwise be grabbed before we recurse into
  // `data` — producing an id that 404s on GET /v1/posters/{id}.
  const direct = obj.job_id || obj.jobId || obj.task_id || obj.taskId || obj.id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
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
  // Prefer the documented public job route derived from data.job_id. Some API
  // versions emitted a status_url pointing at an internal/legacy handler which
  // can return 404 even though the canonical job route works.
  if (jobId) {
    const u = new URL(endpoint);
    const base = `${u.origin}${u.pathname.replace(/\/generate\/?$/, "")}`;
    out.push(`${base}/${encodeURIComponent(jobId)}`);
    out.push(`${base}/status/${encodeURIComponent(jobId)}`);
    out.push(`${base}/jobs/${encodeURIComponent(jobId)}`);
    out.push(`${u.origin}/functions/v1/api-v1/v1/jobs/${encodeURIComponent(jobId)}`);
  }
  if (statusUrl) out.push(statusUrl.startsWith("http") ? statusUrl : new URL(statusUrl, endpoint).toString());
  return [...new Set(out)];
}

// Detect a terminal "failed" job so polling can stop early instead of waiting
// out the whole budget.
function graphisteJobFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // v1.1 failures can use a structured envelope, including on a non-2xx poll:
  // { success:false, error:{ code:"JOB_TIMEOUT", message:"..." } }
  if (obj.success === false && obj.error) return true;
  const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (status === "failed" || status === "error" || status === "canceled" || status === "cancelled") return true;
  for (const key of ["data", "result", "job"]) {
    if (graphisteJobFailed(obj[key])) return true;
  }
  return false;
}

type GraphisteJobStatus = "completed" | "processing" | "failed";

// Poll the job's status URL(s) for a BOUNDED window. Returns "processing" if the
// budget elapses without a final image, so the caller can hand the job back to
// the client to resume — keeping every edge invocation short and safely under
// Supabase's 150s request timeout (premium 2K posters can take minutes).
async function pollGraphisteJob(
  candidates: string[],
  key: string,
  budgetMs: number,
  signal: AbortSignal,
): Promise<{ imageUrl: string | null; status: GraphisteJobStatus }> {
  if (candidates.length === 0) return { imageUrl: null, status: "processing" };
  const started = Date.now();
  let delay = 2500;
  while (Date.now() - started < budgetMs) {
    await sleep(delay);
    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal,
        });
        const text = await resp.text();
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        // Candidate routes are fallbacks for API-version differences. A 400/404
        // from one unsupported route is NOT the state of the real job. Only a
        // successful poll response may declare the job terminal; otherwise try
        // the next candidate. Once a healthy route answers "processing", stop
        // probing invalid alternatives during this tick.
        if (!resp.ok) continue;
        const imageUrl = extractGraphisteImageUrl(data, false);
        if (imageUrl) return { imageUrl, status: "completed" };
        if (graphisteJobFailed(data)) return { imageUrl: null, status: "failed" };
        break;
      } catch (_err) {
        // Try next candidate / next poll tick.
      }
    }
    delay = Math.min(delay + 1500, 6000);
  }
  return { imageUrl: null, status: "processing" };
}

// Resume polling an in-flight job started by a previous (short) invocation.
async function resumeGraphisteJob(
  jobId: string,
  statusUrl: string | null,
  budgetMs: number,
): Promise<{ imageUrl: string | null; status: GraphisteJobStatus }> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) return { imageUrl: null, status: "failed" };
  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const candidates = graphisteStatusCandidates(endpoint, statusUrl, jobId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs + 10_000);
  try {
    return await pollGraphisteJob(candidates, key, budgetMs, controller.signal);
  } catch (_err) {
    return { imageUrl: null, status: "processing" };
  } finally {
    clearTimeout(timer);
  }
}

function extractGraphisteImageUrl(value: unknown, allowTemplateImage = false): string | null {
  if (!value) return null;
  if (isImageUrl(value)) return absoluteGraphisteUrl(value);
  if (typeof value === "string") {
    const dataMatch = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (dataMatch?.[0] && !/^data:image\/svg/i.test(dataMatch[0])) return dataMatch[0];
    const urlMatch = value.match(/https?:\/\/[^\s)"']+/);
    if (urlMatch?.[0] && !/\.svg(\?|#|$)/i.test(urlMatch[0]) && !isStaticReferenceTemplateUrl(urlMatch[0])) {
      return absoluteGraphisteUrl(urlMatch[0]);
    }
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
  if (/event|événement|evenement|concert|conférence|conference|festival/.test(haystack)) return "evenement";
  if (/ecommerce|commerce|boutique|produit|shop|vente|promo|promotion|offre/.test(haystack)) return "ecommerce";
  if (/mode|fashion|vêtement|vetement|beauté|beaute/.test(haystack)) return "fashion";
  if (/immobilier|real.?estate|maison|terrain|appartement/.test(haystack)) return "realestate";
  if (/santé|sante|health|clinique|médical|medical|pharma/.test(haystack)) return "health";
  // "business" is the documented generic default (GET /v1/domains) — always reliable.
  return "business";
}

// The Graphiste GPT API has no free-form `prompt` field — it reads `subject`
// (a detailed description) plus the structured fields. So all of our creative
// direction lives here, in `subject`.
function buildGraphisteSubject(params: {
  postContent: string;
  contentCategory: "value" | "research" | "promo";
  sector: string;
  description: string;
  companyName: string;
  footerText: string;
  spec: SocialImageSpec;
}): string {
  const ctx = [
    params.sector ? `Secteur: ${params.sector}` : null,
    params.description ? `Activité: ${params.description.slice(0, 220)}` : null,
  ].filter(Boolean).join(". ");
  const isPromo = params.contentCategory === "promo";
  const cta = ctaFromPost(params.postContent);
  const persistentFooter = params.footerText.trim()
    ? `Texte permanent utilisateur: écris le texte exact "${params.footerText.trim().slice(0, 120)}" dans l'angle inférieur gauche, dans un cartouche élégant à fort contraste, très lisible et bien aligné. Ne le reformule pas, ne le corrige pas et ne le répète nulle part ailleurs.`
    : `L'utilisateur n'a défini aucun message: n'ajoute aucun texte permanent dans l'angle inférieur gauche.`;
  return [
    isPromo
      ? `Affiche publicitaire professionnelle premium pour les réseaux sociaux (${params.spec.label}, ${orientationLabel(params.spec.orientation)}).`
      : `Visuel éditorial professionnel premium pour les réseaux sociaux (${params.spec.label}, ${orientationLabel(params.spec.orientation)}).`,
    `${ctx}.`,
    `Le visuel doit être complémentaire au texte, pas une copie intégrale: transforme l'idée centrale en une scène, une métaphore ou une composition visuelle claire. Message source: ${params.postContent.slice(0, 700)}`,
    `Composition: visuel complet (pas un fond vide), accroche courte et très lisible, hiérarchie visuelle forte, éclairage cinématographique, mise en page moderne remplie de bord à bord, contraste premium.`,
    isPromo
      ? `Appel à l'action commercial du contenu: ${cta}.`
      : `N'invente aucun appel à l'action commercial, prix ou offre: ne transforme pas le visuel en publicité; seul le texte permanent explicitement choisi par l'utilisateur ci-dessous peut apparaître.`,
    persistentFooter,
    `Identité de marque: place le logo fourni et/ou le nom exact "${params.companyName}" comme signature de marque discrète dans l'angle inférieur droit, toujours au même emplacement, petite mais lisible; ce nom ne doit jamais être le titre principal.`,
    `Interdictions: pas de petit texte illisible, pas de fausses lettres, pas de watermark, pas d'élément d'interface, pas d'image vide ni de template vide.`,
    `Si des personnes sont représentées, privilégier des personnes africaines/noires professionnelles et crédibles.`,
    `Direction (EN): premium editorial social visual, complementary to the post text, cinematic lighting, strong visual hierarchy, modern clean layout, short readable headline, discreet fixed bottom-right brand signature, no tiny unreadable text, no random letters, no watermark, no UI.`,
  ].join("\n").slice(0, 1800);
}

// Turn a Graphiste GPT HTTP error into a clear, actionable message. Parses the
// v1.1 error envelope { success:false, error:{ code, message, request_id } }.
// Never includes the API key (only the status code and the API's own message).
function graphisteErrorMessage(status: number, body: unknown, text: string): string {
  let detail = text.slice(0, 160);
  if (body && typeof body === "object") {
    const apiError = (body as { error?: { code?: unknown; message?: unknown } }).error;
    if (apiError && typeof apiError === "object") {
      const code = typeof apiError.code === "string" ? apiError.code : "";
      const message = typeof apiError.message === "string" ? apiError.message : "";
      detail = [code, message].filter(Boolean).join(": ") || detail;
    }
  }
  if (status === 401) return `Clé Graphiste GPT invalide ou manquante (401). Vérifiez le secret GRAPHISTE_GPT_API_KEY dans Supabase. ${detail}`;
  if (status === 402) return `Crédits Graphiste GPT insuffisants (402). Rechargez le compte Graphiste GPT puis réessayez. ${detail}`;
  if (status === 403) return `Accès Graphiste GPT refusé (403). Vérifiez les droits/scope de la clé API. ${detail}`;
  if (status === 429) return `Trop de requêtes vers Graphiste GPT (429). Réessayez dans une minute. ${detail}`;
  if (status === 400) return `Requête refusée par Graphiste GPT (400): ${detail}`;
  return `Graphiste GPT a échoué (${status}). Réessayez dans un instant. ${detail}`;
}

async function tryGraphisteGptPoster(params: {
  postContent: string;
  contentCategory: "value" | "research" | "promo";
  sector: string;
  description: string;
  companyName: string;
  footerText: string;
  primary: string;
  secondary: string;
  accent: string;
  logoUrl: string | null;
  spec: SocialImageSpec;
}): Promise<{ imageUrl: string | null; warning: string | null; jobId: string | null; statusUrl: string | null; status: GraphisteJobStatus }> {
  const fail = (warning: string) => ({
    imageUrl: null,
    warning,
    jobId: null,
    statusUrl: null,
    status: "failed" as GraphisteJobStatus,
  });
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) return fail("GRAPHISTE_GPT_API_KEY not configured");

  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const colors = [params.primary, params.secondary, params.accent]
    .map((c) => (c || "").trim())
    .filter((c) => /^#[0-9a-f]{6}$/i.test(c));

  // Per the documented contract (v1.1): domain + subject are required; quality is
  // forced to premium server-side; aspect_ratio + resolution control the output
  // format (without them the API silently defaults every poster to 9:16). We use
  // mode "async" — recommended for Supabase — so the API returns a job to poll
  // instead of holding a long synchronous connection.
  const requestBody: Record<string, unknown> = {
    domain: graphisteDomain(params.sector, params.description, params.postContent),
    subject: buildGraphisteSubject(params),
    title: titleFromPost(params.postContent, params.companyName),
    quality: "premium",
    aspect_ratio: graphisteAspectRatio(params.spec),
    resolution: "2K",
    mode: "async",
    // Premium-first, but allow Graphiste GPT's real raster fallback when
    // the premium model times out instead of leaving the post image-less.
    reliability_mode: true,
  };
  if (colors.length) requestBody.colors = colors;
  if (params.logoUrl && /^https?:\/\//i.test(params.logoUrl)) {
    requestBody.logo_urls = [params.logoUrl];
  }

  const controller = new AbortController();
  // Short cap: the POST returns a job (HTTP 202) quickly; the brief poll below
  // catches fast posters, and slower ones are handed back to the client.
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Lets the API safely retry a failed generation without double-charging.
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!resp.ok) return fail(graphisteErrorMessage(resp.status, data, text));
    if (data === null) return fail(`Graphiste GPT returned non-JSON: ${text.slice(0, 120)}`);
    // Surface any fields the API ignored (e.g. an accidental unknown field).
    if (typeof data === "object") {
      const envelope = data as { success?: unknown; warnings?: unknown };
      const w = envelope.warnings;
      if (Array.isArray(w) && w.length) console.warn("Graphiste GPT warnings:", w);
      // Public API errors use { success:false, error:{ code, message, request_id } }.
      // Handle that even if a proxy/runtime accidentally returns HTTP 200/202.
      if (envelope.success === false) return fail(graphisteErrorMessage(resp.status, data, text));
    }
    const jobId = extractGraphisteJobId(data);
    const statusUrl = extractGraphisteStatusUrl(data);
    // Fast path: a finished poster came back directly at data.image_url.
    const direct = extractGraphisteImageUrl(data, false);
    if (direct) return { imageUrl: direct, warning: null, jobId, statusUrl, status: "completed" };
    // Async (HTTP 202 + job_id + absolute status_url): poll briefly, then hand
    // the job back to the client to resume so no single call runs too long.
    const candidates = graphisteStatusCandidates(endpoint, statusUrl, jobId);
    const r = await pollGraphisteJob(candidates, key, 40_000, controller.signal);
    if (r.status === "failed") {
      return { imageUrl: null, warning: "Graphiste GPT a signalé un échec de génération.", jobId, statusUrl, status: "failed" };
    }
    return { imageUrl: r.imageUrl, warning: null, jobId, statusUrl, status: r.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return fail(
      isAbort
        ? "Graphiste GPT a dépassé le délai de génération. Réessayez dans un instant."
        : `Graphiste GPT inaccessible: ${message}`,
    );
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
    const requestedCategory = body?.contentCategory || body?.postType;
    let contentCategory: "value" | "research" | "promo" =
      requestedCategory === "promo" || requestedCategory === "research"
        ? requestedCategory
        : "value";
    // Resume mode: a previous call returned a job id to keep polling.
    const resumeJobId: string | null =
      typeof body?.jobId === "string" && body.jobId ? body.jobId : null;
    const resumeStatusUrl: string | null =
      typeof body?.statusUrl === "string" && body.statusUrl ? body.statusUrl : null;
    let platforms: string[] = Array.isArray(body?.platforms)
      ? body.platforms.map((x: unknown) => String(x)).filter(Boolean).slice(0, 12)
      : [];

    if (!resumeJobId && !postContent) {
      return new Response(
        JSON.stringify({ error: "postContent is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Existing posts carry their persisted editorial category. Read it back so
    // image regeneration/resume keeps value and research visuals non-commercial.
    if (postId) {
      const { data: postRow } = await supabase
        .from("posts")
        .select("platforms, content_category")
        .eq("id", postId)
        .eq("user_id", userId)
        .maybeSingle();
      if (platforms.length === 0 && Array.isArray(postRow?.platforms)) {
        platforms = postRow.platforms.map((x: unknown) => String(x)).filter(Boolean);
      }
      if (postRow?.content_category === "promo" || postRow?.content_category === "research") {
        contentCategory = postRow.content_category;
      } else if (postRow?.content_category === "value") {
        contentCategory = "value";
      }
    }

    // One coherent output format for the whole post, derived from its targets.
    const spec = getSocialImageSpec(platforms);
    const format = {
      label: spec.label,
      aspectRatio: graphisteAspectRatio(spec),
      orientation: spec.orientation,
      platforms: spec.platforms,
      resolution: "2K",
    };

    const jsonResponse = (payload: Record<string, unknown>, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    // No real Graphiste GPT poster → clear, actionable error (never an SVG).
    const noFinalImage = (detail?: string) =>
      jsonResponse({
        error: "Graphiste GPT n'a pas retourné d'affiche finale. Réessayez ; si le problème persiste, vérifiez la clé GRAPHISTE_GPT_API_KEY et le service Graphiste GPT.",
        code: "no_final_image",
        detail: detail || undefined,
        format,
      });
    // Still generating → hand the job back so the client resumes polling.
    // Also persist the in-flight job on the post row (best-effort) so a slow
    // poster that finishes AFTER the client gives up is not orphaned: the row
    // keeps image_job_id/image_status_url and can be resumed later (on the next
    // dashboard load, or at publish time). Mirrors the auto-post (cron) path.
    const stillProcessing = async (jobId: string | null, statusUrl: string | null) => {
      if (postId && (jobId || statusUrl)) {
        const { error: persistErr } = await supabase
          .from("posts")
          .update({ image_job_id: jobId, image_status_url: statusUrl, image_status: "processing" })
          .eq("id", postId)
          .eq("user_id", userId);
        if (persistErr) console.error("Failed to persist in-flight poster job:", persistErr.message);
      }
      return jsonResponse({ status: "processing", jobId, statusUrl, format });
    };

    // The poster engine is Graphiste GPT only — there is no local fallback.
    // If the key is missing, fail clearly and save nothing.
    if (!Deno.env.get("GRAPHISTE_GPT_API_KEY")) {
      return jsonResponse({
        error: "Génération d'affiche indisponible : le secret GRAPHISTE_GPT_API_KEY n'est pas configuré dans Supabase (Edge Functions → Secrets).",
        code: "missing_api_key",
        format,
      });
    }

    let imageUrl: string | null = null;

    if (resumeJobId) {
      // Resume an in-flight job: short bounded poll, then hand back if needed.
      const r = await resumeGraphisteJob(resumeJobId, resumeStatusUrl, 45_000);
      if (r.status === "failed") return noFinalImage("job failed");
      if (!r.imageUrl) return await stillProcessing(resumeJobId, resumeStatusUrl);
      imageUrl = r.imageUrl;
    } else {
      // Soft monthly cap (cost control for the free beta).
      const monthSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { count: monthCount } = await supabase
        .from("generation_usage")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("function_name", "generate-image")
        .gte("created_at", monthSince);
      if ((monthCount ?? 0) >= IMAGE_MONTHLY_MAX) {
        return jsonResponse(
          { error: `Limite mensuelle de ${IMAGE_MONTHLY_MAX} images atteinte.`, code: "rate_limited", format },
          429,
        );
      }

      // Per-user rate limit (only the initial generation, not resume polls).
      // Best-effort: if the quota RPC is unavailable, allow rather than block.
      const { data: quotaOk, error: quotaErr } = await supabase.rpc("consume_generation_quota", {
        p_user: userId,
        p_function: "generate-image",
        p_max: IMAGE_RATE_LIMIT_MAX,
        p_window_seconds: 3600,
      });
      if (quotaErr) {
        console.error("consume_generation_quota (image) failed, allowing:", quotaErr.message);
      } else if (quotaOk === false) {
        return jsonResponse(
          {
            error: `Limite de ${IMAGE_RATE_LIMIT_MAX} images par heure atteinte. Réessayez plus tard.`,
            code: "rate_limited",
            format,
          },
          429,
        );
      }

      // Initial request: load brand preferences and kick off generation.
      const { data: profile } = await supabase
        .from("profiles")
        .select(
          "image_people_type, image_style, brand_primary_color, brand_secondary_color, brand_accent_color, brand_font, sector, description, company_name, logo_url, poster_footer_text",
        )
        .eq("id", userId)
        .maybeSingle();

      const primary = profile?.brand_primary_color || "#8B5CF6";
      const secondary = profile?.brand_secondary_color || "#3B82F6";
      const accent = profile?.brand_accent_color || "#F59E0B";
      const sector = profile?.sector || "";
      const description = profile?.description || "";

      const graphiste = await tryGraphisteGptPoster({
        postContent,
        contentCategory,
        sector,
        description,
        companyName: profile?.company_name || "Entreprise",
        footerText: profile?.poster_footer_text || "",
        primary,
        secondary,
        accent,
        logoUrl: profile?.logo_url || null,
        spec,
      });
      if (graphiste.warning) console.warn("Graphiste GPT:", graphiste.warning);

      // Surface the specific, actionable reason (e.g. "Crédits Graphiste GPT
      // insuffisants (402)", "Clé invalide (401)", "Trop de requêtes (429)")
      // directly to the user instead of a generic "no final image" message, so
      // the real cause is visible without digging in the logs.
      if (graphiste.status === "failed") {
        return graphiste.warning
          ? jsonResponse({ error: graphiste.warning, code: "graphiste_error", format })
          : noFinalImage();
      }
      if (!graphiste.imageUrl) {
        // Still generating: hand the job to the client so it can resume polling
        // without any single invocation running near the 150s edge limit.
        if (graphiste.jobId || graphiste.statusUrl) {
          return await stillProcessing(graphiste.jobId, graphiste.statusUrl);
        }
        return noFinalImage(graphiste.warning || undefined);
      }
      imageUrl = graphiste.imageUrl;
    }

    if (!imageUrl) return noFinalImage();

    // Re-host to user-assets/ for a permanent URL, and verify it is a real
    // raster image (never an SVG/placeholder) before saving it anywhere.
    if (!imageUrl.startsWith(supabaseUrl)) {
      let bytes: Uint8Array | null = null;
      let contentType = "image/png";
      try {
        if (imageUrl.startsWith("data:")) {
          const commaIdx = imageUrl.indexOf(",");
          const meta = imageUrl.slice(5, commaIdx);
          const payload = imageUrl.slice(commaIdx + 1);
          contentType = (meta.split(";")[0] || "image/png").trim().toLowerCase();
          if (contentType.includes("svg")) throw new Error("refusing SVG data URL");
          if (meta.includes(";base64")) {
            const bin = atob(payload);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else {
            bytes = new TextEncoder().encode(decodeURIComponent(payload));
          }
        } else {
          const fetched = await fetch(imageUrl);
          if (!fetched.ok) throw new Error(`image fetch ${fetched.status}`);
          contentType = (fetched.headers.get("content-type") || "image/png").toLowerCase();
          if (!contentType.startsWith("image/") || contentType.includes("svg")) {
            throw new Error(`unexpected content-type ${contentType}`);
          }
          bytes = new Uint8Array(await fetched.arrayBuffer());
        }
      } catch (verifyErr) {
        console.error("generate-image: could not verify a real raster poster:", verifyErr);
        return new Response(
          JSON.stringify({
            error: "Graphiste GPT n'a pas retourné une vraie image d'affiche exploitable. Réessayez.",
            code: "no_final_image",
            format,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Upload (best-effort: keep the verified source URL/data if upload fails).
      if (bytes) {
        try {
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
          console.error("rehost upload failed (keeping verified source):", rehostErr);
        }
      }
    }

    // Attach the finished poster to the post row (success path only).
    if (postId) {
      const { error: updateErr } = await supabase
        .from("posts")
        .update({ image_url: imageUrl, image_status: "done", image_job_id: null, image_status_url: null })
        .eq("id", postId)
        .eq("user_id", userId);
      if (updateErr) console.error("Failed to attach image to post:", updateErr);
    }

    return new Response(
      JSON.stringify({ imageUrl, provider: "graphiste-gpt", fallback: false, format }),
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
