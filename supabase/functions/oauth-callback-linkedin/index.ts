// LinkedIn OAuth callback. Exchanges the code for an access token and
// upserts a social_connections row.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  getOAuthRedirectUri,
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
    const error = url.searchParams.get("error");

    if (error) {
      return htmlErrorPage(`LinkedIn a refusé l'autorisation: ${error}`);
    }
    if (!code || !stateToken) {
      return htmlErrorPage("Réponse OAuth incomplète");
    }

    const state = await verifyState(stateToken).catch(() => null);
    if (!state || state.platform !== "linkedin" || typeof state.userId !== "string") {
      return htmlErrorPage("State invalide ou expiré");
    }

    const clientId = Deno.env.get("OAUTH_LINKEDIN_CLIENT_ID");
    const clientSecret = Deno.env.get("OAUTH_LINKEDIN_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return htmlErrorPage("LinkedIn OAuth secrets manquants côté serveur");
    }
    const redirectUri = getOAuthRedirectUri("oauth-callback-linkedin");

    const tokenParams = new URLSearchParams();
    tokenParams.set("grant_type", "authorization_code");
    tokenParams.set("code", code);
    tokenParams.set("redirect_uri", redirectUri);
    tokenParams.set("client_id", clientId);
    tokenParams.set("client_secret", clientSecret);

    const tokenResp = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      return htmlErrorPage(`Échange du code échoué: ${txt.slice(0, 300)}`);
    }
    const tokenData = await tokenResp.json();
    const accessToken: string = tokenData.access_token;
    const expiresIn: number | undefined = tokenData.expires_in;
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;
    const scopes: string[] = (tokenData.scope || "")
      .split(/\s+/)
      .filter(Boolean);

    // Get the member id via userinfo (OIDC).
    const meResp = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meResp.ok) {
      const txt = await meResp.text();
      return htmlErrorPage(`Lecture du profil LinkedIn échouée: ${txt.slice(0, 300)}`);
    }
    const me = await meResp.json();
    const accountId: string = me.sub;
    const accountName: string =
      me.name || `${me.given_name ?? ""} ${me.family_name ?? ""}`.trim();

    await upsertConnection({
      userId: state.userId as string,
      platform: "linkedin",
      accountId,
      accountName,
      accountUsername: me.email ?? null,
      accessToken,
      tokenExpiresAt,
      scopes,
      meta: { picture: me.picture ?? null },
    });

    return htmlSuccessPage("LinkedIn");
  } catch (err) {
    console.error("oauth-callback-linkedin error:", err);
    return htmlErrorPage(err instanceof Error ? err.message : String(err));
  }
});
