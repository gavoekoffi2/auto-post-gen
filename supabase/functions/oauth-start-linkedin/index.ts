// Start the LinkedIn OAuth dance.
// Requires Supabase secrets:
//   OAUTH_LINKEDIN_CLIENT_ID
//   OAUTH_STATE_SECRET (or CRON_SECRET as fallback)
//   APP_BASE_URL (your front-end URL, used for the callback redirect)
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { getUserIdFromAuthHeader, signState } from "../_shared/oauth.ts";

const LINKEDIN_AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const clientId = Deno.env.get("OAUTH_LINKEDIN_CLIENT_ID");
    if (!clientId) {
      return new Response(
        "LinkedIn OAuth is not configured. Set OAUTH_LINKEDIN_CLIENT_ID.",
        { status: 500, headers: corsHeaders },
      );
    }

    // Accept the user either via the Authorization header (preferred) or
    // via a short-lived token passed as ?token=... (when opening the OAuth
    // flow in a new tab).
    const url = new URL(req.url);
    const tokenFromQuery = url.searchParams.get("token");
    const authHeader =
      req.headers.get("Authorization") ||
      (tokenFromQuery ? `Bearer ${tokenFromQuery}` : null);
    const userId = await getUserIdFromAuthHeader(authHeader);
    if (!userId) {
      return new Response("Not authenticated", { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const redirectUri = `${supabaseUrl}/functions/v1/oauth-callback-linkedin`;

    const state = await signState({ userId, platform: "linkedin" });

    // openid + profile + email + w_member_social: ability to post on behalf
    // of the user. w_member_social is the legacy scope and is the one
    // accepted today; you must also enable "Share on LinkedIn" in your
    // LinkedIn app config.
    const scopes = ["openid", "profile", "email", "w_member_social"].join(" ");

    const authorizeUrl = new URL(LINKEDIN_AUTHORIZE);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", scopes);

    return Response.redirect(authorizeUrl.toString(), 302);
  } catch (err) {
    console.error("oauth-start-linkedin error:", err);
    return new Response("Internal error", {
      status: 500,
      headers: corsHeaders,
    });
  }
});
