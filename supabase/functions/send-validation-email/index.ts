// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendEmailWithResend(opts: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend send failed (${resp.status}): ${text}`);
  }

  return await resp.json();
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Cron-triggered or internal function: protect with a shared secret.
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (expectedSecret) {
    const provided =
      req.headers.get("x-cron-secret") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== expectedSecret) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase service credentials are not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const appBaseUrl = Deno.env.get("APP_BASE_URL") || supabaseUrl;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromAddress = Deno.env.get("RESEND_FROM") || "Pro Social AI <no-reply@example.com>";

    const { data: pendingPosts, error: postsError } = await supabase
      .from("posts")
      .select("id,title,content,image_url,platforms,scheduled_for,validation_token,validation_token_created_at,user_id")
      .eq("status", "pending")
      .not("validation_token", "is", null);

    if (postsError) throw postsError;

    const postsByUser: Record<string, any[]> = {};
    for (const post of pendingPosts || []) {
      if (!postsByUser[post.user_id]) postsByUser[post.user_id] = [];
      postsByUser[post.user_id].push(post);
    }

    const results: any[] = [];

    for (const [userId, userPosts] of Object.entries(postsByUser)) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("email, company_name")
          .eq("id", userId)
          .single();

        if (!profile?.email) {
          results.push({ userId, status: "skipped_no_email" });
          continue;
        }

        const companyName = profile.company_name || "Cher client";
        const emailHtml = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto;">
            <h2>Vos contenus de la semaine sont prêts!</h2>
            <p>Bonjour ${escapeHtml(companyName)},</p>
            <p>Voici les posts générés pour vous cette semaine. Cliquez sur "Valider" pour approuver leur publication.</p>
            <hr/>
            ${userPosts
              .map((post) => {
                const validateUrl = `${appBaseUrl}/validate-post?token=${encodeURIComponent(
                  post.validation_token,
                )}`;
                const scheduled = post.scheduled_for
                  ? new Date(post.scheduled_for).toLocaleDateString("fr-FR")
                  : "Non programmé";
                return `
                  <div style="margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 8px;">
                    <h3 style="margin:0 0 8px 0;">${escapeHtml(post.title || "")}</h3>
                    <p style="white-space:pre-wrap;">${escapeHtml(post.content || "")}</p>
                    ${
                      post.image_url
                        ? `<img src="${escapeHtml(post.image_url)}" alt="" style="max-width: 300px; border-radius: 8px;" />`
                        : ""
                    }
                    <p><strong>Plateformes:</strong> ${escapeHtml(
                      (post.platforms || []).join(", "),
                    )}</p>
                    <p><strong>Programmé pour:</strong> ${escapeHtml(scheduled)}</p>
                    <a href="${escapeHtml(validateUrl)}"
                       style="display: inline-block; padding: 10px 20px; background: linear-gradient(135deg, #8B5CF6, #3B82F6); color: white; text-decoration: none; border-radius: 8px; margin-top: 10px;">
                      Valider ce post
                    </a>
                  </div>
                `;
              })
              .join("")}
            <hr/>
            <p>Merci de votre confiance!</p>
            <p>L'équipe Pro Social AI</p>
          </div>
        `;

        if (!resendApiKey) {
          console.log(
            `[DRY-RUN] Would email ${profile.email} with ${userPosts.length} pending post(s). Set RESEND_API_KEY to actually send.`,
          );
          results.push({ userId, email: profile.email, postsCount: userPosts.length, status: "dry_run" });
          continue;
        }

        await sendEmailWithResend({
          apiKey: resendApiKey,
          from: fromAddress,
          to: profile.email,
          subject: `Vos ${userPosts.length} post(s) à valider`,
          html: emailHtml,
        });

        // Refresh tokens' created_at so they expire 24h from sending.
        const postIds = userPosts.map((p) => p.id);
        await supabase
          .from("posts")
          .update({ validation_token_created_at: new Date().toISOString() })
          .in("id", postIds);

        results.push({ userId, email: profile.email, postsCount: userPosts.length, status: "sent" });
      } catch (userError) {
        console.error(`Error processing user ${userId}:`, userError);
        results.push({ userId, error: String(userError), status: "failed" });
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in send-validation-email:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
