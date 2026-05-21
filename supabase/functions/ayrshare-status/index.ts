// deno-lint-ignore-file no-explicit-any
//
// ayrshare-status: returns which social platforms the current user has
// connected through Ayrshare. The dashboard calls this to render the
// per-platform connect indicators.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const AYRSHARE_BASE = "https://app.ayrshare.com/api";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const wildcard = allowedOrigins.includes("*");
  const allowed = wildcard || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : wildcard ? "*" : allowedOrigins[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const apiKey = Deno.env.get("AYRSHARE_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "Server misconfigured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) {
    return new Response(
      JSON.stringify({ error: "Not authenticated" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return new Response(
      JSON.stringify({ error: "Invalid token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const userId = userData.user.id;

  try {
    const { data: existing } = await supabase
      .from("social_connections")
      .select("profile_key, meta")
      .eq("user_id", userId)
      .eq("provider", "ayrshare")
      .maybeSingle();

    if (!existing) {
      return new Response(
        JSON.stringify({ provisioned: false, platforms: [] }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!apiKey) {
      return new Response(
        JSON.stringify({ provisioned: true, platforms: [], error: "AYRSHARE_API_KEY missing" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const mode = (existing.meta as { mode?: string } | null)?.mode || (existing.profile_key ? "business" : "shared");

    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    // In Business mode we scope to the user's profile; in shared mode
    // we query the API key owner's main account.
    if (existing.profile_key) headers["Profile-Key"] = existing.profile_key;

    const resp = await fetch(`${AYRSHARE_BASE}/user`, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      return new Response(
        JSON.stringify({ provisioned: true, platforms: [], mode, error: text.slice(0, 200) }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const data = await resp.json();
    const platforms: string[] = data.activeSocialAccounts || data.socialNetworks || [];
    return new Response(
      JSON.stringify({ provisioned: true, platforms, mode }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("ayrshare-status error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
