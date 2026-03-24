import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Starting validation email process...');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    // App URL for validation links (set this in Edge Function env vars)
    const appUrl = Deno.env.get('APP_URL') || 'https://your-app-domain.com';

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get users with pending posts that have a validation token
    const { data: pendingPosts, error: postsError } = await supabase
      .from('posts')
      .select(`
        id,
        title,
        content,
        image_url,
        platforms,
        scheduled_for,
        validation_token,
        user_id
      `)
      .eq('status', 'pending')
      .not('validation_token', 'is', null);

    if (postsError) {
      console.error('Error fetching pending posts:', postsError);
      throw postsError;
    }

    console.log(`Found ${pendingPosts?.length || 0} pending posts`);

    // Group posts by user
    const postsByUser: Record<string, typeof pendingPosts> = {};
    for (const post of pendingPosts || []) {
      if (!postsByUser[post.user_id]) {
        postsByUser[post.user_id] = [];
      }
      postsByUser[post.user_id].push(post);
    }

    const results = [];

    for (const [userId, userPosts] of Object.entries(postsByUser)) {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('email, company_name')
          .eq('id', userId)
          .single();

        if (!profile?.email) {
          console.log(`No email for user ${userId}, skipping`);
          continue;
        }

        // Build email HTML
        const emailHtml = `
          <!DOCTYPE html>
          <html lang="fr">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Vos contenus de la semaine</title>
          </head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9;">
            <div style="background: white; border-radius: 12px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
              <div style="text-align: center; margin-bottom: 24px;">
                <h1 style="background: linear-gradient(135deg, #8B5CF6, #3B82F6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0;">Pro Social AI</h1>
              </div>
              <h2 style="color: #1a1a1a;">Vos contenus de la semaine sont prêts !</h2>
              <p style="color: #555;">Bonjour ${profile.company_name || 'Cher client'},</p>
              <p style="color: #555;">Voici les posts générés pour vous cette semaine. Cliquez sur <strong>Valider</strong> pour approuver leur publication.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;"/>
              ${(userPosts || []).map(post => `
                <div style="margin: 20px 0; padding: 20px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fafafa;">
                  <h3 style="color: #1a1a1a; margin-top: 0;">${post.title || 'Nouveau post'}</h3>
                  <p style="color: #444; white-space: pre-wrap; line-height: 1.6;">${post.content}</p>
                  ${post.image_url ? `<img src="${post.image_url}" alt="Illustration" style="max-width: 100%; border-radius: 8px; margin: 12px 0;" />` : ''}
                  <p style="color: #666; font-size: 14px;"><strong>Plateformes :</strong> ${post.platforms?.join(', ') || 'Instagram'}</p>
                  ${post.scheduled_for ? `<p style="color: #666; font-size: 14px;"><strong>Programmé pour :</strong> ${new Date(post.scheduled_for).toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>` : ''}
                  <a href="${appUrl}/validate-post?token=${post.validation_token}"
                     style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #8B5CF6, #3B82F6); color: white; text-decoration: none; border-radius: 8px; margin-top: 12px; font-weight: bold;">
                    ✅ Valider ce post
                  </a>
                </div>
              `).join('')}
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;"/>
              <p style="color: #888; font-size: 13px; text-align: center;">
                Merci de votre confiance !<br/>
                L'équipe <strong>Pro Social AI</strong>
              </p>
            </div>
          </body>
          </html>
        `;

        let emailStatus = 'prepared';

        if (resendApiKey) {
          // Send real email via Resend
          const resendResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Pro Social AI <noreply@your-domain.com>',
              to: [profile.email],
              subject: `🎉 Vos ${userPosts?.length || 0} posts de la semaine sont prêts à valider !`,
              html: emailHtml,
            }),
          });

          if (resendResponse.ok) {
            const resendData = await resendResponse.json();
            console.log(`Email sent to ${profile.email}, id: ${resendData.id}`);
            emailStatus = 'sent';
          } else {
            const errText = await resendResponse.text();
            console.error(`Resend error for ${profile.email}:`, errText);
            emailStatus = 'failed';
          }
        } else {
          console.warn('RESEND_API_KEY not configured — email not sent. Add it to Edge Function secrets.');
        }

        results.push({
          userId,
          email: profile.email,
          postsCount: userPosts?.length || 0,
          status: emailStatus,
        });

      } catch (userError) {
        console.error(`Error processing user ${userId}:`, userError);
        results.push({ userId, error: String(userError), status: 'failed' });
      }
    }

    console.log('Validation email process completed');

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in send-validation-email:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
