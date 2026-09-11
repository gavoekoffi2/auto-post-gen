import { queryOne, query } from "../lib/db.js";
import { env } from "../lib/env.js";
import { badRequest, notConfigured } from "../lib/errors.js";
import { mediaUrl, rehostRemoteImage } from "../lib/media.js";
import { getSocialImageSpec } from "../shared/socialImageSpecs.js";
import {
  extractImageUrl,
  extractJobId,
  extractStatusUrl,
  jobFailed,
} from "../shared/graphisteParse.js";

// Poster generation.
//
// Three rules shape this module, and they are the ones that matter:
//
//   1. A slow render is a JOB, not a long request. The provider is asked in
//      async mode and we return `processing` with a job id; the client polls.
//      Nothing here holds a connection open for minutes.
//   2. Polling a job NEVER starts a new render. The status route reads the
//      job row and, at most, asks the provider for that same job's state.
//      This is what stops a page reload from billing a second generation.
//   3. A render that did not happen is reported as failed, with the
//      provider's own reason. There is no local SVG, no placeholder, and no
//      "fallback visual" dressed up as a successful AI generation.

const GRAPHISTE_DEFAULT_URL =
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

const GRAPHISTE_RATIOS = new Set([
  "9:16", "16:9", "1:1", "4:5", "5:4", "1.91:1", "4:3", "3:4", "2:3", "3:2",
]);

export interface JobRow {
  id: string;
  profile_id: string;
  post_id: string | null;
  kind: "image" | "video";
  status: "processing" | "completed" | "failed";
  provider_job_id: string | null;
  provider_status_url: string | null;
  result_url: string | null;
  error: string | null;
  format: unknown;
}

/** Turns a provider HTTP failure into a message an operator can act on. */
export function graphisteErrorMessage(status: number, detail: string): string {
  const tail = detail.slice(0, 160);
  if (status === 401) {
    return `Clé Graphiste GPT invalide ou manquante (401). Vérifiez GRAPHISTE_GPT_API_KEY. ${tail}`;
  }
  if (status === 402) {
    return `Crédits Graphiste GPT insuffisants (402). Rechargez le compte puis réessayez. ${tail}`;
  }
  if (status === 403) return `Accès Graphiste GPT refusé (403). Vérifiez les droits de la clé. ${tail}`;
  if (status === 429) return `Trop de requêtes vers Graphiste GPT (429). Réessayez dans une minute. ${tail}`;
  if (status === 400) return `Requête refusée par Graphiste GPT (400) : ${tail}`;
  return `Graphiste GPT a échoué (${status}). Réessayez dans un instant. ${tail}`;
}

function aspectRatio(spec: { aspectRatio: string; orientation: string }): string {
  if (GRAPHISTE_RATIOS.has(spec.aspectRatio)) return spec.aspectRatio;
  switch (spec.orientation) {
    case "story": return "9:16";
    case "portrait": return "4:5";
    case "landscape": return "16:9";
    default: return "1:1";
  }
}

/** Pulls the provider's job handle out of its response envelope. */

export interface PosterRequest {
  profileId: string;
  postId: string;
  postContent: string;
  contentCategory: "value" | "research" | "promo";
  platforms: string[];
  companyName: string;
  sector: string;
  description: string;
  footerText: string;
  colors: string[];
  logoUrl: string | null;
  /**
   * A photograph of a real person to include. Only ever set when the account
   * has recorded explicit consent — see startPosterJob.
   */
  leaderPhotoUrl?: string | null;
}

/**
 * Starts a poster render and records the job.
 *
 * Returns the job row. When the provider answers immediately, the job is
 * already `completed`; otherwise it is `processing` and the client polls.
 */
export async function startPosterJob(input: PosterRequest): Promise<JobRow> {
  if (!env.graphisteKey) {
    // Named secret, so an operator can fix the deployment without reading
    // the code — and the user is told the feature is unavailable rather than
    // being handed a placeholder image.
    throw notConfigured(
      "La génération d'affiches n'est pas configurée sur ce serveur (GRAPHISTE_GPT_API_KEY).",
    );
  }

  // A photo of a real person may only leave this server with recorded,
  // explicit consent. The check is here — at the point the image would be
  // transmitted — rather than in the UI, so no caller can skip it.
  if (input.leaderPhotoUrl) {
    const consent = await queryOne<{ leader_photo_consent_at: Date | null }>(
      `SELECT leader_photo_consent_at FROM profiles WHERE id = $1`,
      [input.profileId],
    );
    if (!consent?.leader_photo_consent_at) {
      throw badRequest(
        "L'envoi d'une photo de dirigeant nécessite un consentement explicite. " +
          "Activez-le dans votre profil avant de générer une affiche avec une photo.",
        "consent_required",
      );
    }
  }

  const spec = getSocialImageSpec(input.platforms);
  const endpoint = env.graphisteUrl ?? GRAPHISTE_DEFAULT_URL;

  const requestBody: Record<string, unknown> = {
    domain: "business",
    subject: buildSubject(input, spec),
    title: input.postContent.split(/[.!?\n]/)[0]?.trim().slice(0, 70) || input.companyName,
    quality: "premium",
    reliability_mode: true,
    aspect_ratio: aspectRatio(spec),
    resolution: "2K",
    mode: "async",
  };
  if (input.colors.length) requestBody.colors = input.colors;
  if (input.logoUrl) requestBody.logo_urls = [input.logoUrl];
  if (input.leaderPhotoUrl) requestBody.reference_image_urls = [input.leaderPhotoUrl];

  const format = {
    label: spec.label,
    aspectRatio: aspectRatio(spec),
    resolution: "2K",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let payload: unknown = null;
  let failure: string | null = null;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.graphisteKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!response.ok) failure = graphisteErrorMessage(response.status, text);
  } catch (err) {
    failure = (err as Error).name === "AbortError"
      ? "Graphiste GPT n'a pas répondu dans le délai imparti. Réessayez dans un instant."
      : `Graphiste GPT inaccessible : ${(err as Error).message}`;
  } finally {
    clearTimeout(timer);
  }

  if (failure) return recordJob(input, "failed", { error: failure, format });

  const direct = extractImageUrl(payload);
  if (direct) {
    return recordJob(input, "completed", {
      resultUrl: await persistPoster(input.profileId, direct),
      format,
    });
  }

  const providerJobId = extractJobId(payload);
  const statusUrl = extractStatusUrl(payload);
  if (providerJobId || statusUrl) {
    return recordJob(input, "processing", { providerJobId, statusUrl, format });
  }

  return recordJob(input, "failed", {
    error: "Graphiste GPT n'a retourné ni affiche ni identifiant de tâche.",
    format,
  });
}

/**
 * Copies a finished poster into this account's own media storage.
 *
 * The renderer's URLs expire, so persisting one meant the poster silently
 * vanished from the dashboard and from the post days later — including from
 * posts scheduled for after it expired. Best-effort: if the copy fails the
 * provider URL is kept, which is worse but still better than losing the render
 * we already paid for.
 */
async function persistPoster(profileId: string, remoteUrl: string): Promise<string> {
  try {
    const stored = await rehostRemoteImage(profileId, remoteUrl);
    const asset = await queryOne<{ id: string }>(
      `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
       VALUES ($1, 'poster', $2, $3, $4)
       RETURNING id`,
      [profileId, stored.storagePath, stored.mimeType, stored.sizeBytes],
    );
    if (asset) return mediaUrl(asset.id);
  } catch (err) {
    console.error("[generation] poster re-host failed:", (err as Error).message);
  }
  return remoteUrl;
}

async function recordJob(
  input: PosterRequest,
  status: JobRow["status"],
  extra: {
    providerJobId?: string | null;
    statusUrl?: string | null;
    resultUrl?: string | null;
    error?: string | null;
    format: unknown;
  },
): Promise<JobRow> {
  const row = await queryOne<JobRow>(
    `INSERT INTO generation_jobs
       (profile_id, post_id, kind, status, provider, provider_job_id,
        provider_status_url, result_url, error, format)
     VALUES ($1, $2, 'image', $3, 'graphiste', $4, $5, $6, $7, $8)
     RETURNING id, profile_id, post_id, kind, status, provider_job_id,
               provider_status_url, result_url, error, format`,
    [
      input.profileId,
      input.postId,
      status,
      extra.providerJobId ?? null,
      extra.statusUrl ?? null,
      extra.resultUrl ?? null,
      extra.error ?? null,
      JSON.stringify(extra.format ?? null),
    ],
  );
  if (!row) throw new Error("failed to record generation job");

  // Mirror the job onto the post so the dashboard can resume it after a
  // reload without having to remember a job id the page never stored.
  await query(
    `UPDATE posts
        SET image_job_id = $3,
            image_status = $4,
            image_url = COALESCE($5, image_url)
      WHERE id = $1 AND profile_id = $2`,
    [
      input.postId,
      input.profileId,
      status === "processing" ? row.id : null,
      status === "completed" ? "done" : status === "failed" ? "failed" : "processing",
      extra.resultUrl ?? null,
    ],
  );

  return row;
}

/**
 * Reads a job's current state, asking the provider only if it is still open.
 *
 * This is a STATUS READ. It never posts a new generation request, which is
 * what makes it safe for the client to call repeatedly and after a reload.
 */
export async function readJob(profileId: string, jobId: string): Promise<JobRow | null> {
  const job = await queryOne<JobRow>(
    `SELECT id, profile_id, post_id, kind, status, provider_job_id,
            provider_status_url, result_url, error, format
       FROM generation_jobs WHERE id = $1 AND profile_id = $2`,
    [jobId, profileId],
  );
  if (!job) return null;
  if (job.status !== "processing") return job;
  if (!env.graphisteKey) return job;

  const candidates: string[] = [];
  if (job.provider_job_id) {
    const base = (env.graphisteUrl ?? GRAPHISTE_DEFAULT_URL).replace(/\/generate\/?$/, "");
    candidates.push(`${base}/${encodeURIComponent(job.provider_job_id)}`);
  }
  if (job.provider_status_url) candidates.push(job.provider_status_url);

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${env.graphisteKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      // A 404 from one candidate route is not the state of the job: only a
      // successful read may declare it terminal.
      if (!response.ok) continue;
      const text = await response.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }

      const imageUrl = extractImageUrl(data);
      if (imageUrl) {
        return await settleJob(job, "completed", {
          resultUrl: await persistPoster(job.profile_id, imageUrl),
        });
      }
      if (jobFailed(data)) {
        return await settleJob(job, "failed", {
          error: "Graphiste GPT a signalé l'échec de cette génération.",
        });
      }
      break;
    } catch {
      // Try the next candidate; a transient read failure is not a failed job.
    }
  }

  return job;
}

async function settleJob(
  job: JobRow,
  status: "completed" | "failed",
  extra: { resultUrl?: string; error?: string },
): Promise<JobRow> {
  const row = await queryOne<JobRow>(
    `UPDATE generation_jobs
        SET status = $2, result_url = $3, error = $4
      WHERE id = $1
      RETURNING id, profile_id, post_id, kind, status, provider_job_id,
                provider_status_url, result_url, error, format`,
    [job.id, status, extra.resultUrl ?? null, extra.error ?? null],
  );

  if (job.post_id) {
    await query(
      `UPDATE posts
          SET image_status = $3,
              image_url = COALESCE($4, image_url),
              image_job_id = CASE WHEN $3 = 'processing' THEN image_job_id ELSE NULL END
        WHERE id = $1 AND profile_id = $2`,
      [
        job.post_id,
        job.profile_id,
        status === "completed" ? "done" : "failed",
        extra.resultUrl ?? null,
      ],
    );
  }

  return row ?? job;
}

function buildSubject(
  input: PosterRequest,
  spec: { label: string; orientation: string },
): string {
  const isPromo = input.contentCategory === "promo";
  const footer = input.footerText.trim()
    ? `Texte permanent utilisateur : écris le texte exact "${input.footerText.trim().slice(0, 120)}" ` +
      `dans l'angle inférieur gauche, dans un cartouche élégant à fort contraste. Ne le reformule pas.`
    : `L'utilisateur n'a défini aucun message permanent : n'ajoute aucun texte dans l'angle inférieur gauche.`;

  return [
    isPromo
      ? `Affiche publicitaire professionnelle premium pour les réseaux sociaux (${spec.label}).`
      : `Visuel éditorial professionnel premium pour les réseaux sociaux (${spec.label}).`,
    [input.sector ? `Secteur : ${input.sector}` : null,
     input.description ? `Activité : ${input.description.slice(0, 220)}` : null]
      .filter(Boolean).join(". "),
    `Le visuel doit être complémentaire au texte, pas une copie intégrale : transforme l'idée ` +
      `centrale en une scène ou une composition claire. Message source : ${input.postContent.slice(0, 700)}`,
    `Composition : visuel complet, accroche courte et très lisible, hiérarchie visuelle forte, ` +
      `éclairage cinématographique, mise en page moderne de bord à bord.`,
    isPromo
      ? `Appel à l'action commercial clair.`
      : `N'invente aucun appel à l'action commercial, prix ou offre : ne transforme pas le visuel en publicité.`,
    footer,
    `Identité de marque : place le logo fourni et/ou le nom exact "${input.companyName}" comme ` +
      `signature de marque discrète dans l'angle inférieur droit, petite mais lisible.`,
    `Interdictions : pas de petit texte illisible, pas de fausses lettres, pas de watermark, ` +
      `pas d'élément d'interface, pas d'image vide.`,
    `Si des personnes sont représentées, privilégier des personnes africaines/noires professionnelles.`,
  ].join("\n").slice(0, 1800);
}
