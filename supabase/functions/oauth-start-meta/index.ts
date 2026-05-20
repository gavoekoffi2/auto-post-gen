// Start the Meta (Facebook + Instagram) OAuth dance.
// Requires Supabase secrets:
//   OAUTH_META_APP_ID
//   OAUTH_STATE_SECRET (or CRON_SECRET fallback)
//
// Scopes requested cover both Facebook Page management and Instagram
// publishing via the connected Page. Your Meta app must be approved
// for these scopes (pages_show_list, pages_manage_posts,
// pages_read_engagement, instagram_basic, instagram_content_publish,
// business_management).
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import {
  getOAuthRedirectUri,
  getUserIdFromAuthHeader,
  signState,
} from "../_shared/oauth.ts";

const META_AUTHORIZE = "https://www.facebook.com/v19.0/dialog/oauth";

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const appId = Deno.env.get("OAUTH_META_APP_ID");
    if (!appId) {
      return new Response("Meta OAuth not configured", { status: 500, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const tokenFromQuery = url.searchParams.get("token");
    const authHeader = req.headers.get("Authorization") ||
      (tokenFromQuery ? `Bearer ${tokenFromQuery}` : null);
    const userId = await getUserIdFromAuthHeader(authHeader);
    if (!userId) {
      return new Response("Not authenticated", { status: 401, headers: corsHeaders });
    }

    const redirectUri = getOAuthRedirectUri("oauth-callback-meta");

    const state = await signState({ userId, platform: "meta" });
    const scope = [
      "public_profile",
      "email",
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_content_publish",
      "business_management",
    ].join(",");

    const authorizeUrl = new URL(META_AUTHORIZE);
    authorizeUrl.searchParams.set("client_id", appId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", scope);

    return Response.redirect(authorizeUrl.toString(), 302);
  } catch (err) {
    console.error("oauth-start-meta error:", err);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
});
