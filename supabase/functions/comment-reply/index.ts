// comment-reply: draft an AI reply to a comment, or send a reply.
//   POST { mode: "draft", commentId }          → { reply }   (AI suggestion)
//   POST { mode: "send",  commentId, reply }    → { ok }      (posts the reply)
//
// Auth: requires the user's JWT; ownership of the comment is enforced.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { ayrsharePostReply, draftReply } from "../_shared/engagement.ts";

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server misconfigured" }, { status: 500, cors });
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Invalid token" }, { status: 401, cors });
  }
  const userId = userData.user.id;

  const body = (await req.json().catch(() => ({}))) as {
    mode?: "draft" | "send";
    commentId?: string;
    reply?: string;
  };
  if (!body.commentId) return jsonResponse({ error: "commentId requis" }, { status: 400, cors });

  // Load the comment and enforce ownership.
  const { data: comment } = await supabase
    .from("social_comments")
    .select("*")
    .eq("id", body.commentId)
    .maybeSingle();
  if (!comment) return jsonResponse({ error: "Comment introuvable" }, { status: 404, cors });
  if (comment.user_id !== userId) return jsonResponse({ error: "Forbidden" }, { status: 403, cors });

  const { data: post } = comment.post_id
    ? await supabase
      .from("posts")
      .select("content, provider_post_id")
      .eq("id", comment.post_id)
      .maybeSingle()
    : { data: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("tone, auto_reply_instructions")
    .eq("id", userId)
    .maybeSingle();

  try {
    if (body.mode === "draft" || !body.mode) {
      const reply = await draftReply({
        comment: comment.message || "",
        postContent: post?.content || null,
        brandTone: profile?.tone || null,
        instructions: profile?.auto_reply_instructions || null,
      });
      return jsonResponse({ reply }, { cors });
    }

    if (body.mode === "send") {
      const reply = (body.reply || "").trim();
      if (!reply) return jsonResponse({ error: "reply vide" }, { status: 400, cors });
      const providerPostId = post?.provider_post_id;
      if (!providerPostId) {
        return jsonResponse(
          { error: "Ce commentaire n'est pas rattaché à une publication synchronisable." },
          { status: 400, cors },
        );
      }
      const { data: conn } = await supabase
        .from("social_connections")
        .select("profile_key")
        .eq("user_id", userId)
        .eq("provider", "ayrshare")
        .maybeSingle();

      const res = await ayrsharePostReply(
        providerPostId,
        comment.external_comment_id,
        comment.platform,
        reply,
        conn?.profile_key ?? null,
      );
      if (!res.ok) return jsonResponse({ error: res.error }, { status: 502, cors });

      await supabase
        .from("social_comments")
        .update({
          status: "replied",
          reply_text: reply,
          reply_external_id: res.id ?? null,
          replied_at: new Date().toISOString(),
          replied_by: "manual",
        })
        .eq("id", body.commentId);

      return jsonResponse({ ok: true }, { cors });
    }

    return jsonResponse({ error: "mode invalide" }, { status: 400, cors });
  } catch (err) {
    console.error("comment-reply error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, cors },
    );
  }
});
