// comment-reply: draft an AI reply to a comment, or send a reply.
//   POST { mode: "draft", commentId }          → { reply }   (AI suggestion)
//   POST { mode: "send",  commentId, reply }    → { ok }      (posts the reply)
//
// Auth: requires the user's JWT; ownership of the comment is enforced.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { draftReply, zernioReply } from "../_shared/engagement.ts";
import { ENTITLEMENT_COLUMNS, resolveEntitlement, SUBSCRIPTION_EXPIRED_MESSAGE } from "../_shared/plans.ts";

// AI drafts per user per hour. Generous for real inbox work (a busy account
// answers a few dozen comments a day), low enough to bound the cost of abuse.
const DRAFT_RATE_LIMIT_MAX = 40;

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
    .select(`tone, auto_reply_instructions, ${ENTITLEMENT_COLUMNS}`)
    .eq("id", userId)
    .maybeSingle();

  try {
    if (body.mode === "draft" || !body.mode) {
      // AI drafting is generation; replying by hand ("send") stays open to an
      // expired account so its community is never left unanswered.
      if (!resolveEntitlement(profile).canGenerate) {
        return jsonResponse(
          { error: SUBSCRIPTION_EXPIRED_MESSAGE, code: "subscription_expired" },
          { status: 402, cors },
        );
      }
      // Drafting calls the paid text model. Every other AI entry point is
      // quota'd; this one was not, so a single account could mint unlimited
      // AI calls just by clicking "suggérer une réponse". Same atomic
      // reservation as generate-content, so parallel requests cannot slip
      // past the count.
      const { data: allowed, error: quotaError } = await supabase.rpc("consume_generation_quota", {
        p_user: userId,
        p_function: "comment-reply",
        p_max: DRAFT_RATE_LIMIT_MAX,
        p_window_seconds: 3600,
      });
      if (!quotaError && allowed === false) {
        return jsonResponse(
          {
            error: `Limite de ${DRAFT_RATE_LIMIT_MAX} suggestions IA par heure atteinte. Réessayez plus tard.`,
            code: "rate_limited",
          },
          { status: 429, cors },
        );
      }

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

      // Zernio is the only provider that can hold a comment: the alternative
      // connector was removed with the switch to Zernio-only, so nothing can
      // create a comment from anywhere else.
      if (comment.provider !== "zernio") {
        return jsonResponse(
          { error: "Ce commentaire provient d'un fournisseur qui n'est plus pris en charge." },
          { status: 400, cors },
        );
      }
      // Zernio reply needs the post + account handles stashed at sync time.
      const raw = (comment.raw || {}) as { zPostId?: string; zAccountId?: string };
      if (!raw.zPostId || !raw.zAccountId) {
        return jsonResponse(
          { error: "Informations Zernio manquantes pour répondre à ce commentaire." },
          { status: 400, cors },
        );
      }
      const res = await zernioReply(raw.zPostId, raw.zAccountId, reply, comment.external_comment_id);
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
