// deno-lint-ignore-file no-explicit-any
//
// Lean, server-side Graphiste GPT poster client for the AUTOMATIC posting
// pipeline (cron). It mirrors the documented v1.1 contract used by the
// interactive generate-image endpoint, but is purpose-built for a cron that
// cannot block on minute-long jobs:
//
//   * startPosterJob()  — fires the generation request and returns FAST
//                         (no long poll). Either a finished poster came back
//                         directly, or we get back a job id / status URL to
//                         resume later.
//   * resumePosterJob() — bounded poll used at publish time. By the time an
//                         auto-post is due (days after generation) its job is
//                         long finished, so this returns the poster instantly.
//   * rehostToUserAssets() — store a poster on our own bucket for a stable URL.
//
// generate-image/index.ts intentionally keeps its own copy of the interactive
// flow (with client hand-off + its policy tests); this module is the
// cron-side counterpart and shares only the same external API contract.
//
import { getSocialImageSpec, type SocialImageSpec } from "./socialImageSpecs.ts";

const GRAPHISTE_GPT_DEFAULT_URL =
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

const GRAPHISTE_RATIOS = new Set([
  "9:16", "16:9", "1:1", "4:5", "5:4", "1.91:1", "4:3", "3:4", "2:3", "3:2",
]);

export type PosterStatus = "completed" | "processing" | "failed";

export interface StartPosterParams {
  postContent: string;
  sector: string;
  description: string;
  companyName: string;
  primary: string;
  secondary: string;
  accent: string;
  logoUrl: string | null;
  platforms: string[];
}

export interface PosterResult {
  imageUrl: string | null;
  jobId: string | null;
  statusUrl: string | null;
  status: PosterStatus;
  error?: string;
}

function graphisteAspectRatio(spec: SocialImageSpec): string {
  if (GRAPHISTE_RATIOS.has(spec.aspectRatio)) return spec.aspectRatio;
  switch (spec.orientation) {
    case "story": return "9:16";
    case "portrait": return "4:5";
    case "landscape": return "16:9";
    default: return "1:1";
  }
}

function orientationLabel(orientation: string): string {
  switch (orientation) {
    case "story": return "vertical plein écran 9:16";
    case "portrait": return "portrait 4:5";
    case "landscape": return "paysage";
    default: return "carré 1:1";
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
  return "business";
}

function buildGraphisteSubject(params: StartPosterParams, spec: SocialImageSpec): string {
  const ctx = [
    `Entreprise: ${params.companyName || "Entreprise"}`,
    params.sector ? `Secteur: ${params.sector}` : null,
    params.description ? `Activité: ${params.description.slice(0, 220)}` : null,
  ].filter(Boolean).join(". ");
  const cta = ctaFromPost(params.postContent);
  return [
    `Affiche publicitaire professionnelle premium pour les réseaux sociaux (${spec.label}, ${orientationLabel(spec.orientation)}).`,
    `${ctx}.`,
    `Message à mettre en valeur: ${params.postContent.slice(0, 700)}`,
    `Composition: vraie affiche marketing complète (pas une simple image décorative ni un fond vide), titre principal très lisible, hiérarchie visuelle forte, éclairage cinématographique, mise en page moderne remplie de bord à bord, contraste premium.`,
    `Appel à l'action clair et visible: ${cta}.`,
    `Interdictions: pas de petit texte illisible, pas de fausses lettres, pas de watermark, pas d'élément d'interface, pas d'image vide ni de template vide.`,
    `Si des personnes sont représentées, privilégier des personnes africaines/noires professionnelles et crédibles.`,
    `Direction (EN): premium social media poster, high-end marketing campaign, cinematic lighting, strong visual hierarchy, modern clean layout, large readable headline, clear CTA, no tiny unreadable text, no random letters, no watermark, no UI.`,
  ].join("\n").slice(0, 1800);
}

function absoluteGraphisteUrl(value: string): string {
  if (value.startsWith("/")) return `https://graphistegpt.pro${value}`;
  return value;
}

function isPosterImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.includes("/reference-templates/")) return false;
  if (/^data:image\/svg/i.test(v)) return false;
  if (v.startsWith("data:image/")) return true;
  if (/^https?:\/\//i.test(v)) return !/\.svg(\?|#|$)/i.test(v);
  if (v.startsWith("/")) return !/\.svg(\?|#|$)/i.test(v);
  return false;
}

// Recursively pull the first usable raster poster URL/data out of an arbitrary
// JSON response, scanning the field names the API is known to use.
const POSTER_URL_FIELDS = [
  "poster_url", "posterUrl", "final_url", "finalUrl", "final_image_url", "finalImageUrl",
  "generated_image_url", "generatedImageUrl", "asset_url", "assetUrl", "image_url", "imageUrl",
  "url", "publicUrl", "public_url", "download_url", "downloadUrl", "secure_url", "secureUrl",
  "file", "asset", "poster", "image", "data", "output", "outputs", "result", "results", "images",
];
function extractPosterImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (isPosterImageUrl(value)) return absoluteGraphisteUrl(value as string);
  if (typeof value === "string") {
    const dataMatch = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (dataMatch?.[0] && !/^data:image\/svg/i.test(dataMatch[0])) return dataMatch[0];
    const urlMatch = value.match(/https?:\/\/[^\s)"']+/);
    if (urlMatch?.[0] && !/\.svg(\?|#|$)/i.test(urlMatch[0]) && !urlMatch[0].includes("/reference-templates/")) {
      return absoluteGraphisteUrl(urlMatch[0]);
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPosterImageUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.b64_json === "string" && obj.b64_json.length > 100) return `data:image/png;base64,${obj.b64_json}`;
    if (typeof obj.base64 === "string" && obj.base64.length > 100) {
      return obj.base64.startsWith("data:image/") ? obj.base64 : `data:image/png;base64,${obj.base64}`;
    }
    for (const field of POSTER_URL_FIELDS) {
      const found = extractPosterImageUrl(obj[field]);
      if (found) return found;
    }
  }
  return null;
}

function extractFromNested(value: unknown, getter: (o: Record<string, unknown>) => unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = getter(obj);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // Some APIs return a numeric job id; keep it rather than dropping the job.
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  for (const key of ["data", "result", "job", "request", "generation"]) {
    const nested = extractFromNested(obj[key], getter);
    if (nested) return nested;
  }
  return null;
}

function extractJobId(value: unknown): string | null {
  return extractFromNested(value, (o) =>
    o.job_id || o.jobId || o.request_id || o.requestId || o.id || o.task_id || o.taskId);
}

function extractStatusUrl(value: unknown): string | null {
  return extractFromNested(value, (o) =>
    o.statusUrl || o.status_url || o.pollUrl || o.poll_url || o.checkUrl || o.check_url);
}

function jobFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (["failed", "error", "canceled", "cancelled"].includes(status)) return true;
  for (const key of ["data", "result", "job"]) {
    if (jobFailed(obj[key])) return true;
  }
  return false;
}

function statusCandidates(endpoint: string, statusUrl: string | null, jobId: string | null): string[] {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fire the generation request and return quickly. We do NOT long-poll here so
// the weekly cron stays well under the edge runtime limit even with many posts.
export async function startPosterJob(params: StartPosterParams): Promise<PosterResult> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) return { imageUrl: null, jobId: null, statusUrl: null, status: "failed", error: "GRAPHISTE_GPT_API_KEY not configured" };

  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const spec = getSocialImageSpec(params.platforms);
  const colors = [params.primary, params.secondary, params.accent]
    .map((c) => (c || "").trim())
    .filter((c) => /^#[0-9a-f]{6}$/i.test(c));

  const requestBody: Record<string, unknown> = {
    domain: graphisteDomain(params.sector, params.description, params.postContent),
    subject: buildGraphisteSubject(params, spec),
    title: titleFromPost(params.postContent, params.companyName),
    quality: "premium",
    aspect_ratio: graphisteAspectRatio(spec),
    resolution: "2K",
    mode: "async",
  };
  if (colors.length) requestBody.colors = colors;
  if (params.logoUrl && /^https?:\/\//i.test(params.logoUrl)) requestBody.logo_urls = [params.logoUrl];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!resp.ok) return { imageUrl: null, jobId: null, statusUrl: null, status: "failed", error: `Graphiste GPT ${resp.status}: ${text.slice(0, 160)}` };
    if (data && typeof data === "object" && (data as { success?: unknown }).success === false) {
      return { imageUrl: null, jobId: null, statusUrl: null, status: "failed", error: "Graphiste GPT reported success:false" };
    }
    const jobId = extractJobId(data);
    const statusUrl = extractStatusUrl(data);
    const direct = extractPosterImageUrl(data);
    if (direct) return { imageUrl: direct, jobId, statusUrl, status: "completed" };
    if (jobId || statusUrl) return { imageUrl: null, jobId, statusUrl, status: "processing" };
    return { imageUrl: null, jobId: null, statusUrl: null, status: "failed", error: "Graphiste GPT returned neither image nor job id" };
  } catch (err) {
    return { imageUrl: null, jobId: null, statusUrl: null, status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Bounded poll of a previously-started job. Used at publish time; the job is
// normally finished by then, so the first status fetch returns the poster.
export async function resumePosterJob(
  jobId: string,
  statusUrl: string | null,
  budgetMs: number,
): Promise<{ imageUrl: string | null; status: PosterStatus }> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) return { imageUrl: null, status: "failed" };
  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const candidates = statusCandidates(endpoint, statusUrl, jobId);
  if (candidates.length === 0) return { imageUrl: null, status: "failed" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs + 5_000);
  const started = Date.now();
  let delay = 2000;
  try {
    while (Date.now() - started < budgetMs) {
      for (const url of candidates) {
        try {
          const resp = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
          if (!resp.ok) continue;
          const text = await resp.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = text; }
          const imageUrl = extractPosterImageUrl(data);
          if (imageUrl) return { imageUrl, status: "completed" };
          if (jobFailed(data)) return { imageUrl: null, status: "failed" };
        } catch (_err) {
          // try next candidate / next tick
        }
      }
      await sleep(delay);
      delay = Math.min(delay + 1500, 6000);
    }
  } finally {
    clearTimeout(timer);
  }
  return { imageUrl: null, status: "processing" };
}

// Download a poster and store it on our own user-assets bucket so the saved
// URL is permanent (Graphiste/source URLs may expire). Rejects SVGs and
// non-image content. Returns the public Supabase URL.
export async function rehostToUserAssets(
  supabase: any,
  imageUrl: string,
  userId: string,
): Promise<string> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (supabaseUrl && imageUrl.startsWith(supabaseUrl)) return imageUrl;

  let bytes: Uint8Array;
  let contentType = "image/png";
  if (imageUrl.startsWith("data:")) {
    const commaIdx = imageUrl.indexOf(",");
    if (commaIdx < 0) throw new Error("invalid data URL");
    const meta = imageUrl.slice(5, commaIdx);
    contentType = (meta.split(";")[0] || "image/png").trim().toLowerCase();
    if (contentType.includes("svg")) throw new Error("refusing SVG data URL");
    const payload = imageUrl.slice(commaIdx + 1);
    if (meta.includes(";base64")) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } else {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`image fetch ${resp.status}`);
    contentType = (resp.headers.get("content-type") || "image/png").toLowerCase();
    if (!contentType.startsWith("image/") || contentType.includes("svg")) {
      throw new Error(`unexpected content-type ${contentType}`);
    }
    bytes = new Uint8Array(await resp.arrayBuffer());
  }

  const ext = (contentType.split("/")[1] || "png").split(";")[0].replace(/[^a-z0-9]/gi, "") || "png";
  const path = `${userId}/auto-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("user-assets").upload(path, bytes, { contentType, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("user-assets").getPublicUrl(path);
  return data.publicUrl as string;
}
