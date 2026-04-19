import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

async function sendWithResend(args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: args.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: text };
  try {
    const data = JSON.parse(text);
    return { ok: true, id: data?.id };
  } catch {
    return { ok: true };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'Pro Social AI <noreply@prosocialai.app>';
    const appUrl = Deno.env.get('APP_URL') || '';

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: pendingPosts, error: postsError } = await supabase
      .from('posts')
      .select('id, title, content, image_url, platforms, scheduled_for, validation_token, user_id')
      .eq('status', 'pending')
      .not('validation_token', 'is', null);

    if (postsError) throw postsError;

    const postsByUser: Record<string, typeof pendingPosts> = {};
    for (const post of pendingPosts || []) {
      (postsByUser[post.user_id] ||= []).push(post);
    }

    const results: Array<Record<string, unknown>> = [];

    for (const [userId, userPosts] of Object.entries(postsByUser)) {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('email, company_name')
          .eq('id', userId)
          .single();

        if (!profile?.email) {
          results.push({ userId, skipped: 'no-email' });
          continue;
        }

        const html = `
          <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:auto;">
            <h2 style="background:linear-gradient(135deg,#8B5CF6,#3B82F6);color:#fff;padding:16px;border-radius:12px 12px 0 0;margin:0">
              Vos contenus de la semaine sont prêts 🚀
            </h2>
            <div style="padding:16px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
              <p>Bonjour ${profile.company_name || 'Cher client'},</p>
              <p>Voici les posts générés pour vous cette semaine. Cliquez sur "Valider" pour les approuver.</p>
              ${userPosts!.map(post => `
                <div style="margin:16px 0;padding:14px;border:1px solid #eee;border-radius:10px;">
                  <h3 style="margin:0 0 8px 0">${post.title}</h3>
                  <p style="white-space:pre-wrap">${post.content}</p>
                  ${post.image_url ? `<img src="${post.image_url}" style="max-width:100%;border-radius:8px;margin:8px 0" />` : ''}
                  <p style="color:#666;font-size:13px;margin:4px 0">
                    <strong>Plateformes:</strong> ${(post.platforms || []).join(', ')}
                  </p>
                  <p style="color:#666;font-size:13px;margin:4px 0">
                    <strong>Programmé pour:</strong> ${post.scheduled_for ? new Date(post.scheduled_for).toLocaleString('fr-FR') : 'Non programmé'}
                  </p>
                  ${appUrl ? `
                    <a href="${appUrl}/dashboard?validate=${post.validation_token}"
                       style="display:inline-block;padding:10px 18px;margin-top:8px;background:linear-gradient(135deg,#8B5CF6,#3B82F6);color:#fff;text-decoration:none;border-radius:8px;">
                      Valider ce post
                    </a>` : ''}
                </div>
              `).join('')}
              <p style="margin-top:16px">Merci de votre confiance,<br/>L'équipe Pro Social AI</p>
            </div>
          </div>
        `;

        if (resendApiKey) {
          const r = await sendWithResend({
            apiKey: resendApiKey,
            from: fromEmail,
            to: profile.email,
            subject: `${userPosts!.length} post(s) à valider — Pro Social AI`,
            html,
          });
          results.push({
            userId,
            email: profile.email,
            postsCount: userPosts!.length,
            status: r.ok ? 'sent' : 'failed',
            error: r.error,
            id: r.id,
          });
        } else {
          console.log('RESEND_API_KEY not configured — email preview only');
          results.push({
            userId,
            email: profile.email,
            postsCount: userPosts!.length,
            status: 'prepared',
            note: 'Set RESEND_API_KEY to actually send emails',
          });
        }
      } catch (userError) {
        const message = userError instanceof Error ? userError.message : String(userError);
        results.push({ userId, error: message, status: 'failed' });
      }
    }

    return jsonResponse({
      success: true,
      mode: resendApiKey ? 'sent' : 'preview-only',
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('send-validation-email error:', message);
    return jsonResponse({ error: message }, 500);
  }
});
