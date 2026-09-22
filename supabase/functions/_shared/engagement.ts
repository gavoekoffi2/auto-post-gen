// Shared engagement helpers: AI reply drafting (OpenRouter) plus the comment
// adapter for Zernio, the only provider the product connects to.
//
// A second adapter for the previous provider used to live here. Nothing can
// create a connection to it any more — that connector was removed with the
// switch to Zernio-only — so the code was unreachable while still requiring a
// secret that operators were being told to keep configured. `git log` has it
// if that provider ever comes back.

import { chatText } from "./ai.ts";

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
    opts.brandTone ? `- Respecte le ton de la marque: ${opts.brandTone.slice(0, 120)}.` : "",
    "- 1 à 2 phrases maximum, pas de hashtags, au plus un emoji.",
    "- N'invente pas de promesses commerciales.",
    opts.instructions ? `- Consignes spécifiques: ${opts.instructions.slice(0, 800)}` : "",
    "Réponds UNIQUEMENT avec le texte de la réponse (sans guillemets).",
  ]
    .filter(Boolean)
    .join("\n");

  // Bound every piece of caller-supplied text that lands in the prompt: a
  // long comment or post is billed per token on every draft, and there is
  // nothing useful past this much context for a one-or-two-sentence reply.
  const clamp = (value: string, max: number) => value.slice(0, max);
  const user = `Publication d'origine: ${
    clamp(opts.postContent || "(inconnue)", 1200)
  }\nCommentaire reçu: ${clamp(opts.comment, 1200)}\nTa réponse:`;

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
