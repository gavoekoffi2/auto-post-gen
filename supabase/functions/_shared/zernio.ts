// Shared Zernio client. Zernio (https://zernio.com) is a REST API that
// connects + publishes to LinkedIn, Facebook and 13 more networks behind a
// single API key. Per-user isolation is done with Zernio "profiles": we
// create one profile per app-user and connect their accounts under it.
//
// Secret (Supabase → Edge Functions → Secrets):
//   ZERNIO_API_KEY  — required. Format: sk_ + 64 hex chars.
//
// Auth: Authorization: Bearer <ZERNIO_API_KEY>. Base: https://zernio.com/api/v1

const ZERNIO_BASE = (Deno.env.get("ZERNIO_API_URL") || "https://zernio.com/api/v1").replace(/\/+$/, "");

export function getZernioKey(): string | null {
  return Deno.env.get("ZERNIO_API_KEY") || null;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const key = getZernioKey();
  if (!key) throw new Error("ZERNIO_API_KEY is not configured");
  return { Authorization: `Bearer ${key}`, ...extra };
}

export interface ZernioProfile {
  _id: string;
  name?: string;
  isDefault?: boolean;
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  profileUrl?: string;
  isActive?: boolean;
}

export async function zernioListProfiles(): Promise<ZernioProfile[]> {
  const r = await fetch(`${ZERNIO_BASE}/profiles`, { headers: headers() });
  if (!r.ok) throw new Error(`Zernio profiles ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d?.profiles || [];
}

// Returns the new profile id, or null when the plan's profile limit is hit
// (HTTP 402/403) so the caller can fall back to the default profile.
export async function zernioCreateProfile(name: string): Promise<string | null> {
  const r = await fetch(`${ZERNIO_BASE}/profiles`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.profile?._id || d?._id || null;
}

export async function zernioConnectUrl(platform: string, profileId: string): Promise<string> {
  const url = `${ZERNIO_BASE}/connect/${encodeURIComponent(platform)}?profileId=${encodeURIComponent(profileId)}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`Zernio connect ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (!d?.authUrl) throw new Error("Zernio n'a pas retourné d'URL d'autorisation");
  return d.authUrl as string;
}

export async function zernioListAccounts(profileId?: string | null): Promise<ZernioAccount[]> {
  const url = new URL(`${ZERNIO_BASE}/accounts`);
  if (profileId) url.searchParams.set("profileId", profileId);
  const r = await fetch(url.toString(), { headers: headers() });
  if (!r.ok) throw new Error(`Zernio accounts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d?.accounts || [];
}

export interface ZernioPublishInput {
  content: string;
  imageUrl?: string | null;
  platforms: Array<{ platform: string; accountId: string }>;
  requestId?: string; // sent as x-request-id for safe-retry idempotency
}

export interface ZernioPlatformResult {
  platform: string;
  status: "ok" | "pending" | "error";
  id?: string;
  externalId?: string;
  externalUrl?: string;
  error?: string;
}

function normaliseZernioStatus(value: unknown): ZernioPlatformResult["status"] {
  const status = String(value || "").toLowerCase();
  if (["published", "success", "succeeded", "completed", "complete", "ok"].includes(status)) return "ok";
  if (["queued", "processing", "scheduled", "pending", "created", "draft"].includes(status)) return "pending";
  return "error";
}

function extractZernioPlatformResults(data: any, requested: ZernioPublishInput["platforms"]): ZernioPlatformResult[] {
  const post = data?.post || data?.existingPost || data || {};
  const postId = post?._id || data?._id || data?.id;
  const platformRows = Array.isArray(post?.platforms) ? post.platforms : [];

  return requested.map((target) => {
    const row = platformRows.find((p: any) => {
      const platform = String(p?.platform || "").toLowerCase();
      const accountId = typeof p?.accountId === "string" ? p.accountId : p?.accountId?._id;
      return platform === target.platform.toLowerCase() && (!accountId || accountId === target.accountId);
    });
    if (!row && platformRows.length > 0) {
      return {
        platform: target.platform,
        status: "error",
        id: postId,
        error: `Zernio did not return a status for ${target.platform}`,
      };
    }
    const rawStatus = row?.status || post?.status;
    const status = normaliseZernioStatus(rawStatus);
    const externalId = row?.platformPostId || row?.externalId || row?.postId || postId;
    const externalUrl = row?.platformPostUrl || row?.externalUrl || row?.url;
    return {
      platform: target.platform,
      status,
      id: postId,
      externalId,
      externalUrl,
      error: status === "error" ? (row?.error || row?.message || data?.error || data?.message || `Zernio status: ${rawStatus || "unknown"}`) : undefined,
    };
  });
}

export async function zernioCreatePost(
  input: ZernioPublishInput,
): Promise<{ ok: boolean; id?: string; error?: string; results: ZernioPlatformResult[] }> {
  const body: Record<string, unknown> = {
    content: input.content,
    publishNow: true,
    platforms: input.platforms,
  };
  if (input.imageUrl) body.mediaItems = [{ url: input.imageUrl, type: "image" }];

  const h = headers({ "Content-Type": "application/json" });
  if (input.requestId) h["x-request-id"] = input.requestId;

  const r = await fetch(`${ZERNIO_BASE}/posts`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) {
    return {
      ok: false,
      error: `Zernio ${r.status}: ${t.slice(0, 250)}`,
      results: input.platforms.map((p) => ({ platform: p.platform, status: "error", error: `Zernio ${r.status}: ${t.slice(0, 250)}` })),
    };
  }
  let d: any = {};
  try {
    d = JSON.parse(t);
  } catch {
    /* empty 200 */
  }
  const id = d?.post?._id || d?._id || d?.existingPost?._id || d?.id;
  const results = extractZernioPlatformResults(d, input.platforms);
  const ok = results.some((result) => result.status === "ok");
  return { ok, id, results, error: ok ? undefined : results.map((result) => `${result.platform}: ${result.error || result.status}`).join("; ") };
}
