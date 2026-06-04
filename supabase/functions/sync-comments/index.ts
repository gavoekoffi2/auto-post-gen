// sync-comments: pulls comments for recently published posts into the
// social_comments inbox, and (optionally) auto-replies with the AI when the
// user has enabled it.
//
//   Manual: POST with the user's JWT       → syncs that user.
//   Cron:   POST with x-cron-secret header → syncs a batch of users.
//
// Comments require a comment-capable provider. Postiz's public API has none,
// so this routes through Ayrshare's Comments API (Premium plan). Users
// without an Ayrshare connection get a clear notice instead of a hard error.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  ayrshareGetComments,
  ayrsharePostReply,
  draftReply,
  zernioGetPostComments,
  zernioListCommentedPosts,
  zernioReply,
  type NormalizedComment,
} from "../_shared/engagement.ts";

type DB = ReturnType<typeof createClient>;

const POSTS_PER_USER = 25;
const AUTO_REPLY_CAP = 10; // max auto-replies per user per run

type SyncResult = { fetched: number; inserted: number; replied: number; note?: string };

// Dispatch to the user's engagement provider (Zernio preferred, else Ayrshare).
async function syncUser(supabase: DB, userId: string): Promise<SyncResult> {
  const { data: conns } = await supabase
    .from("social_connections")
    .select("provider, profile_key")
    .eq("user_id", userId)
    .in("provider", ["zernio", "ayrshare"]);
  const zernio = (conns as any[] || []).find((c) => c.provider === "zernio");
  const ayrshare = (conns as any[] || []).find((c) => c.provider === "ayrshare");
  if (zernio) return await syncUserZernio(supabase, userId, zernio.profile_key ?? null);
  if (ayrshare) return await syncUserAyrshare(supabase, userId, ayrshare.profile_key ?? null);
  return { fetched: 0, inserted: 0, replied: 0, note: "no_comment_provider" };
}

// --- Zernio inbox: list commented posts → fetch each thread → upsert. ---
async function syncUserZernio(
  supabase: DB,
  userId: string,
  profileKey: string | null,
): Promise<SyncResult> {
  const { posts, addonMissing } = await zernioListCommentedPosts(profileKey);
  if (addonMissing) return { fetched: 0, inserted: 0, replied: 0, note: "zernio_inbox_addon_required" };

  let fetched = 0;
  let inserted = 0;
  let replied = 0;
  const newRows: Array<{
    id: string;
    message: string | null;
    external_comment_id: string;
    raw: any;
    postContent: string | null;
  }> = [];

  for (const p of posts) {
    let comments: NormalizedComment[] = [];
    try {
      comments = await zernioGetPostComments(p.id, p.accountId);
    } catch (_e) {
      continue;
    }
    fetched += comments.length;
    if (comments.length === 0) continue;

    // Link back to the local post we published (for the original content).
    const { data: localPost } = await supabase
      .from("posts")
      .select("id, content")
      .eq("user_id", userId)
      .eq("provider_post_id", p.id)
      .maybeSingle();

    const ids = comments.map((c) => c.externalCommentId);
    const { data: existing } = await supabase
      .from("social_comments")
      .select("external_comment_id")
      .eq("user_id", userId)
      .in("external_comment_id", ids);
    const existingSet = new Set((existing as any[] || []).map((e) => e.external_comment_id));

    const toInsert = comments
      .filter((c) => !existingSet.has(c.externalCommentId))
      .map((c) => ({
        user_id: userId,
        post_id: (localPost as any)?.id ?? null,
        provider: "zernio",
        platform: c.platform || p.platform,
        external_comment_id: c.externalCommentId,
        parent_comment_id: c.parentId ?? null,
        author_name: c.author ?? null,
        author_handle: c.handle ?? null,
        author_avatar_url: c.avatar ?? null,
        message: c.message ?? null,
        comment_created_at: c.createdAt ?? null,
        status: "new",
        raw: c.raw ?? {},
      }));

    if (toInsert.length > 0) {
      const { data: ins, error } = await supabase
        .from("social_comments")
        .insert(toInsert)
        .select("id, message, external_comment_id, raw");
      if (!error && ins) {
        inserted += ins.length;
        for (const r of ins as any[]) {
          newRows.push({
            id: r.id,
            message: r.message,
            external_comment_id: r.external_comment_id,
            raw: r.raw,
            postContent: (localPost as any)?.content ?? p.content ?? null,
          });
        }
      }
    }
  }

  if (newRows.length > 0) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("tone, auto_reply_instructions, auto_reply_enabled")
      .eq("id", userId)
      .maybeSingle();
    if (profile && (profile as any).auto_reply_enabled) {
      const cap = Math.min(newRows.length, AUTO_REPLY_CAP);
      for (let i = 0; i < cap; i++) {
        const r = newRows[i];
        if (!r.message) continue;
        const zPostId = r.raw?.zPostId;
        const zAccountId = r.raw?.zAccountId;
        if (!zPostId || !zAccountId) continue;
        try {
          const reply = await draftReply({
            comment: r.message,
            postContent: r.postContent,
            brandTone: (profile as any).tone,
            instructions: (profile as any).auto_reply_instructions,
          });
          const res = await zernioReply(zPostId, zAccountId, reply, r.external_comment_id);
          if (res.ok) {
            await supabase
              .from("social_comments")
              .update({
                status: "replied",
                reply_text: reply,
                reply_external_id: res.id ?? null,
                replied_at: new Date().toISOString(),
                replied_by: "auto",
              })
              .eq("id", r.id);
            replied++;
          }
        } catch (_e) {
          /* keep going */
        }
      }
    }
  }

  return { fetched, inserted, replied };
}

// --- Ayrshare: per-post Comments API (provider_post_id required). ---
async function syncUserAyrshare(
  supabase: DB,
  userId: string,
  profileKeyArg: string | null,
): Promise<SyncResult> {
  const profileKey = profileKeyArg;

  const { data: posts } = await supabase
    .from("posts")
    .select("id, content, provider_post_id")
    .eq("user_id", userId)
    .eq("status", "published")
    .not("provider_post_id", "is", null)
    .order("published_at", { ascending: false })
    .limit(POSTS_PER_USER);

  let fetched = 0;
  let inserted = 0;
  let replied = 0;
  const newRows: Array<{
    id: string;
    message: string | null;
    platform: string;
    external_comment_id: string;
    postContent: string | null;
    providerPostId: string;
  }> = [];

  for (const post of (posts as any[]) || []) {
    let comments: NormalizedComment[] = [];
    try {
      comments = await ayrshareGetComments(post.provider_post_id, profileKey);
    } catch (_e) {
      continue; // skip this post; keep syncing the rest
    }
    fetched += comments.length;
    if (comments.length === 0) continue;

    const ids = comments.map((c) => c.externalCommentId);
    const { data: existing } = await supabase
      .from("social_comments")
      .select("external_comment_id")
      .eq("user_id", userId)
      .in("external_comment_id", ids);
    const existingSet = new Set((existing as any[] || []).map((e) => e.external_comment_id));

    const toInsert = comments
      .filter((c) => !existingSet.has(c.externalCommentId))
      .map((c) => ({
        user_id: userId,
        post_id: post.id,
        provider: "ayrshare",
        platform: c.platform,
        external_comment_id: c.externalCommentId,
        parent_comment_id: c.parentId ?? null,
        author_name: c.author ?? null,
        author_handle: c.handle ?? null,
        author_avatar_url: c.avatar ?? null,
        message: c.message ?? null,
        comment_created_at: c.createdAt ?? null,
        status: "new",
        raw: c.raw ?? {},
      }));

    if (toInsert.length > 0) {
      const { data: insertedRows, error } = await supabase
        .from("social_comments")
        .insert(toInsert)
        .select("id, message, platform, external_comment_id");
      if (!error && insertedRows) {
        inserted += insertedRows.length;
        for (const r of insertedRows as any[]) {
          newRows.push({
            id: r.id,
            message: r.message,
            platform: r.platform,
            external_comment_id: r.external_comment_id,
            postContent: post.content,
            providerPostId: post.provider_post_id,
          });
        }
      }
    }
  }

  // Auto-reply pass — only if the user enabled it.
  if (newRows.length > 0) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("tone, auto_reply_instructions, auto_reply_enabled")
      .eq("id", userId)
      .maybeSingle();
    if (profile && (profile as any).auto_reply_enabled) {
      const cap = Math.min(newRows.length, AUTO_REPLY_CAP);
      for (let i = 0; i < cap; i++) {
        const r = newRows[i];
        if (!r.message) continue;
        try {
          const reply = await draftReply({
            comment: r.message,
            postContent: r.postContent,
            brandTone: (profile as any).tone,
            instructions: (profile as any).auto_reply_instructions,
          });
          const res = await ayrsharePostReply(
            r.providerPostId,
            r.external_comment_id,
            r.platform,
            reply,
            profileKey,
          );
          if (res.ok) {
            await supabase
              .from("social_comments")
              .update({
                status: "replied",
                reply_text: reply,
                reply_external_id: res.id ?? null,
                replied_at: new Date().toISOString(),
                replied_by: "auto",
              })
              .eq("id", r.id);
            replied++;
          }
        } catch (_e) {
          /* keep going */
        }
      }
    }
  }

  return { fetched, inserted, replied };
}

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server misconfigured" }, { status: 500, cors });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const cronSecret = Deno.env.get("CRON_SECRET");
  const headerCron = req.headers.get("x-cron-secret");
  const isCron = cronSecret && headerCron && headerCron === cronSecret;

  try {
    if (isCron) {
      // Batch: every user that has an Ayrshare connection.
      const { data: rows } = await supabase
        .from("social_connections")
        .select("user_id")
        .in("provider", ["zernio", "ayrshare"])
        .limit(50);
      const userIds = Array.from(new Set((rows as any[] || []).map((r) => r.user_id)));
      const results = [];
      for (const uid of userIds) {
        try {
          results.push({ user_id: uid, ...(await syncUser(supabase, uid)) });
        } catch (e) {
          results.push({ user_id: uid, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return jsonResponse({ success: true, users: results.length, results }, { cors });
    }

    // Manual: the calling user only.
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!jwt) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Invalid token" }, { status: 401, cors });
    }
    const result = await syncUser(supabase, userData.user.id);
    if (result.note === "no_comment_provider") {
      return jsonResponse(
        {
          ...result,
          notice:
            "La synchronisation des commentaires nécessite un fournisseur compatible : Zernio (add-on Inbox) ou Ayrshare (Premium). Connectez-en un dans « Réseaux sociaux ».",
        },
        { cors },
      );
    }
    if (result.note === "zernio_inbox_addon_required") {
      return jsonResponse(
        {
          ...result,
          notice:
            "Les commentaires nécessitent l'add-on Inbox de Zernio. Activez-le sur votre compte Zernio pour collecter et répondre aux commentaires.",
        },
        { cors },
      );
    }
    return jsonResponse({ success: true, ...result }, { cors });
  } catch (err) {
    console.error("sync-comments error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, cors },
    );
  }
});
