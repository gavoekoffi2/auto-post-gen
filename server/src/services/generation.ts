import { queryOne, query } from "../lib/db.js";
import { env } from "../lib/env.js";
import { badRequest, notConfigured } from "../lib/errors.js";
import {
  deleteStoredFile,
  mediaUrl,
  readStoredFile,
  rehostRemoteImage,
  storeBuffer,
  type StoredFile,
} from "../lib/media.js";
import { composePoster, type PosterParts } from "./character.js";
import {
  CORNER_FR,
  NO_BRANDING,
  asCharacterOverlay,
  asLogoOverlay,
  loadBranding,
  posterLayout,
  shouldMirror,
  type CharacterOverlay,
  type LogoOverlay,
  type PosterBranding,
} from "./branding.js";
import { GESTURES } from "./poses.js";
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

// No default endpoint, deliberately.
//
// This used to fall back to a hardcoded *.supabase.co address, which meant an
// operator who set GRAPHISTE_GPT_API_KEY but not the URL silently sent every
// poster — company name, sector, brand colours, and any consented photo of a
// real person — to a Supabase project this deployment does not own. The
// endpoint is now configuration, and its absence is refused out loud below.

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
  /** The character this render was started with, laid on when it completes. */
  character_overlay?: CharacterOverlay | null;
  /** The logo this render was started with, laid on when it completes. */
  logo_overlay?: LogoOverlay | null;
}

export type { CharacterOverlay, LogoOverlay } from "./branding.js";

/** What is laid onto a finished render. */
interface Overlays {
  character: CharacterOverlay | null;
  logo: LogoOverlay | null;
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

  if (!env.graphisteUrl) {
    throw notConfigured(
      "L'adresse du service de génération d'affiches n'est pas configurée sur ce " +
        "serveur (GRAPHISTE_GPT_API_URL).",
    );
  }

  const spec = getSocialImageSpec(input.platforms);
  const endpoint = env.graphisteUrl;
  // The account's visual identity, read in one place for every poster: the
  // character and the pose that suits this message, the logo, the palette.
  const branding = await loadBranding(
    input.profileId,
    input.postId,
    input.postContent,
    input.contentCategory,
  );
  const overlays: Overlays = { character: branding.character, logo: branding.logo };

  // Only the LAYOUT is sent — which side to keep free, which corner the logo
  // takes, which gesture the character makes. The character's photo and the
  // logo file never leave this server: they are laid onto the finished
  // render exactly as uploaded. A renderer handed a photo as a "reference"
  // draws somebody else; handed a logo, it redraws it.
  const requestBody: Record<string, unknown> = {
    domain: "business",
    subject: buildSubject(input, spec, branding),
    title: input.postContent.split(/[.!?\n]/)[0]?.trim().slice(0, 70) || input.companyName,
    quality: "premium",
    reliability_mode: true,
    aspect_ratio: aspectRatio(spec),
    resolution: "2K",
    mode: "async",
  };
  if (branding.palette.length) requestBody.colors = branding.palette.map((c) => c.hex);
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

  if (failure) return recordJob(input, "failed", { error: failure, format, overlays });

  const direct = extractImageUrl(payload);
  if (direct) {
    return recordJob(input, "completed", {
      resultUrl: (await persistPoster(input.profileId, direct, overlays)).url,
      format,
      overlays,
    });
  }

  const providerJobId = extractJobId(payload);
  const statusUrl = safeGraphisteStatusUrl(extractStatusUrl(payload));
  if (providerJobId || statusUrl) {
    return recordJob(input, "processing", { providerJobId, statusUrl, format, overlays });
  }

  return recordJob(input, "failed", {
    error: "Graphiste GPT n'a retourné ni affiche ni identifiant de tâche.",
    format,
    overlays,
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
async function persistPoster(
  profileId: string,
  remoteUrl: string,
  overlays: Overlays = { character: null, logo: null },
): Promise<{ url: string; assetId: string | null }> {
  try {
    let stored = await rehostRemoteImage(profileId, remoteUrl);
    stored = await applyOverlays(profileId, stored, overlays);
    const asset = await queryOne<{ id: string }>(
      `INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
       VALUES ($1, 'poster', $2, $3, $4)
       RETURNING id`,
      [profileId, stored.storagePath, stored.mimeType, stored.sizeBytes],
    );
    if (asset) return { url: mediaUrl(asset.id), assetId: asset.id };
  } catch (err) {
    console.error("[generation] poster re-host failed:", (err as Error).message);
  }
  return { url: remoteUrl, assetId: null };
}

/** Removes a stored poster that ended up attached to nothing. */
async function discardPoster(profileId: string, assetId: string | null): Promise<void> {
  if (!assetId) return;
  const row = await queryOne<{ storage_path: string }>(
    `DELETE FROM media_assets WHERE id = $1 AND profile_id = $2 RETURNING storage_path`,
    [assetId, profileId],
  );
  if (row) await deleteStoredFile(row.storage_path);
}

/** An asset of this account, read back from storage; null if it is gone. */
async function readOwnAsset(profileId: string, assetId: string): Promise<Buffer | null> {
  const asset = await queryOne<{ storage_path: string }>(
    `SELECT storage_path FROM media_assets WHERE id = $1 AND profile_id = $2`,
    [assetId, profileId],
  );
  return asset ? readStoredFile(asset.storage_path) : null;
}

/** The logo file: this account's asset, or — for an older profile — an https URL. */
async function readLogo(profileId: string, logo: LogoOverlay): Promise<Buffer | null> {
  if (/^[0-9a-f-]{36}$/i.test(logo.source)) return readOwnAsset(profileId, logo.source);
  // Fetched through the same guarded path as a poster, then discarded.
  const copy = await rehostRemoteImage(profileId, logo.source);
  try {
    return await readStoredFile(copy.storagePath);
  } finally {
    await deleteStoredFile(copy.storagePath);
  }
}

/**
 * Lays the account's character and logo onto a stored poster.
 *
 * Never fails the render: the poster was paid for, so if something cannot be
 * applied (image deleted meanwhile, unreadable file) the rest is still
 * applied, the poster is kept, and the reason is logged.
 */
export async function applyOverlays(
  profileId: string,
  poster: StoredFile,
  overlays: Overlays,
): Promise<StoredFile> {
  const parts: PosterParts = {};
  if (overlays.character) {
    try {
      const image = await readOwnAsset(profileId, overlays.character.assetId);
      if (image) {
        parts.character = {
          image,
          position: overlays.character.position,
          mirror: shouldMirror(overlays.character.position, overlays.character.facing),
        };
      }
    } catch (err) {
      console.error("[generation] character not applied:", (err as Error).message);
    }
  }
  if (overlays.logo) {
    try {
      const image = await readLogo(profileId, overlays.logo);
      if (image) parts.logo = { image, corner: overlays.logo.corner };
    } catch (err) {
      console.error("[generation] logo not applied:", (err as Error).message);
    }
  }
  if (!parts.character && !parts.logo) return poster;
  try {
    const composed = await composePoster(await readStoredFile(poster.storagePath), parts);
    const stored = await storeBuffer(profileId, composed, "image/jpeg");
    await deleteStoredFile(poster.storagePath);
    return stored;
  } catch (err) {
    console.error("[generation] overlays not applied:", (err as Error).message);
    return poster;
  }
}

/** The character alone, laid onto a stored poster. */
export function applyCharacter(
  profileId: string,
  poster: StoredFile,
  character: CharacterOverlay,
): Promise<StoredFile> {
  return applyOverlays(profileId, poster, { character, logo: null });
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
    overlays?: Overlays;
  },
): Promise<JobRow> {
  // The columns up to `format` are exactly what the write probe in migration
  // 0000 mirrors; character_overlay (0007) and logo_overlay (0009) are
  // nullable.
  const row = await queryOne<JobRow>(
    `INSERT INTO generation_jobs
       (profile_id, post_id, kind, status, provider, provider_job_id,
        provider_status_url, result_url, error, format, character_overlay, logo_overlay)
     VALUES ($1, $2, 'image', $3, 'graphiste', $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, profile_id, post_id, kind, status, provider_job_id,
               provider_status_url, result_url, error, format, character_overlay, logo_overlay`,
    [
      input.profileId,
      input.postId,
      status,
      extra.providerJobId ?? null,
      extra.statusUrl ?? null,
      extra.resultUrl ?? null,
      extra.error ?? null,
      JSON.stringify(extra.format ?? null),
      extra.overlays?.character ? JSON.stringify(extra.overlays.character) : null,
      extra.overlays?.logo ? JSON.stringify(extra.overlays.logo) : null,
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
  const job = await loadJob(profileId, jobId);
  if (!job) return null;
  if (job.status !== "processing") return job;
  // Without both halves of the provider configuration there is nothing to ask.
  // The job keeps its current state rather than being declared failed: the
  // deployment is misconfigured, the render is not necessarily lost.
  if (!env.graphisteKey || !env.graphisteUrl) return job;

  const candidates: string[] = [];
  if (job.provider_job_id) {
    const base = env.graphisteUrl.replace(/\/generate\/?$/, "");
    candidates.push(`${base}/${encodeURIComponent(job.provider_job_id)}`);
  }
  // Re-checked here too: rows recorded before the check existed.
  const statusUrl = safeGraphisteStatusUrl(job.provider_status_url);
  if (statusUrl) candidates.push(statusUrl);

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
        const poster = await persistPoster(job.profile_id, imageUrl, {
          character: asCharacterOverlay(job.character_overlay),
          logo: asLogoOverlay(job.logo_overlay),
        });
        const settled = await settleJob(job, "completed", { resultUrl: poster.url });
        if (settled) return settled;
        // Another reader — a second tab, the publisher — completed this job
        // while we were copying it: theirs is the poster on record, ours
        // would be an orphan file nobody can see or delete.
        await discardPoster(job.profile_id, poster.assetId);
        return (await loadJob(profileId, jobId)) ?? job;
      }
      if (jobFailed(data)) {
        const settled = await settleJob(job, "failed", {
          error: "Graphiste GPT a signalé l'échec de cette génération.",
        });
        return settled ?? (await loadJob(profileId, jobId)) ?? job;
      }
      break;
    } catch {
      // Try the next candidate; a transient read failure is not a failed job.
    }
  }

  return job;
}

function loadJob(profileId: string, jobId: string): Promise<JobRow | null> {
  return queryOne<JobRow>(
    `SELECT id, profile_id, post_id, kind, status, provider_job_id,
            provider_status_url, result_url, error, format, character_overlay, logo_overlay
       FROM generation_jobs WHERE id = $1 AND profile_id = $2`,
    [jobId, profileId],
  );
}

/**
 * Moves a processing job to its final state — only if it is still
 * processing. Returns null when another reader settled it first: concurrent
 * polls (two tabs, the publisher) must not both write a result and both
 * point the post at their own copy.
 */
async function settleJob(
  job: JobRow,
  status: "completed" | "failed",
  extra: { resultUrl?: string; error?: string },
): Promise<JobRow | null> {
  const row = await queryOne<JobRow>(
    `UPDATE generation_jobs
        SET status = $2, result_url = $3, error = $4
      WHERE id = $1 AND status = 'processing'
      RETURNING id, profile_id, post_id, kind, status, provider_job_id,
                provider_status_url, result_url, error, format, character_overlay, logo_overlay`,
    [job.id, status, extra.resultUrl ?? null, extra.error ?? null],
  );
  if (!row) return null;

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

  return row;
}

/**
 * A provider status URL, resolved against the configured endpoint and kept
 * only if it is on that same origin.
 *
 * The status read carries the API key. The URL comes from a response body,
 * so a status URL on any other host would hand the key to that host.
 */
export function safeGraphisteStatusUrl(raw: string | null | undefined): string | null {
  if (!raw || !env.graphisteUrl) return null;
  try {
    const base = new URL(env.graphisteUrl);
    const url = new URL(raw, base);
    return url.origin === base.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Upper bound of the prompt ("subject") sent to the poster provider. */
export const SUBJECT_MAX_LENGTH = 1800;

const IMAGE_STYLES: Record<string, string> = {
  photorealistic: "photographie ultra-réaliste",
  illustration: "illustration dessinée",
  minimalist: "visuel minimaliste et épuré",
  corporate: "style corporate, sobre et professionnel",
  flat_design: "flat design vectoriel",
};

const PEOPLE: Record<string, string> = {
  african: "des personnes africaines/noires professionnelles",
  caucasian: "des personnes caucasiennes professionnelles",
};

export function buildSubject(
  input: PosterRequest,
  spec: { label: string; orientation: string },
  branding: PosterBranding = NO_BRANDING,
): string {
  const isPromo = input.contentCategory === "promo";
  const character = branding.character;
  const characterSide = character?.position ?? null;
  const layout = posterLayout(characterSide);
  const footerCorner = CORNER_FR[layout.footer];
  const brandCorner = CORNER_FR[layout.brand];
  const freeSide = characterSide === "left" ? "droit" : "gauche";
  const characterSideFr = characterSide === "left" ? "gauche" : "droite";

  const footer = input.footerText.trim()
    ? `Texte permanent utilisateur : écris le texte exact "${input.footerText.trim().slice(0, 120)}" ` +
      `dans l'angle ${footerCorner}, dans un cartouche élégant à fort contraste. Ne le reformule pas.`
    : `L'utilisateur n'a défini aucun message permanent : n'ajoute aucun texte dans l'angle ${footerCorner}.`;
  // The real photo is added afterwards; the renderer composes the scene
  // around the gesture that photo makes.
  const characterZone = character
    ? `Zone réservée : la vraie photo détourée d'une personne sera ajoutée après coup au premier plan, ` +
      `debout sur le bord bas, côté ${characterSideFr} (environ 45 % de la largeur et les deux tiers ` +
      `inférieurs de la hauteur). Dans cette zone, seulement le décor de fond : ni texte, ni logo, ni ` +
      `visage. Cette personne ${GESTURES[character.gesture].scene} : compose la scène en conséquence. ` +
      `Place l'accroche et les textes du côté ${freeSide}. Ne représente aucune autre personne au premier plan.`
    : null;
  const brand = branding.logo
    ? `Logo : laisse l'angle ${brandCorner} dégagé (environ un cinquième de la largeur) : le logo officiel ` +
      `y sera apposé tel quel après coup. Ne dessine aucun logo et n'invente aucune marque.`
    : `Identité de marque : écris le nom exact "${input.companyName.slice(0, 80)}" comme signature de ` +
      `marque discrète dans l'angle ${brandCorner}, petite mais lisible.`;
  const palette = branding.palette.length
    ? `Charte graphique à respecter strictement : ` +
      branding.palette.map((c) => `${c.role} ${c.hex}`).join(", ") +
      `. Utilise ces couleurs pour les fonds, les formes, les titres et les éléments graphiques, ` +
      `avec un texte lisible à fort contraste.` +
      (branding.font ? ` Titres dans le style de la police ${branding.font}.` : "")
    : null;
  const style = branding.imageStyle && IMAGE_STYLES[branding.imageStyle]
    ? `Style visuel : ${IMAGE_STYLES[branding.imageStyle]}.`
    : null;

  // The prompt has a hard budget. It used to be sliced at the END, which
  // silently dropped the brand placement and the prohibitions (fake text,
  // watermarks) whenever the post or the activity description was long —
  // and, with a character, the reserved zone. Every instruction is now kept
  // whole; only the source message, which the poster merely illustrates,
  // gives way.
  const MESSAGE_MARKER = "\u0000message\u0000";
  const lines = [
    isPromo
      ? `Affiche publicitaire professionnelle premium pour les réseaux sociaux (${spec.label}).`
      : `Visuel éditorial professionnel premium pour les réseaux sociaux (${spec.label}).`,
    [input.sector ? `Secteur : ${input.sector.slice(0, 80)}` : null,
     input.description ? `Activité : ${input.description.slice(0, 220)}` : null]
      .filter(Boolean).join(". "),
    `Le visuel doit être complémentaire au texte, pas une copie intégrale : transforme l'idée ` +
      `centrale en une scène ou une composition claire. Message source : ${MESSAGE_MARKER}`,
    `Composition : visuel complet, accroche courte et très lisible, hiérarchie visuelle forte, ` +
      `éclairage cinématographique, mise en page moderne de bord à bord.`,
    style,
    palette,
    isPromo
      ? `Appel à l'action commercial clair.`
      : `N'invente aucun appel à l'action commercial, prix ou offre : ne transforme pas le visuel en publicité.`,
    characterZone,
    footer,
    brand,
    `Interdictions : pas de petit texte illisible, pas de fausses lettres, pas de watermark, ` +
      `pas d'élément d'interface, pas d'image vide.`,
    character
      ? null
      : `Si des personnes sont représentées, privilégier ${PEOPLE[branding.peopleType ?? ""] ?? PEOPLE.african}.`,
  ].filter(Boolean).join("\n");

  const room = Math.max(120, SUBJECT_MAX_LENGTH - (lines.length - MESSAGE_MARKER.length));
  const message = input.postContent.replace(/\s+/g, " ").trim();
  const clipped = message.length > room ? `${message.slice(0, room - 1).trimEnd()}…` : message;
  // A replacer function: a string replacement would expand "$&" or "$'" typed in the post.
  return lines.replace(MESSAGE_MARKER, () => clipped).slice(0, SUBJECT_MAX_LENGTH);
}
