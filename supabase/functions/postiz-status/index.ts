// postiz-status: lists the social channels connected through Postiz so the
// dashboard can render per-platform connect indicators.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getUserIdFromAuthHeader } from "../_shared/oauth.ts";
import { getPostizKey, postizListIntegrations } from "../_shared/postiz.ts";

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const userId = await getUserIdFromAuthHeader(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  if (!getPostizKey()) {
    return jsonResponse(
      { provisioned: false, platforms: [], error: "POSTIZ_API_KEY missing" },
      { cors },
    );
  }

  try {
    const integrations = await postizListIntegrations();
    const channels = integrations
      .filter((i) => !i.disabled)
      .map((i) => ({
        id: i.id,
        name: i.name,
        identifier: i.identifier,
        picture: i.picture,
      }));
    // Normalise Postiz's 'x' back to our canonical 'twitter'.
    const platforms = Array.from(
      new Set(
        channels
          .map((c) => ((c.identifier || "").toLowerCase() === "x" ? "twitter" : (c.identifier || "").toLowerCase()))
          .filter(Boolean),
      ),
    );
    return jsonResponse({ provisioned: true, platforms, channels }, { cors });
  } catch (err) {
    console.error("postiz-status error:", err);
    return jsonResponse(
      { provisioned: true, platforms: [], error: err instanceof Error ? err.message : String(err) },
      { cors },
    );
  }
});
