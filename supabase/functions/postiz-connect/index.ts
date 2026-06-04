// postiz-connect: returns the hosted OAuth URL the user opens to authorise
// one social network through Postiz (the platform from the reference video).
// Also persists an umbrella connection row so publish-post routes this
// user through Postiz.
//
// Requires POSTIZ_API_KEY in the Supabase secrets (Settings → Developers →
// Public API on Postiz, cloud or self-hosted).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin, getUserIdFromAuthHeader } from "../_shared/oauth.ts";
import { getPostizKey, postizConnectUrl } from "../_shared/postiz.ts";

// Networks Postiz exposes via the OAuth connect endpoint.
const SUPPORTED = [
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
  "tiktok",
  "youtube",
  "pinterest",
  "threads",
  "bluesky",
  "reddit",
];

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });
  }

  if (!getPostizKey()) {
    return jsonResponse(
      { error: "Postiz non configuré. Définissez POSTIZ_API_KEY dans les secrets Supabase." },
      { status: 503, cors },
    );
  }

  const userId = await getUserIdFromAuthHeader(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  const body = (await req.json().catch(() => ({}))) as { platform?: string };
  const platform = (body.platform || "").toLowerCase();

  try {
    // Umbrella row: signals publish-post to use Postiz for this user.
    const admin = getSupabaseAdmin();
    const { error: upErr } = await admin.from("social_connections").upsert(
      {
        user_id: userId,
        provider: "postiz",
        platform: "all",
        account_id: "postiz-org",
        account_name: "Postiz",
        access_token: "postiz", // non-null placeholder; publisher uses POSTIZ_API_KEY
        meta: {},
      },
      { onConflict: "user_id,platform,account_id" },
    );
    if (upErr) console.error("postiz-connect upsert:", upErr);

    if (!platform) {
      return jsonResponse({ supported: SUPPORTED }, { cors });
    }
    if (!SUPPORTED.includes(platform)) {
      return jsonResponse({ error: `Plateforme non supportée: ${platform}` }, { status: 400, cors });
    }

    const connectUrl = await postizConnectUrl(platform);
    return jsonResponse({ connectUrl, platform }, { cors });
  } catch (err) {
    console.error("postiz-connect error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502, cors },
    );
  }
});
