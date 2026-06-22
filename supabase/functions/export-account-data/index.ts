// export-account-data: GDPR data portability (Art. 20). Returns the
// authenticated user's own data as a downloadable JSON document. Never
// includes secrets (OAuth tokens / profile keys are explicitly excluded).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server misconfigured" }, { status: 500, cors: corsHeaders });
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) {
    return jsonResponse({ error: "Not authenticated" }, { status: 401, cors: corsHeaders });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Invalid token" }, { status: 401, cors: corsHeaders });
  }
  const user = userData.user;
  const userId = user.id;

  try {
    const [profile, posts, comments, usage, connections] = await Promise.all([
      admin.from("profiles").select("*").eq("id", userId).maybeSingle(),
      admin.from("posts").select("*").eq("user_id", userId),
      admin.from("social_comments").select("*").eq("user_id", userId),
      admin.from("generation_usage").select("*").eq("user_id", userId),
      // Non-secret connection fields only — never export access/refresh tokens
      // or the provider profile key.
      admin
        .from("social_connections")
        .select(
          "id,provider,platform,account_name,account_username,created_at,updated_at,token_expires_at",
        )
        .eq("user_id", userId),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      account: { id: userId, email: user.email, created_at: user.created_at },
      profile: profile.data ?? null,
      posts: posts.data ?? [],
      comments: comments.data ?? [],
      generation_usage: usage.data ?? [],
      social_connections: connections.data ?? [],
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="pro-social-ai-export.json"`,
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, cors: corsHeaders },
    );
  }
});
