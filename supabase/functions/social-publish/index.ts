import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Map app platform names → Ayrshare platform IDs
const PLATFORM_MAP: Record<string, string> = {
  'Instagram': 'instagram',
  'Facebook': 'facebook',
  'Twitter': 'twitter',
  'LinkedIn': 'linkedin',
  'TikTok': 'tiktok',
  // lowercase fallbacks
  'instagram': 'instagram',
  'facebook': 'facebook',
  'twitter': 'twitter',
  'linkedin': 'linkedin',
  'tiktok': 'tiktok',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { postId } = await req.json();
    if (!postId) {
      return new Response(JSON.stringify({ error: 'postId requis' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ayrshareApiKey = Deno.env.get('AYRSHARE_API_KEY');

    if (!ayrshareApiKey) {
      return new Response(
        JSON.stringify({ error: 'AYRSHARE_API_KEY non configuré.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Authenticate user
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Session invalide' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the post
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .eq('user_id', user.id)
      .single();

    if (postError || !post) {
      return new Response(JSON.stringify({ error: 'Post introuvable' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (post.status !== 'validated') {
      return new Response(
        JSON.stringify({ error: 'Le post doit être validé avant publication' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch user profile (for Ayrshare profile key)
    const { data: profile } = await supabase
      .from('profiles')
      .select('ayrshare_profile_key')
      .eq('id', user.id)
      .single();

    if (!profile?.ayrshare_profile_key) {
      return new Response(
        JSON.stringify({
          error: 'Vos réseaux sociaux ne sont pas encore connectés via Ayrshare. Connectez-les d\'abord depuis "Réseaux sociaux".'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Map platforms
    const ayrsharePlatforms = (post.platforms || ['instagram'])
      .map((p: string) => PLATFORM_MAP[p])
      .filter(Boolean);

    if (ayrsharePlatforms.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Aucune plateforme valide sélectionnée' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build Ayrshare payload
    const ayrsharePayload: Record<string, unknown> = {
      post: post.content,
      platforms: ayrsharePlatforms,
      profileKey: profile.ayrshare_profile_key,
    };

    // Add image if available
    if (post.image_url) {
      ayrsharePayload.mediaUrls = [post.image_url];
    }

    // Schedule if date is in the future
    if (post.scheduled_for) {
      const scheduledDate = new Date(post.scheduled_for);
      if (scheduledDate > new Date()) {
        ayrsharePayload.scheduleDate = scheduledDate.toISOString();
      }
    }

    // Call Ayrshare API
    const publishResp = await fetch('https://app.ayrshare.com/api/post', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ayrshareApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ayrsharePayload),
    });

    const publishData = await publishResp.json();

    if (!publishResp.ok) {
      console.error('Ayrshare publish error:', publishData);
      return new Response(
        JSON.stringify({
          error: 'Erreur lors de la publication',
          detail: publishData?.message || publishData?.error || 'Erreur inconnue'
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update post status to published
    await supabase
      .from('posts')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
      })
      .eq('id', postId);

    return new Response(
      JSON.stringify({
        success: true,
        message: ayrsharePayload.scheduleDate
          ? 'Post programmé avec succès sur vos réseaux sociaux !'
          : 'Post publié avec succès sur vos réseaux sociaux !',
        ayrshareId: publishData.id,
        platforms: ayrsharePlatforms,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in social-publish:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
