// zernio-connect: returns the hosted OAuth URL the user opens to authorise
// a social network through Zernio. Ensures the user has a dedicated Zernio
// profile (per-user isolation) and persists an umbrella connection row so
// publish-post routes this user through Zernio.
//
// Requires ZERNIO_API_KEY in the Supabase secrets.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin, getUserIdFromAuthHeader } from "../_shared/oauth.ts";
import {
  getZernioKey,
  zernioConnectUrl,
  zernioCreateProfile,
  zernioListProfiles,
} from "../_shared/zernio.ts";

const SUPPORTED = [
  "linkedin",
  "facebook",
  "instagram",
  "twitter",
  "tiktok",
  "youtube",
  "pinterest",
  "threads",
  "bluesky",
  "reddit",
  "telegram",
];

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });
  }

  if (!getZernioKey()) {
    return jsonResponse(
      { error: "Zernio non configuré. Définissez ZERNIO_API_KEY dans les secrets Supabase." },
      { status: 503, cors },
    );
  }

  const userId = await getUserIdFromAuthHeader(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  const body = (await req.json().catch(() => ({}))) as { platform?: string };
  const platform = (body.platform || "").toLowerCase();

  try {
    const admin = getSupabaseAdmin();

    // Reuse the user's Zernio profile if we already provisioned one.
    const { data: existing } = await admin
      .from("social_connections")
      .select("profile_key")
      .eq("user_id", userId)
      .eq("provider", "zernio")
      .maybeSingle();

    let profileId: string | null = existing?.profile_key || null;

    if (!profileId) {
      const { data: prof } = await admin
        .from("profiles")
        .select("company_name, email")
        .eq("id", userId)
        .maybeSingle();
      const name = (prof?.company_name || prof?.email || `user-${userId.slice(0, 8)}`).slice(0, 60);
      // Every user needs a dedicated profile: publish-post, zernio-status and
      // sync-comments all scope by profile, so users sharing one would publish
      // to, list and read comments from each other's social accounts. Falling
      // back to the operator's default profile is therefore opt-in and only
      // safe for a single-tenant deployment (ZERNIO_ALLOW_SHARED_PROFILE=true).
      profileId = await zernioCreateProfile(name);
      if (!profileId && Deno.env.get("ZERNIO_ALLOW_SHARED_PROFILE") !== "true") {
        return jsonResponse(
          {
            error:
              "Impossible de créer un espace Zernio dédié à votre compte (limite de profils du plan Zernio atteinte). Contactez le support.",
            code: "ZERNIO_PROFILE_LIMIT",
          },
          { status: 503, cors },
        );
      }
      if (!profileId) {
        const profiles = await zernioListProfiles();
        profileId = profiles.find((p) => p.isDefault)?._id || profiles[0]?._id || null;
      }
    }

    if (!profileId) {
      return jsonResponse(
        { error: "Impossible de créer ou récupérer un profil Zernio." },
        { status: 502, cors },
      );
    }

    // Umbrella row: signals publish-post to use Zernio for this user.
    const { error: upErr } = await admin.from("social_connections").upsert(
      {
        user_id: userId,
        provider: "zernio",
        platform: "all",
        account_id: "zernio",
        account_name: "Zernio",
        access_token: "zernio", // non-null placeholder; publisher uses ZERNIO_API_KEY
        profile_key: profileId,
        meta: {},
      },
      { onConflict: "user_id,platform,account_id" },
    );
    if (upErr) console.error("zernio-connect upsert:", upErr);

    if (!platform) {
      return jsonResponse({ supported: SUPPORTED, profileId }, { cors });
    }
    if (!SUPPORTED.includes(platform)) {
      return jsonResponse({ error: `Plateforme non supportée: ${platform}` }, { status: 400, cors });
    }

    const connectUrl = await zernioConnectUrl(platform, profileId);
    return jsonResponse({ connectUrl, platform }, { cors });
  } catch (err) {
    console.error("zernio-connect error:", err);
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("PAYMENT_REQUIRED") ||
      message.includes("free_tier_exceeded") ||
      message.includes("Add a payment method")
    ) {
      return jsonResponse(
        {
          error:
            "La limite gratuite Zernio de 2 comptes connectés est déjà atteinte. Ajoutez un moyen de paiement dans Zernio ou supprimez un ancien compte, puis réessayez.",
          code: "ZERNIO_PAYMENT_REQUIRED",
        },
        { status: 402, cors },
      );
    }
    return jsonResponse(
      { error: message },
      { status: 502, cors },
    );
  }
});
