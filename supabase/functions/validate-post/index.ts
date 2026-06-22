// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const allowed =
    allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : allowedOrigins[0] === "*" ? "*" : allowedOrigins[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    Vary: "Origin",
  };
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let token: string | null = null;

    if (req.method === "GET") {
      const url = new URL(req.url);
      token = url.searchParams.get("token");
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      token = body?.token || null;
    } else {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!token || typeof token !== "string") {
      return new Response(
        JSON.stringify({ error: "Token is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Server misconfigured");
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: post, error } = await supabase
      .from("posts")
      .select("id,status,validation_token_created_at,validation_token_used_at")
      .eq("validation_token", token)
      .maybeSingle();

    if (error) throw error;
    if (!post) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (post.validation_token_used_at) {
      return new Response(
        JSON.stringify({ error: "Token already used", postId: post.id }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (post.validation_token_created_at) {
      const ageMs = Date.now() - new Date(post.validation_token_created_at).getTime();
      if (ageMs > TOKEN_TTL_MS) {
        return new Response(
          JSON.stringify({ error: "Token expired" }),
          { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Only validate posts currently in 'pending' state. This prevents a
    // leaked token from rolling back a post that's already been
    // published, failed or manually validated.
    if (post.status !== "pending") {
      return new Response(
        JSON.stringify({
          error: `Post is in state '${post.status}', cannot be validated via email link`,
          postId: post.id,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Atomic transition: only update if still pending.
    const { data: updated, error: updateError } = await supabase
      .from("posts")
      .update({
        status: "validated",
        validation_token_used_at: new Date().toISOString(),
      })
      .eq("id", post.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updated) {
      return new Response(
        JSON.stringify({ error: "Post status changed concurrently", postId: post.id }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, postId: post.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in validate-post:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
