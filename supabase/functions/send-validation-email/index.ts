import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Starting validation email process...');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get users with pending posts
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
        // Get user profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('email, company_name')
          .eq('id', userId)
          .single();

        if (!profile?.email) {
          console.log(`No email for user ${userId}, skipping`);
          continue;
        }

        // Build email content
        const emailContent = `
          <h2>Vos contenus de la semaine sont prêts!</h2>
          <p>Bonjour ${profile.company_name || 'Cher client'},</p>
          <p>Voici les posts générés pour vous cette semaine. Cliquez sur "Valider" pour approuver leur publication.</p>
          <hr/>
          ${userPosts.map(post => `
            <div style="margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 8px;">
              <h3>${post.title}</h3>
              <p>${post.content}</p>
              ${post.image_url ? `<img src="${post.image_url}" style="max-width: 300px; border-radius: 8px;" />` : ''}
              <p><strong>Plateformes:</strong> ${post.platforms?.join(', ')}</p>
              <p><strong>Programmé pour:</strong> ${post.scheduled_for ? new Date(post.scheduled_for).toLocaleDateString('fr-FR') : 'Non programmé'}</p>
              <a href="${supabaseUrl}/validate-post?token=${post.validation_token}" 
                 style="display: inline-block; padding: 10px 20px; background: linear-gradient(135deg, #8B5CF6, #3B82F6); color: white; text-decoration: none; border-radius: 8px; margin-top: 10px;">
                Valider ce post
              </a>
            </div>
          `).join('')}
          <hr/>
          <p>Merci de votre confiance!</p>
          <p>L'équipe Pro Social AI</p>
        `;

        console.log(`Email content prepared for user ${userId} (${profile.email})`);

        // Note: To actually send emails, you would need to integrate with an email service like Resend
        // For now, we log the email content
        console.log(`Would send email to: ${profile.email}`);
        console.log(`Posts count: ${userPosts.length}`);

        results.push({
          userId,
          email: profile.email,
          postsCount: userPosts.length,
          status: 'prepared'
        });

      } catch (userError) {
        console.error(`Error processing user ${userId}:`, userError);
        results.push({ userId, error: String(userError), status: 'failed' });
      }
    }

    console.log('Validation email process completed');

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Email preparation complete. Configure Resend to send actual emails.',
        results 
      }),
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
