// Twitter/X OAuth 2.0 callback (PKCE).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  htmlErrorPage,
  htmlSuccessPage,
  upsertConnection,
  verifyState,
} from "../_shared/oauth.ts";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateToken = url.searchParams.get("state");
    const errParam = url.searchParams.get("error");
    if (errParam) return htmlErrorPage(`Twitter a refusé: ${errParam}`);
    if (!code || !stateToken) return htmlErrorPage("Réponse OAuth incomplète");

    const state = await verifyState(stateToken).catch(() => null);
    if (
      !state ||
      state.platform !== "twitter" ||
      typeof state.userId !== "string" ||
      typeof state.codeVerifier !== "string"
    ) {
      return htmlErrorPage("State invalide ou expiré");
    }

    const clientId = Deno.env.get("OAUTH_TWITTER_CLIENT_ID");
    const clientSecret = Deno.env.get("OAUTH_TWITTER_CLIENT_SECRET");
    if (!clientId) return htmlErrorPage("Twitter client id manquant côté serveur");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const redirectUri = `${supabaseUrl}/functions/v1/oauth-callback-twitter`;

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("code_verifier", state.codeVerifier as string);
    body.set("client_id", clientId);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    // Twitter supports both public (PKCE-only) and confidential clients.
    // When a secret is configured we send Basic auth as required for
    // confidential clients.
    if (clientSecret) {
      headers["Authorization"] = "Basic " +
        btoa(`${clientId}:${clientSecret}`);
    }

    const tokenResp = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers,
      body: body.toString(),
    });
    if (!tokenResp.ok) {
      return htmlErrorPage(
        `Échange du code échoué: ${(await tokenResp.text()).slice(0, 300)}`,
      );
    }
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token as string;
    const refreshToken = (tokenData.refresh_token as string) || null;
    const expiresIn: number | undefined = tokenData.expires_in;
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;
    const scopes = ((tokenData.scope as string) || "").split(/\s+/).filter(Boolean);

    const meResp = await fetch("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meResp.ok) {
      return htmlErrorPage(
        `Lecture du profil X échouée: ${(await meResp.text()).slice(0, 300)}`,
      );
    }
    const meData = await meResp.json();
    const userObj = meData.data;

    await upsertConnection({
      userId: state.userId as string,
      platform: "twitter",
      accountId: userObj.id,
      accountUsername: userObj.username,
      accountName: userObj.name,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes,
    });

    return htmlSuccessPage("Twitter (X)");
  } catch (err) {
    console.error("oauth-callback-twitter error:", err);
    return htmlErrorPage(err instanceof Error ? err.message : String(err));
  }
});
