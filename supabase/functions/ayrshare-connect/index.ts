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

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
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
    let mode: "business" | "shared" = "business";
    let connectUrl: string;

    if (!profileKey) {
      // Attempt to provision a per-user profile (Business Plan).
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

      if (createResp.ok) {
        const created = await createResp.json();
        profileKey = created.profileKey || created.profile_key || null;
      } else {
        // Free / Premium plans don't have per-user profiles. We fall
        // back to "shared mode": every Pro Social AI user posts through
        // the API key owner's single Ayrshare account.
        const text = await createResp.text();
        if (createResp.status === 403 || text.includes("business plan") || text.includes("Business Plan")) {
          mode = "shared";
        } else {
          return new Response(
            JSON.stringify({ error: `Ayrshare profile creation failed: ${text.slice(0, 300)}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    if (mode === "business" && profileKey) {
      // Per-user mode: generate a one-time JWT URL.
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
      connectUrl = jwtData.url;
    } else {
      // Shared mode: send the operator to Ayrshare's main dashboard
      // where they connect the social accounts that EVERY end-user of
      // this platform will publish to.
      mode = "shared";
      connectUrl = "https://app.ayrshare.com/social-accounts";
    }

    // Persist the umbrella row.
    const accountIdForRow = profileKey || `shared-${userId.slice(0, 8)}`;
    const { error: upsertError } = await supabase
      .from("social_connections")
      .upsert(
        {
          user_id: userId,
          provider: "ayrshare",
          platform: "all",
          account_id: accountIdForRow,
          account_name: mode === "business" ? "Ayrshare profile" : "Ayrshare (shared)",
          // NEVER persist the master AYRSHARE_API_KEY here: the publisher reads it
          // from env. Store a non-secret placeholder to satisfy the NOT NULL column.
          access_token: "managed-by-ayrshare",
          profile_key: profileKey,
          meta: { mode },
        },
        { onConflict: "user_id,platform,account_id" },
      );
    if (upsertError) {
      console.error("Failed to persist ayrshare connection:", upsertError);
    }

    return new Response(
      JSON.stringify({
        connectUrl,
        profileKey,
        mode,
        notice: mode === "shared"
          ? "Plan gratuit/Premium: tous les utilisateurs publient via votre compte Ayrshare. Pour une connexion par utilisateur, passez au Business Plan."
          : undefined,
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
