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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ayrshareApiKey = Deno.env.get('AYRSHARE_API_KEY');

    if (!ayrshareApiKey) {
      return new Response(
        JSON.stringify({ error: 'AYRSHARE_API_KEY non configuré. Ajoutez-la dans les secrets Supabase Edge Functions.' }),
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

    // Get user profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('company_name, ayrshare_profile_key')
      .eq('id', user.id)
      .single();

    // If user already has a profile key, just return the connection URL
    if (profile?.ayrshare_profile_key) {
      const connectUrl = `https://app.ayrshare.com/connect?cKey=${profile.ayrshare_profile_key}`;
      return new Response(
        JSON.stringify({ profileKey: profile.ayrshare_profile_key, connectUrl, alreadyExists: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create a new Ayrshare profile for this user
    const createResp = await fetch('https://app.ayrshare.com/api/profiles/profile', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ayrshareApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: profile?.company_name || user.email || `User-${user.id.substring(0, 8)}`,
      }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      console.error('Ayrshare create profile error:', errText);
      return new Response(
        JSON.stringify({ error: 'Erreur création profil Ayrshare', detail: errText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const ayrshareData = await createResp.json();
    const profileKey: string = ayrshareData.profileKey;

    if (!profileKey) {
      return new Response(
        JSON.stringify({ error: 'Aucune clé de profil reçue d\'Ayrshare', detail: ayrshareData }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save the profile key in Supabase
    await supabase
      .from('profiles')
      .update({ ayrshare_profile_key: profileKey })
      .eq('id', user.id);

    // Return the connection URL — user opens this to link their social accounts
    const connectUrl = `https://app.ayrshare.com/connect?cKey=${profileKey}`;

    return new Response(
      JSON.stringify({ profileKey, connectUrl, alreadyExists: false }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in create-ayrshare-profile:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
