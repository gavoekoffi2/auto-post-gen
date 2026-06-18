// deno-lint-ignore-file no-explicit-any
//
// generate-image: image-only generation. Split from generate-content so
// the frontend can show the text instantly (text gen is fast) and
// asynchronously fill in the image (image gen is slow). Also used as
// the "regenerate image" endpoint from the dashboard.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { getSocialImageSpec, type SocialImageSpec } from "../_shared/socialImageSpecs.ts";
// Image generation for Pro Social AI must produce real poster layouts.
// Keep this endpoint dedicated to Graphiste GPT poster output rather than
// generic image providers. The chosen output format always follows the post's
// target platforms (see _shared/socialImageSpecs.ts) so a LinkedIn post never
// comes back as a TikTok-shaped image and vice-versa.

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

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitWords(value: string, maxWords: number): string[] {
  return value
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\n\r]+/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, maxWords);
}

function wrapSvgLine(words: string[], maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
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

// The sub-message under the headline: the post text with any "Titre:" label and
// the headline itself removed, so the poster never prints the title twice.
function bodyFromPost(postContent: string, title: string): string {
  let text = postContent.replace(/(?:titre|title)\s*[:：-]\s*/i, " ");
  if (title) text = text.split(title).join(" ");
  return text.replace(/\s+/g, " ").replace(/^[\s.,;:!?–-]+/, "").trim();
}

interface PosterLayout {
  pad: number;
  eyebrow: number;
  title: number;
  titleLines: number;
  body: number;
  bodyLines: number;
  bodyWords: number;
  cta: number;
  badge: number;
  footer: number;
}

// Every font size is clamped to a readable minimum (>= 20px on the output
// canvas) so the fallback poster never degrades into the tiny, illegible text
// that AI image models tend to produce. Sizes scale with the canvas width and
// adapt per orientation so the same renderer fills a 1200x627 LinkedIn banner
// and a 1080x1920 TikTok story without overflowing.
function posterLayout(spec: SocialImageSpec): PosterLayout {
  const w = spec.width;
  const px = (factor: number, min: number) => Math.max(Math.round(w * factor), min);
  switch (spec.orientation) {
    case "story":
      return { pad: px(0.075, 60), eyebrow: px(0.030, 26), title: px(0.094, 60), titleLines: 4, body: px(0.036, 26), bodyLines: 3, bodyWords: 26, cta: px(0.042, 32), badge: px(0.027, 22), footer: px(0.022, 20) };
    case "portrait":
      return { pad: px(0.072, 56), eyebrow: px(0.028, 26), title: px(0.086, 56), titleLines: 4, body: px(0.034, 24), bodyLines: 3, bodyWords: 24, cta: px(0.040, 30), badge: px(0.026, 22), footer: px(0.021, 20) };
    case "landscape":
      return { pad: px(0.050, 40), eyebrow: px(0.023, 22), title: px(0.052, 44), titleLines: 2, body: px(0.024, 20), bodyLines: 1, bodyWords: 14, cta: px(0.030, 28), badge: px(0.022, 22), footer: px(0.019, 20) };
    default: // square
      return { pad: px(0.070, 56), eyebrow: px(0.028, 26), title: px(0.080, 54), titleLines: 3, body: px(0.032, 24), bodyLines: 3, bodyWords: 22, cta: px(0.038, 30), badge: px(0.026, 22), footer: px(0.021, 20) };
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

// Premium, dimension-aware poster used both as the robust fallback when the AI
// poster service is unavailable and as a guaranteed correctly-sized output. It
// renders a real marketing composition: brand gradient, depth lighting, a
// company badge, a platform/format badge, an eyebrow, a large readable
// headline, an accent rule, a short readable sub-message and a CTA pill. Text
// is drawn by us (never by an image model) so it stays sharp and legible.
function buildProfessionalPosterSvgDataUrl(params: {
  postContent: string;
  companyName: string;
  sector: string;
  primary: string;
  secondary: string;
  accent: string;
  spec: SocialImageSpec;
}): string {
  const p = safeColor(params.primary, "#111827");
  const s = safeColor(params.secondary, "#2563EB");
  const a = safeColor(params.accent, "#F59E0B");
  const { spec } = params;
  const W = spec.width;
  const H = spec.height;
  const L = posterLayout(spec);
  const tall = spec.orientation === "story" || spec.orientation === "portrait";

  const contentW = W - L.pad * 2;
  const charsPerLine = (fontSize: number) =>
    Math.max(8, Math.floor(contentW / (fontSize * 0.56)));

  const titleText = titleFromPost(params.postContent, params.companyName);
  const title = wrapSvgLine(splitWords(titleText, 14), charsPerLine(L.title), L.titleLines);
  const body = wrapSvgLine(
    splitWords(bodyFromPost(params.postContent, titleText), L.bodyWords),
    charsPerLine(L.body),
    L.bodyLines,
  );
  const cta = escapeSvgText(ctaFromPost(params.postContent));
  const company = escapeSvgText((params.companyName || "Votre entreprise").slice(0, 38).toUpperCase());
  const sector = escapeSvgText((params.sector || "Service professionnel").slice(0, 34));
  const formatBadge = escapeSvgText(`${spec.label} · ${W}×${H}`);

  // Collision-free top-down flow: each block sits below the previous one, then
  // the CTA + footer are pinned near the bottom without ever overlapping the
  // body. Works for a short 1200x627 banner and a tall 1080x1920 story alike.
  const badgeH = Math.round(L.badge * 2.0);
  const eyebrowY = L.pad + badgeH + Math.round(H * 0.045) + L.eyebrow;
  const titleLineH = Math.round(L.title * 1.08);
  const titleTop = eyebrowY + Math.round(L.eyebrow * 0.8) + L.title;
  const titleNodes = title
    .map((line, i) => `<text x="${L.pad}" y="${titleTop + i * titleLineH}" font-size="${L.title}" font-weight="900" fill="#ffffff" letter-spacing="-1.5">${escapeSvgText(line)}</text>`)
    .join("\n  ");
  const titleBottom = titleTop + (title.length - 1) * titleLineH;
  const ruleY = titleBottom + Math.round(L.title * 0.42);
  const ruleH = Math.max(8, Math.round(L.title * 0.13));
  const bodyLineH = Math.round(L.body * 1.34);
  const bodyTop = ruleY + ruleH + Math.round(L.body * 1.3) + L.body;
  const bodyNodes = body
    .map((line, i) => `<text x="${L.pad}" y="${bodyTop + i * bodyLineH}" font-size="${L.body}" font-weight="600" fill="#F1F5F9" opacity="0.94">${escapeSvgText(line)}</text>`)
    .join("\n  ");
  const bodyBottom = bodyTop + Math.max(0, body.length - 1) * bodyLineH;

  const footerBaseline = H - Math.round(L.pad * 0.8);
  const ctaH = Math.round(L.cta * 2.0);
  const ctaW = Math.min(contentW, Math.round(cta.length * L.cta * 0.66) + L.cta * 2.6);
  // Keep the CTA below the body, drop it toward the lower third on tall canvases,
  // and never let it run into the footer line.
  const maxCtaTop = footerBaseline - L.footer - Math.round(L.footer) - ctaH;
  const ctaTop = Math.min(
    maxCtaTop,
    Math.max(bodyBottom + Math.round(L.cta), tall ? Math.round(H * 0.76) : 0),
  );
  const ctaTextY = ctaTop + Math.round(ctaH * 0.64);

  // Decorative geometry scaled to the canvas.
  const spotR = Math.round(Math.max(W, H) * 0.42);
  const orbR = Math.round(W * 0.36);
  const ringR = Math.round(W * 0.13);
  const ringCx = W - L.pad - ringR;
  const ringCy = Math.round(H * 0.5);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p}"/>
      <stop offset="52%" stop-color="${s}"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="spot" cx="78%" cy="22%" r="60%">
      <stop offset="0%" stop-color="${a}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${a}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#020617" stop-opacity="0"/>
      <stop offset="58%" stop-color="#020617" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0.66"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${Math.round(L.cta * 0.4)}" stdDeviation="${Math.round(L.cta * 0.5)}" flood-color="#000000" flood-opacity="0.30"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="${W - Math.round(W * 0.1)}" cy="${Math.round(H * 0.16)}" r="${spotR}" fill="url(#spot)"/>
  <circle cx="${Math.round(W * 0.92)}" cy="${Math.round(H * 0.9)}" r="${orbR}" fill="#ffffff" opacity="0.07"/>
  <circle cx="${ringCx}" cy="${ringCy}" r="${ringR}" fill="none" stroke="#ffffff" stroke-width="${Math.round(L.badge * 0.5)}" opacity="0.16"/>
  <rect width="${W}" height="${H}" fill="url(#scrim)"/>
  <rect x="${Math.round(L.pad * 0.55)}" y="${Math.round(L.pad * 0.55)}" width="${W - Math.round(L.pad * 1.1)}" height="${H - Math.round(L.pad * 1.1)}" rx="${Math.round(L.pad * 0.7)}" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.22"/>
  <g filter="url(#shadow)">
    <rect x="${L.pad}" y="${L.pad}" width="${Math.min(contentW, Math.round(company.length * L.badge * 0.62) + L.badge * 2)}" height="${badgeH}" rx="${Math.round(badgeH / 2)}" fill="#ffffff" opacity="0.97"/>
    <text x="${L.pad + Math.round(L.badge * 0.9)}" y="${L.pad + Math.round(badgeH * 0.64)}" font-size="${L.badge}" font-weight="900" fill="${p}" letter-spacing="0.5">${company}</text>
  </g>
  <rect x="${W - L.pad - (Math.round(formatBadge.length * L.badge * 0.56) + L.badge * 1.6)}" y="${L.pad}" width="${Math.round(formatBadge.length * L.badge * 0.56) + L.badge * 1.6}" height="${badgeH}" rx="${Math.round(badgeH / 2)}" fill="${a}" opacity="0.95"/>
  <text x="${W - L.pad - Math.round(L.badge * 0.8)}" y="${L.pad + Math.round(badgeH * 0.64)}" font-size="${Math.round(L.badge * 0.82)}" font-weight="800" fill="#111827" text-anchor="end">${formatBadge}</text>
  <text x="${L.pad}" y="${eyebrowY}" font-size="${L.eyebrow}" font-weight="800" fill="${a}" letter-spacing="${Math.round(L.eyebrow * 0.18)}">${sector.toUpperCase()}</text>
  ${titleNodes}
  <rect x="${L.pad}" y="${ruleY}" width="${Math.round(W * 0.12)}" height="${ruleH}" rx="${Math.max(4, Math.round(L.title * 0.065))}" fill="${a}"/>
  ${bodyNodes}
  <g filter="url(#shadow)">
    <rect x="${L.pad}" y="${ctaTop}" width="${ctaW}" height="${ctaH}" rx="${Math.round(ctaH / 2)}" fill="${a}"/>
    <text x="${L.pad + Math.round(ctaW / 2)}" y="${ctaTextY}" font-size="${L.cta}" font-weight="900" fill="#111827" text-anchor="middle">${cta}</text>
  </g>
  <text x="${L.pad}" y="${footerBaseline}" font-size="${L.footer}" font-weight="700" fill="#CBD5E1" opacity="0.85">${orientationLabel(spec.orientation)} · ${escapeSvgText((params.companyName || "Pro Social AI").slice(0, 30))}</text>
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
  spec: SocialImageSpec;
}): string {
  const businessContext = [
    `Entreprise: ${params.companyName || "Entreprise"}`,
    params.sector ? `Secteur: ${params.sector}` : null,
    params.description ? `Activité: ${params.description.slice(0, 260)}` : null,
  ].filter(Boolean).join("\n");

  const { spec } = params;
  const formatLine = `FORMAT CIBLE (obligatoire): ${spec.label} — ${spec.width}×${spec.height} px, orientation ${orientationLabel(spec.orientation)}. Composer toute l'affiche exactement dans ce cadrage, sans bandes vides ni recadrage.`;

  return `Créer une AFFICHE PUBLICITAIRE PROFESSIONNELLE complète en français pour les réseaux sociaux.

${businessContext}

${formatLine}

MESSAGE À TRANSFORMER EN AFFICHE:
${params.postContent.slice(0, 900)}

EXIGENCE PRINCIPALE:
- Ne pas générer une image vide, un simple fond, ou une affiche sans contenu.
- L'affiche doit contenir une vraie composition complète: titre principal lisible, visuel fort, blocs graphiques, hiérarchie claire, contraste premium.
- Qualité affiche de campagne premium: éclairage cinématographique, profondeur, hiérarchie visuelle forte, mise en page moderne et épurée.
- Le titre et le CTA doivent être GRANDS et parfaitement lisibles. Aucun petit texte illisible, aucune lettre aléatoire, aucun faux texte, aucun watermark, aucun élément d'interface.
- Ajouter 2 à 5 mots-clés courts issus du message, mais éviter les longs paragraphes.
- Prévoir un espace CTA visuel du type "Contactez-nous", "Réservez", "Découvrez", ou équivalent selon le message.
- Utiliser les affiches/templates internes Graphiste GPT comme inspiration professionnelle de structure, pas comme contrainte stricte.
- Si le message ne correspond pas parfaitement au domaine fourni, créer librement une affiche adaptée au message en appliquant les bonnes pratiques Graphiste GPT: hiérarchie forte, mise en page remplie, contraste, CTA, visuel central, équilibre typographique.

STYLE:
- Qualité premium, rendu publicitaire professionnel, moderne, non vide.
- Respecter strictement le format cible ci-dessus (${spec.width}×${spec.height} px) avec une composition remplie de bord à bord.
- Couleurs de marque à intégrer visiblement: primaire ${params.primary}, secondaire ${params.secondary}, accent ${params.accent}.
- Si des personnes sont représentées, privilégier des personnes africaines/noires professionnelles et crédibles.

DIRECTION (EN): Premium social media poster, high-end marketing campaign style, cinematic lighting, professional composition, strong visual hierarchy, modern clean layout, brand-consistent colors, large readable headline, clear CTA, no tiny unreadable text, no random letters, no watermark, no UI elements.

SORTIE ATTENDUE:
Une affiche finale complète, prête à publier, au format ${spec.width}×${spec.height} px, pas une image standard et pas un template vide.`;
}

async function tryGraphisteGptPoster(params: {
  postContent: string;
  sector: string;
  description: string;
  companyName: string;
  primary: string;
  secondary: string;
  accent: string;
  spec: SocialImageSpec;
}): Promise<{ imageUrl: string | null; warning: string | null }> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) return { imageUrl: null, warning: "GRAPHISTE_GPT_API_KEY not configured" };

  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const subject = `${params.companyName} — ${params.postContent} [Format ${params.spec.label} ${params.spec.width}x${params.spec.height}]`.slice(0, 600);
  const prompt = buildGraphistePosterPrompt(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
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
        waitForCompletion: false,
        async: true,
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
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      imageUrl: null,
      warning: isAbort
        ? "Graphiste GPT garde la génération ouverte trop longtemps et ne retourne pas d'URL finale avant la limite Supabase. Il faut un endpoint status/polling ou un vrai retour image synchrone côté Graphiste GPT."
        : `Graphiste GPT threw: ${message}`,
    };
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
    let platforms: string[] = Array.isArray(body?.platforms)
      ? body.platforms.map((x: unknown) => String(x)).filter(Boolean).slice(0, 12)
      : [];

    if (!postContent) {
      return new Response(
        JSON.stringify({ error: "postContent is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // If the caller didn't pass platforms but referenced an existing post,
    // read them from the row so the output format still matches the post's
    // targets (e.g. regenerating the image of a TikTok post).
    if (platforms.length === 0 && postId) {
      const { data: postRow } = await supabase
        .from("posts")
        .select("platforms")
        .eq("id", postId)
        .eq("user_id", userId)
        .maybeSingle();
      if (Array.isArray(postRow?.platforms)) {
        platforms = postRow.platforms.map((x: unknown) => String(x)).filter(Boolean);
      }
    }

    // One coherent output format for the whole post, derived from its targets.
    const spec = getSocialImageSpec(platforms);

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
      spec,
    });
    if (graphiste.warning) console.warn("Graphiste GPT unavailable:", graphiste.warning);

    const rawImageUrl = graphiste.imageUrl;
    const lastError = graphiste.warning;
    let imageUrl: string | null = rawImageUrl;

    let usedFallback = false;
    if (!imageUrl) {
      console.warn("Graphiste GPT poster generation failed, using dynamic professional poster fallback:", lastError);
      imageUrl = buildProfessionalPosterSvgDataUrl({
        postContent,
        companyName: profile?.company_name || "Entreprise",
        sector,
        primary,
        secondary,
        accent,
        spec,
      });
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
        provider: usedFallback ? "professional-poster-fallback" : "graphiste-gpt",
        warning: usedFallback ? lastError : undefined,
        format: {
          width: spec.width,
          height: spec.height,
          label: spec.label,
          orientation: spec.orientation,
          platforms: spec.platforms,
        },
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
