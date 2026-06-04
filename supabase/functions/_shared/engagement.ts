// Shared engagement helpers: AI reply drafting (OpenRouter, works today)
// + a comment adapter for the comment-capable provider.
//
// IMPORTANT: Postiz's public API has NO comments endpoint, so the comment
// inbox + auto-reply route through Ayrshare's Comments API (Premium plan):
//   GET  https://app.ayrshare.com/api/comments/:id   (read)
//   POST https://app.ayrshare.com/api/comments/:id   (reply)
// :id is the provider_post_id we persisted at publish time.
//
// The Ayrshare response/reply shapes vary by plan/version, so parsing is
// defensive and the reply payload is isolated for easy live validation.

import { chatText } from "./ai.ts";

const AYR = "https://app.ayrshare.com/api";

export interface NormalizedComment {
  platform: string;
  externalCommentId: string;
  parentId?: string | null;
  author?: string | null;
  handle?: string | null;
  avatar?: string | null;
  message?: string | null;
  createdAt?: string | null;
  raw: unknown;
}

function ayrHeaders(profileKey: string | null): Record<string, string> {
  const apiKey = Deno.env.get("AYRSHARE_API_KEY") || "";
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (profileKey) h["Profile-Key"] = profileKey;
  return h;
}

// Ayrshare returns comments either under platform-named arrays or a flat
// `comments` array depending on the call. Handle both defensively.
function normalizeAyrshareComments(data: any): NormalizedComment[] {
  const out: NormalizedComment[] = [];
  if (!data || typeof data !== "object") return out;

  const buckets: Array<[string, any[]]> = [];
  if (Array.isArray(data.comments)) buckets.push(["unknown", data.comments]);
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v) && k !== "errors" && k !== "comments") {
      buckets.push([k, v as any[]]);
    }
  }

  for (const [platform, arr] of buckets) {
    for (const c of arr) {
      const id = c?.commentId || c?.id || c?.comment_id;
      if (!id) continue;
      out.push({
        platform: platform === "unknown" ? (c?.platform || "unknown") : platform,
        externalCommentId: String(id),
        parentId: c?.parentId || c?.parent_id || null,
        author: c?.userName || c?.from?.name || c?.name || null,
        handle: c?.username || c?.screenName || null,
        avatar: c?.profilePicture || c?.userPicture || null,
        message: c?.comment || c?.message || c?.text || null,
        createdAt: c?.created || c?.createdTime || c?.timestamp || null,
        raw: c,
      });
    }
  }
  return out;
}

export async function ayrshareGetComments(
  providerPostId: string,
  profileKey: string | null,
): Promise<NormalizedComment[]> {
  const resp = await fetch(`${AYR}/comments/${encodeURIComponent(providerPostId)}`, {
    headers: ayrHeaders(profileKey),
  });
  if (!resp.ok) {
    throw new Error(`Ayrshare comments ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return normalizeAyrshareComments(await resp.json());
}

export async function ayrsharePostReply(
  providerPostId: string,
  commentId: string,
  platform: string,
  reply: string,
  profileKey: string | null,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  // Reply payload (validate against a live Ayrshare Premium account).
  const resp = await fetch(`${AYR}/comments/${encodeURIComponent(providerPostId)}`, {
    method: "POST",
    headers: ayrHeaders(profileKey),
    body: JSON.stringify({ platforms: [platform], comment: reply, commentId }),
  });
  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: `Ayrshare reply ${resp.status}: ${text.slice(0, 200)}` };
  let d: any = {};
  try {
    d = JSON.parse(text);
  } catch {
    /* empty 200 */
  }
  return { ok: true, id: d?.id || d?.commentId };
}

// AI reply drafting — uses the existing OpenRouter integration. Works today,
// independent of any social provider.
export async function draftReply(opts: {
  comment: string;
  postContent?: string | null;
  brandTone?: string | null;
  instructions?: string | null;
}): Promise<string> {
  const sys = [
    "Tu es un community manager expérimenté. Rédige UNE réponse à un commentaire reçu sur les réseaux sociaux.",
    "Règles:",
    "- Chaleureuse, professionnelle, utile.",
    opts.brandTone ? `- Respecte le ton de la marque: ${opts.brandTone}.` : "",
    "- 1 à 2 phrases maximum, pas de hashtags, au plus un emoji.",
    "- N'invente pas de promesses commerciales.",
    opts.instructions ? `- Consignes spécifiques: ${opts.instructions}` : "",
    "Réponds UNIQUEMENT avec le texte de la réponse (sans guillemets).",
  ]
    .filter(Boolean)
    .join("\n");

  const user = `Publication d'origine: ${opts.postContent || "(inconnue)"}\nCommentaire reçu: ${opts.comment}\nTa réponse:`;

  const draft = await chatText({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.7,
  });
  return draft.replace(/^["']|["']$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Zernio comments adapter. Zernio exposes a full inbox:
//   GET  /inbox/comments?profileId=      list posts that have comments
//   GET  /inbox/comments/:postId?accountId=   the comment thread
//   POST /inbox/comments/:postId         reply { accountId, message, commentId }
// The inbox requires Zernio's Inbox add-on (HTTP 403 otherwise).
// ---------------------------------------------------------------------------

const ZERNIO_BASE = (Deno.env.get("ZERNIO_API_URL") || "https://zernio.com/api/v1").replace(/\/+$/, "");

function zernioHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = Deno.env.get("ZERNIO_API_KEY") || "";
  return { Authorization: `Bearer ${key}`, ...extra };
}

export interface ZernioCommentedPost {
  id: string;
  accountId: string;
  platform: string;
  content?: string | null;
  commentCount?: number;
}

export async function zernioListCommentedPosts(
  profileId: string | null,
): Promise<{ posts: ZernioCommentedPost[]; addonMissing?: boolean }> {
  const url = new URL(`${ZERNIO_BASE}/inbox/comments`);
  if (profileId) url.searchParams.set("profileId", profileId);
  url.searchParams.set("minComments", "1");
  url.searchParams.set("limit", "50");
  const r = await fetch(url.toString(), { headers: zernioHeaders() });
  if (r.status === 403) return { posts: [], addonMissing: true };
  if (!r.ok) throw new Error(`Zernio inbox ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return {
    posts: (d?.data || []).map((p: any) => ({
      id: p.id,
      accountId: p.accountId,
      platform: p.platform,
      content: p.content ?? null,
      commentCount: p.commentCount,
    })),
  };
}

export async function zernioGetPostComments(
  postId: string,
  accountId: string,
): Promise<NormalizedComment[]> {
  const url = new URL(`${ZERNIO_BASE}/inbox/comments/${encodeURIComponent(postId)}`);
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("limit", "50");
  const r = await fetch(url.toString(), { headers: zernioHeaders() });
  if (!r.ok) throw new Error(`Zernio comments ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.comments || []).map((c: any) => ({
    platform: c.platform || "unknown",
    externalCommentId: String(c.id),
    parentId: c.parentId ?? null,
    author: c.from?.name ?? null,
    handle: c.from?.username ?? null,
    avatar: c.from?.picture ?? null,
    message: c.message ?? null,
    createdAt: c.createdTime ?? null,
    // Stash the handles the reply endpoint needs.
    raw: { ...c, zPostId: postId, zAccountId: accountId },
  }));
}

export async function zernioReply(
  postId: string,
  accountId: string,
  message: string,
  commentId?: string | null,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const body: Record<string, unknown> = { accountId, message };
  if (commentId) body.commentId = commentId;
  const r = await fetch(`${ZERNIO_BASE}/inbox/comments/${encodeURIComponent(postId)}`, {
    method: "POST",
    headers: zernioHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, error: `Zernio reply ${r.status}: ${t.slice(0, 200)}` };
  let d: any = {};
  try {
    d = JSON.parse(t);
  } catch {
    /* empty 200 */
  }
  return { ok: true, id: d?.data?.commentId };
}
