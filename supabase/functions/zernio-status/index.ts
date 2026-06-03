// zernio-status: lists the social accounts the user connected through their
// Zernio profile so the dashboard can render per-platform indicators.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin, getUserIdFromAuthHeader } from "../_shared/oauth.ts";
import { getZernioKey, zernioListAccounts } from "../_shared/zernio.ts";

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const userId = await getUserIdFromAuthHeader(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  if (!getZernioKey()) {
    return jsonResponse(
      { provisioned: false, platforms: [], error: "ZERNIO_API_KEY missing" },
      { cors },
    );
  }

  try {
    const admin = getSupabaseAdmin();
    const { data: existing } = await admin
      .from("social_connections")
      .select("profile_key")
      .eq("user_id", userId)
      .eq("provider", "zernio")
      .maybeSingle();

    if (!existing) {
      return jsonResponse({ provisioned: false, platforms: [] }, { cors });
    }

    const accounts = await zernioListAccounts(existing.profile_key);
    const active = accounts.filter((a) => a.isActive !== false);
    const platforms = Array.from(
      new Set(active.map((a) => (a.platform || "").toLowerCase()).filter(Boolean)),
    );
    return jsonResponse(
      {
        provisioned: true,
        platforms,
        accounts: active.map((a) => ({
          id: a._id,
          platform: a.platform,
          username: a.username,
          displayName: a.displayName,
        })),
      },
      { cors },
    );
  } catch (err) {
    console.error("zernio-status error:", err);
    return jsonResponse(
      { provisioned: true, platforms: [], error: err instanceof Error ? err.message : String(err) },
      { cors },
    );
  }
});
