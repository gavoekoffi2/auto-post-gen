// Shared Postiz client. Postiz (https://postiz.com) is the open-source
// social scheduling platform shown in the reference video: it handles the
// OAuth + publishing plumbing for 30+ networks behind a single API key.
//
// Secrets (set in Supabase → Edge Functions → Secrets):
//   POSTIZ_API_KEY  — required. Settings → Developers → Public API.
//   POSTIZ_API_URL  — optional. Defaults to the cloud API. Override with
//                     https://<your-host>/public/v1 when self-hosting.
//
// Auth: Postiz expects the RAW api key in the Authorization header
// (NOT "Bearer <key>").
//
// NOTE: Postiz's public API covers connect / list / publish / analytics
// but has NO comments endpoint — engagement (comment inbox + auto-reply)
// is handled by the comment-capable provider in sync-comments / comment-reply.

const DEFAULT_BASE = "https://api.postiz.com/public/v1";

export function getPostizBase(): string {
  return (Deno.env.get("POSTIZ_API_URL") || DEFAULT_BASE).replace(/\/+$/, "");
}

export function getPostizKey(): string | null {
  return Deno.env.get("POSTIZ_API_KEY") || null;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const key = getPostizKey();
  if (!key) throw new Error("POSTIZ_API_KEY is not configured");
  return { Authorization: key, ...extra };
}

export interface PostizIntegration {
  id: string;
  name?: string;
  identifier?: string; // 'instagram' | 'facebook' | 'linkedin' | 'x' | ...
  picture?: string;
  disabled?: boolean;
  profile?: string;
}

// Map our canonical platform ids to Postiz integration identifiers.
export function toPostizIdentifier(platform: string): string {
  const p = platform.toLowerCase();
  if (p === "twitter") return "x";
  return p;
}

export async function postizListIntegrations(): Promise<PostizIntegration[]> {
  const resp = await fetch(`${getPostizBase()}/integrations`, { headers: headers() });
  if (!resp.ok) {
    throw new Error(`Postiz integrations ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : (data?.integrations || []);
}

// Generate the hosted OAuth URL the user visits to authorise one network.
// Per Postiz docs the route is GET /integrations/social/:identifier and the
// body is { url }. (If a deployment 404s here, the alternate documented form
// is `${base}/social/${identifier}`.)
export async function postizConnectUrl(platform: string, refresh?: string): Promise<string> {
  const identifier = toPostizIdentifier(platform);
  const url = new URL(`${getPostizBase()}/integrations/social/${encodeURIComponent(identifier)}`);
  if (refresh) url.searchParams.set("refresh", refresh);
  const resp = await fetch(url.toString(), { headers: headers() });
  if (!resp.ok) {
    throw new Error(`Postiz connect ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data?.url) throw new Error("Postiz did not return a connect url");
  return data.url as string;
}

// Best-effort media upload. Returns the Postiz media id or null. Failures
// degrade gracefully to a text-only post rather than blocking publication.
export async function postizUploadFromUrl(imageUrl: string): Promise<string | null> {
  try {
    const img = await fetch(imageUrl);
    if (!img.ok) return null;
    const blob = await img.blob();
    const ext = (blob.type.split("/")[1] || "jpg").split(";")[0];
    const fd = new FormData();
    fd.append("file", blob, `image.${ext}`);
    // Don't set Content-Type — fetch sets the multipart boundary itself.
    const resp = await fetch(`${getPostizBase()}/uploads/file`, {
      method: "POST",
      headers: headers(),
      body: fd,
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return data?.id || data?.[0]?.id || null;
  } catch {
    return null;
  }
}

export interface PostizPublishInput {
  integrationIds: string[];
  content: string;
  imageId?: string | null;
  // ISO timestamp; when omitted we post immediately ("now").
  date?: string | null;
}

// Create/schedule a post. The payload follows Postiz's documented shape
// (type/date/posts[] with integration.id + value[].content). Kept isolated
// here so it's trivial to adjust against a live key if a deployment differs.
export async function postizCreatePost(
  input: PostizPublishInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const value: Record<string, unknown> = { content: input.content };
  if (input.imageId) value.image = [{ id: input.imageId }];

  const body = {
    type: input.date ? "schedule" : "now",
    date: input.date || new Date().toISOString(),
    shortLink: false,
    tags: [] as string[],
    posts: input.integrationIds.map((id) => ({
      integration: { id },
      value: [value],
      settings: {},
    })),
  };

  const resp = await fetch(`${getPostizBase()}/posts`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: `Postiz ${resp.status}: ${text.slice(0, 200)}` };
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* some deployments return an empty 200 */
  }
  const id = data?.[0]?.id || data?.id || data?.postId || undefined;
  return { ok: true, id };
}
