// Start Twitter/X OAuth 2.0 (PKCE).
// Secrets:
//   OAUTH_TWITTER_CLIENT_ID
//   OAUTH_STATE_SECRET
//
// We compute a code_verifier on the fly, embed it in the signed state
// so the callback can finish the PKCE exchange without server-side
// session storage.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { getUserIdFromAuthHeader, signState } from "../_shared/oauth.ts";

const AUTHORIZE = "https://twitter.com/i/oauth2/authorize";

function randomString(bytes = 48): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const clientId = Deno.env.get("OAUTH_TWITTER_CLIENT_ID");
    if (!clientId) {
      return new Response("Twitter OAuth not configured", { status: 500, headers: corsHeaders });
    }
    const url = new URL(req.url);
    const tokenFromQuery = url.searchParams.get("token");
    const authHeader = req.headers.get("Authorization") ||
      (tokenFromQuery ? `Bearer ${tokenFromQuery}` : null);
    const userId = await getUserIdFromAuthHeader(authHeader);
    if (!userId) {
      return new Response("Not authenticated", { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const redirectUri = `${supabaseUrl}/functions/v1/oauth-callback-twitter`;

    const codeVerifier = randomString(48);
    const codeChallenge = await sha256(codeVerifier);

    const state = await signState({ userId, platform: "twitter", codeVerifier });

    const authorizeUrl = new URL(AUTHORIZE);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set(
      "scope",
      "tweet.read tweet.write users.read offline.access",
    );
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    return Response.redirect(authorizeUrl.toString(), 302);
  } catch (err) {
    console.error("oauth-start-twitter error:", err);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
});
