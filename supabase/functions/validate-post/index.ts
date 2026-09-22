// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { clientIp, hitIpRateLimit } from "../_shared/rateLimit.ts";


// The validation email is sent by a weekly cron, and people read their mail on
// their own schedule. A 24h window measured from post CREATION (the previous
// behaviour) could be half spent before the email even went out, and a user
// opening it the next day hit a dead link with no way to ask for another one.
// One week, counted from when the email was actually sent, matches the weekly
// cadence of the product.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
        JSON.stringify({ error: "Lien invalide : jeton manquant." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Server misconfigured");
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    // Per-IP rate limit on this public, token-by-URL endpoint.
    const ip = clientIp(req);
    if (!(await hitIpRateLimit(supabase, `validate-post:${ip}`, 60, 3600))) {
      return new Response(
        JSON.stringify({ error: "Trop de tentatives. Réessayez plus tard." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: post, error } = await supabase
      .from("posts")
      .select("id,status,validation_token_created_at,validation_token_used_at,validation_email_sent_at")
      .eq("validation_token", token)
      .maybeSingle();

    if (error) throw error;
    if (!post) {
      return new Response(
        JSON.stringify({ error: "Lien de validation inconnu ou déjà annulé." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (post.validation_token_used_at) {
      return new Response(
        JSON.stringify({
          error: "Ce lien a déjà été utilisé : le post est validé.",
          postId: post.id,
        }),
        { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Count the lifetime from the moment the email left, falling back to the
    // token's creation date for posts predating that column.
    const issuedAt = post.validation_email_sent_at || post.validation_token_created_at;
    if (issuedAt) {
      const ageMs = Date.now() - new Date(issuedAt).getTime();
      if (ageMs > TOKEN_TTL_MS) {
        return new Response(
          JSON.stringify({
            error:
              "Ce lien de validation a expiré. Ouvrez votre tableau de bord pour valider le post directement.",
          }),
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
          error:
            post.status === "published"
              ? "Ce post est déjà publié."
              : "Ce post n'est plus en attente de validation. Consultez votre tableau de bord.",
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
        JSON.stringify({ error: "Le post vient d'être modifié ailleurs. Rechargez la page.", postId: post.id }),
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
