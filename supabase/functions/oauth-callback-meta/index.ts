// Meta callback: exchanges the code, gets a long-lived user token,
// then enumerates the user's Pages and the Instagram business accounts
// connected to them. We upsert one social_connections row per Page
// (platform=facebook) and one per linked IG account (platform=instagram).
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  getOAuthRedirectUri,
  htmlErrorPage,
  htmlSuccessPage,
  upsertConnection,
  verifyState,
} from "../_shared/oauth.ts";

const GRAPH = "https://graph.facebook.com/v19.0";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateToken = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");
    if (errorParam) return htmlErrorPage(`Meta a refusé: ${errorParam}`);
    if (!code || !stateToken) return htmlErrorPage("Réponse OAuth incomplète");

    const state = await verifyState(stateToken).catch(() => null);
    if (!state || state.platform !== "meta" || typeof state.userId !== "string") {
      return htmlErrorPage("State invalide ou expiré");
    }

    const appId = Deno.env.get("OAUTH_META_APP_ID");
    const appSecret = Deno.env.get("OAUTH_META_APP_SECRET");
    if (!appId || !appSecret) return htmlErrorPage("Secrets Meta manquants côté serveur");

    const redirectUri = getOAuthRedirectUri("oauth-callback-meta");

    // 1. Exchange code for short-lived user token.
    const shortTokenUrl = new URL(`${GRAPH}/oauth/access_token`);
    shortTokenUrl.searchParams.set("client_id", appId);
    shortTokenUrl.searchParams.set("client_secret", appSecret);
    shortTokenUrl.searchParams.set("redirect_uri", redirectUri);
    shortTokenUrl.searchParams.set("code", code);
    const shortResp = await fetch(shortTokenUrl.toString());
    if (!shortResp.ok) {
      return htmlErrorPage(
        `Échange du code échoué: ${(await shortResp.text()).slice(0, 300)}`,
      );
    }
    const shortData = await shortResp.json();
    const shortToken = shortData.access_token as string;

    // 2. Upgrade to long-lived user token (60 days).
    const longTokenUrl = new URL(`${GRAPH}/oauth/access_token`);
    longTokenUrl.searchParams.set("grant_type", "fb_exchange_token");
    longTokenUrl.searchParams.set("client_id", appId);
    longTokenUrl.searchParams.set("client_secret", appSecret);
    longTokenUrl.searchParams.set("fb_exchange_token", shortToken);
    const longResp = await fetch(longTokenUrl.toString());
    const longData = longResp.ok ? await longResp.json() : null;
    const userToken = (longData?.access_token as string) || shortToken;
    const expiresIn: number | undefined = longData?.expires_in;
    const userTokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // 3. List the user's Pages (Page access tokens are returned here).
    const pagesResp = await fetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(
        userToken,
      )}`,
    );
    if (!pagesResp.ok) {
      return htmlErrorPage(
        `Lecture des pages échouée: ${(await pagesResp.text()).slice(0, 300)}`,
      );
    }
    const pagesData = await pagesResp.json();
    const pages: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string };
    }> = pagesData.data || [];

    if (pages.length === 0) {
      return htmlErrorPage(
        "Aucune Page Facebook trouvée. Créez ou liez une Page à votre compte avant de continuer.",
      );
    }

    for (const page of pages) {
      // Facebook page connection
      await upsertConnection({
        userId: state.userId as string,
        platform: "facebook",
        accountId: page.id,
        accountName: page.name,
        accessToken: page.access_token,
        tokenExpiresAt: userTokenExpiresAt,
        meta: { user_token_expires_at: userTokenExpiresAt },
      });

      // Instagram business connection (if linked)
      if (page.instagram_business_account?.id) {
        const igId = page.instagram_business_account.id;
        // Fetch the IG username for nicer UI.
        let igUsername: string | null = null;
        try {
          const igResp = await fetch(
            `${GRAPH}/${igId}?fields=username&access_token=${encodeURIComponent(page.access_token)}`,
          );
          if (igResp.ok) {
            const igData = await igResp.json();
            igUsername = igData.username ?? null;
          }
        } catch (_) {
          // Non-fatal.
        }
        await upsertConnection({
          userId: state.userId as string,
          platform: "instagram",
          accountId: igId,
          accountUsername: igUsername,
          accountName: page.name,
          accessToken: page.access_token,
          tokenExpiresAt: userTokenExpiresAt,
          meta: { fb_page_id: page.id, ig_user_id: igId },
        });
      }
    }

    return htmlSuccessPage("Meta / Facebook / Instagram");
  } catch (err) {
    console.error("oauth-callback-meta error:", err);
    return htmlErrorPage(err instanceof Error ? err.message : String(err));
  }
});
