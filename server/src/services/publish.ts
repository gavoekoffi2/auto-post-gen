import { query, queryOne } from "../lib/db.js";
import { env } from "../lib/env.js";
import { readJob } from "./generation.js";
import { mediaAssetIdFromUrl, shareableMediaUrl } from "../lib/media.js";

// Publishing.
//
// The provider profile key is the tenant boundary on the provider's side: it
// decides WHICH social accounts a post reaches. A missing key therefore means
// "this account is not isolated", and publishing is refused — never allowed to
// fall through to a shared or default profile, which would send one user's
// posts to another user's social accounts.

export interface PublishResult {
  platform: string;
  status: "ok" | "pending" | "error" | "not_connected";
  message?: string;
  externalUrl?: string;
}

const MAX_PUBLISH_ATTEMPTS = 5;
const RETRY_BACKOFF_MINUTES = [15, 60, 240, 720];

function nextAttemptAt(attempts: number): string {
  const minutes =
    RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)] ??
    RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length - 1]!;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Turns a stored image URL into one the publishing provider can fetch.
 *
 * A relative /api/media/... URL is this server's own storage and is session
 * guarded, so it gets a capability token. Anything else is already absolute
 * and is passed through unchanged.
 */
async function publishableUrl(profileId: string, url: string): Promise<string> {
  const assetId = mediaAssetIdFromUrl(url);
  if (!assetId) return url;
  if (!env.appPublicUrl) {
    // Without a public base URL there is no absolute link to hand over. Going
    // out text-only is wrong, so say it rather than sending an unfetchable
    // relative path the provider will silently drop.
    throw new Error("APP_PUBLIC_URL is required to publish a locally stored image");
  }
  return (await shareableMediaUrl(profileId, url)) ?? url;
}

function normalisePlatform(label: string): string {
  const map: Record<string, string> = {
    Instagram: "instagram",
    Facebook: "facebook",
    Twitter: "twitter",
    "Twitter (X)": "twitter",
    X: "twitter",
    LinkedIn: "linkedin",
  };
  return map[label] ?? label.toLowerCase();
}

/**
 * Publishes one post.
 *
 * The post is claimed atomically (validated → publishing) so a concurrent
 * cron run and a manual click cannot both post it.
 */
export async function publishPost(profileId: string, postId: string): Promise<PublishResult[]> {
  const claimed = await queryOne<{
    id: string;
    content: string;
    platforms: string[];
    image_url: string | null;
    image_job_id: string | null;
    publish_attempts: number;
  }>(
    `UPDATE posts
        SET status = 'publishing', publishing_started_at = now()
      WHERE id = $1 AND profile_id = $2 AND status = 'validated'
      RETURNING id, content, platforms, image_url, image_job_id, publish_attempts`,
    [postId, profileId],
  );
  // Someone else is already publishing it, or it is not in a publishable
  // state. Skipping is correct: re-claiming would risk a double post.
  if (!claimed) return [];

  // A poster that was still rendering when the post was queued is settled
  // here, before the content goes out. Publishing without it meant a
  // scheduled post went out text-only — and on a network that requires media,
  // failed outright — while a finished poster sat unattached in its job row.
  let imageUrl = claimed.image_url;
  if (!imageUrl && claimed.image_job_id) {
    try {
      const job = await readJob(profileId, claimed.image_job_id);
      if (job?.status === "completed" && job.result_url) imageUrl = job.result_url;
    } catch (err) {
      // Best-effort: the post still publishes, with whatever it has.
      console.error(`[publish] could not resume poster for ${postId}:`, (err as Error).message);
    }
  }

  // A re-hosted poster lives behind a session, which the provider does not
  // have. Mint (or reuse) a capability token for exactly that asset so it can
  // fetch the image it is asked to attach, and nothing else.
  //
  // Failing here must not throw: the post is already claimed ('publishing'),
  // and a throw left it there until crash recovery re-queued it — to fail the
  // same way, forever. It is recorded as a failed attempt instead.
  let publishableImageUrl: string | null = null;
  let imageError: string | null = null;
  if (imageUrl) {
    try {
      publishableImageUrl = await publishableUrl(profileId, imageUrl);
    } catch (err) {
      console.error(`[publish] image not shareable for ${postId}:`, (err as Error).message);
      imageError =
        "L'image de la publication ne peut pas être transmise au réseau social : " +
        "l'adresse publique du site (APP_PUBLIC_URL) n'est pas configurée sur le serveur.";
    }
  }

  const connection = await queryOne<{ provider_profile_key: string | null }>(
    `SELECT provider_profile_key FROM social_connections
      WHERE profile_id = $1 AND provider = 'zernio' AND is_active
      LIMIT 1`,
    [profileId],
  );

  const platforms = claimed.platforms ?? [];
  let results: PublishResult[];
  let providerPostId: string | null = null;

  if (imageError) {
    results = platforms.map((p) => ({
      platform: normalisePlatform(p),
      status: "error" as const,
      message: imageError!,
    }));
  } else if (!connection) {
    results = platforms.map((p) => ({
      platform: normalisePlatform(p),
      status: "not_connected" as const,
      message: "Aucun réseau social connecté.",
    }));
  } else if (!connection.provider_profile_key) {
    // Refused rather than published through a shared profile: without a
    // profile key this account is not isolated on the provider's side.
    results = platforms.map((p) => ({
      platform: normalisePlatform(p),
      status: "error" as const,
      message:
        "Connexion sociale incomplète (profil fournisseur manquant). Reconnectez vos réseaux.",
    }));
  } else if (!env.zernioKey) {
    results = platforms.map((p) => ({
      platform: normalisePlatform(p),
      status: "error" as const,
      message: "La publication sociale n'est pas configurée sur ce serveur (ZERNIO_API_KEY).",
    }));
  } else {
    ({ results, providerPostId } = await publishViaZernio(
      connection.provider_profile_key,
      platforms,
      claimed.content,
      publishableImageUrl,
      claimed.id,
    ));
  }

  const anyOk = results.some((r) => r.status === "ok");
  // Accepted by the provider but not yet confirmed by the network: it is out
  // of our hands, so it must never be sent again. It used to go back to the
  // queue ('validated') and be posted a second time at the next attempt. It
  // stays 'publishing' with the provider's post id recorded; crash recovery
  // (recover_stuck_publishing) turns such a row into 'published' after ten
  // minutes — never into a retry. Not 'published' now: the dashboard does
  // not claim a post exists on a network before the network says so.
  const accepted = !anyOk && results.some((r) => r.status === "pending");
  const allErrors = results.length > 0 && results.every((r) => r.status === "error");
  const attempts = (claimed.publish_attempts ?? 0) + 1;
  // After a bounded number of attempts the post becomes 'failed' and leaves
  // the queue. Without that, an unpublishable post is re-selected on every
  // tick and — because the batch is ordered oldest-first and capped — starves
  // every newer post behind it.
  const exhausted = attempts >= MAX_PUBLISH_ATTEMPTS;
  const status = anyOk
    ? "published"
    : accepted
      ? "publishing"
      : allErrors || exhausted
        ? "failed"
        : "validated";

  const externalIds: Record<string, string> = {};
  for (const r of results) {
    if (r.status === "ok" && r.externalUrl) externalIds[`${r.platform}_url`] = r.externalUrl;
  }

  await query(
    `UPDATE posts
        SET status = $3,
            publish_error = $4,
            publish_attempts = $5,
            next_publish_attempt_at = $6,
            external_post_ids = $7,
            published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END,
            provider_post_id = COALESCE($8, provider_post_id),
            publishing_started_at = CASE WHEN $3 = 'publishing' THEN publishing_started_at ELSE NULL END
      WHERE id = $1 AND profile_id = $2`,
    [
      postId,
      profileId,
      status,
      anyOk ? null : JSON.stringify(results),
      anyOk ? 0 : attempts,
      status === "validated" ? nextAttemptAt(attempts) : new Date().toISOString(),
      JSON.stringify(externalIds),
      providerPostId,
    ],
  );

  return results;
}

async function publishViaZernio(
  profileKey: string,
  platforms: string[],
  content: string,
  imageUrl: string | null,
  requestId: string,
): Promise<{ results: PublishResult[]; providerPostId: string | null }> {
  const none = (results: PublishResult[]) => ({ results, providerPostId: null });
  const base = env.zernioUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${env.zernioKey}`,
    "Content-Type": "application/json",
    "x-request-id": requestId,
  };

  try {
    // Scoped to this account's provider profile. Omitting it would list every
    // profile's accounts — i.e. other tenants' connected social accounts.
    const accountsUrl = new URL(`${base}/accounts`);
    accountsUrl.searchParams.set("profileId", profileKey);
    const accountsResponse = await fetch(accountsUrl, {
      headers: { Authorization: `Bearer ${env.zernioKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!accountsResponse.ok) {
      const detail = (await accountsResponse.text()).slice(0, 200);
      return none(platforms.map((p) => ({
        platform: normalisePlatform(p),
        status: "error" as const,
        message: `Impossible de lire les comptes connectés (${accountsResponse.status}). ${detail}`,
      })));
    }
    const accountsBody = (await accountsResponse.json()) as {
      accounts?: Array<{ _id: string; platform?: string; isActive?: boolean }>;
    };

    const results: PublishResult[] = [];
    const targets: Array<{ platform: string; accountId: string }> = [];
    for (const raw of platforms) {
      const platform = normalisePlatform(raw);
      const match = (accountsBody.accounts ?? []).find(
        (a) => (a.platform ?? "").toLowerCase() === platform && a.isActive !== false,
      );
      if (match) targets.push({ platform, accountId: match._id });
      else results.push({ platform, status: "not_connected" });
    }
    if (targets.length === 0) return none(results);

    const postResponse = await fetch(`${base}/posts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content,
        publishNow: true,
        platforms: targets,
        ...(imageUrl ? { mediaItems: [{ url: imageUrl, type: "image" }] } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await postResponse.text();
    if (!postResponse.ok) {
      const message = `Publication refusée (${postResponse.status}). ${text.slice(0, 200)}`;
      for (const t of targets) {
        results.push({ platform: t.platform, status: "error", message });
      }
      return none(results);
    }

    let parsed: { post?: { _id?: unknown; id?: unknown; platforms?: Array<Record<string, unknown>> } } = {};
    try { parsed = JSON.parse(text); } catch { /* an empty 200 is possible */ }
    const rows = parsed.post?.platforms ?? [];
    // Recorded so crash recovery (recover_stuck_publishing) knows this post
    // reached the provider and must not be sent again.
    const rawId = parsed.post?._id ?? parsed.post?.id;
    const providerPostId =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "accepted";

    for (const t of targets) {
      const row = rows.find(
        (r) => String(r.platform ?? "").toLowerCase() === t.platform,
      );
      const rawStatus = String(row?.status ?? "").toLowerCase();
      // "Accepted" is not "published": a queued job is reported as pending so
      // the dashboard never claims a post exists on a network before the
      // network says it does.
      if (["published", "success", "succeeded", "completed", "ok"].includes(rawStatus)) {
        results.push({
          platform: t.platform,
          status: "ok",
          ...(typeof row?.platformPostUrl === "string"
            ? { externalUrl: row.platformPostUrl }
            : {}),
        });
      } else if (
        !row ||
        ["queued", "processing", "scheduled", "pending", "created"].includes(rawStatus)
      ) {
        // No per-network row at all is still an accepted post (a 2xx).
        results.push({
          platform: t.platform,
          status: "pending",
          message: "Publication acceptée mais pas encore confirmée par le réseau.",
        });
      } else {
        results.push({
          platform: t.platform,
          status: "error",
          message: String(row?.error ?? row?.message ?? `Statut inattendu : ${rawStatus || "inconnu"}`),
        });
      }
    }
    return { results, providerPostId };
  } catch (err) {
    return none(platforms.map((p) => ({
      platform: normalisePlatform(p),
      status: "error" as const,
      message: `Publication indisponible : ${(err as Error).message}`,
    })));
  }
}
