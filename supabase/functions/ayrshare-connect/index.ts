// deno-lint-ignore-file no-explicit-any
//
// ayrshare-connect: provisions a per-user Ayrshare profile if needed,
// then returns a one-time JWT URL the user can visit to authorise
// their social accounts. Ayrshare handles the OAuth dance for every
// supported platform; we never have to register a developer app on
// Meta / LinkedIn / X / TikTok / Pinterest / YouTube.
//
// Requires AYRSHARE_API_KEY in the Supabase secrets. Get one (free
// trial) at https://app.ayrshare.com/.
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
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const apiKey = Deno.env.get("AYRSHARE_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "Ayrshare not configured. Set AYRSHARE_API_KEY in Supabase secrets.",
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

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
    // Look for an existing Ayrshare row for this user.
    const { data: existing } = await supabase
      .from("social_connections")
      .select("id, profile_key")
      .eq("user_id", userId)
      .eq("provider", "ayrshare")
      .maybeSingle();

    let profileKey: string | null = existing?.profile_key || null;

    // 1. Provision a new Ayrshare profile if we don't have one yet.
    if (!profileKey) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("company_name, email")
        .eq("id", userId)
        .maybeSingle();
      const title = (profile?.company_name || profile?.email || `user-${userId.slice(0, 8)}`).slice(0, 60);

      const createResp = await fetch(`${AYRSHARE_BASE}/profiles/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title }),
      });
      if (!createResp.ok) {
        const text = await createResp.text();
        return new Response(
          JSON.stringify({ error: `Ayrshare profile creation failed: ${text.slice(0, 300)}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const created = await createResp.json();
      profileKey = created.profileKey || created.profile_key;
      if (!profileKey) {
        return new Response(
          JSON.stringify({ error: "Ayrshare did not return a profileKey" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Persist the umbrella row. We use platform='all' to indicate this
      // single connection covers every social platform the user authorises
      // through Ayrshare.
      const { error: upsertError } = await supabase
        .from("social_connections")
        .upsert(
          {
            user_id: userId,
            provider: "ayrshare",
            platform: "all",
            account_id: profileKey, // stored here so the unique key works
            account_name: title,
            access_token: profileKey, // not actually a token; placeholder for NOT NULL
            profile_key: profileKey,
          },
          { onConflict: "user_id,platform,account_id" },
        );
      if (upsertError) {
        console.error("Failed to persist ayrshare connection:", upsertError);
      }
    }

    // 2. Generate a one-time JWT URL the user can open to connect their
    //    social accounts through Ayrshare's UI.
    const jwtResp = await fetch(`${AYRSHARE_BASE}/profiles/generateJWT`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ profileKey }),
    });
    if (!jwtResp.ok) {
      const text = await jwtResp.text();
      return new Response(
        JSON.stringify({ error: `Ayrshare JWT failed: ${text.slice(0, 300)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const jwtData = await jwtResp.json();

    return new Response(
      JSON.stringify({
        connectUrl: jwtData.url,
        profileKey,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("ayrshare-connect error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
