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
    console.log('Starting weekly auto-generation...');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get all users with auto_publish enabled
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*')
      .eq('auto_publish', true);

    if (profilesError) {
      console.error('Error fetching profiles:', profilesError);
      throw profilesError;
    }

    console.log(`Found ${profiles?.length || 0} profiles with auto_publish enabled`);

    const results = [];

    for (const profile of profiles || []) {
      try {
        console.log(`Processing user ${profile.id}...`);

        // Check how many posts are needed this week
        const postsNeeded = profile.post_frequency || 2;

        // Get current ISO week number (ISO 8601 standard)
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86400000) + 1;
        // ISO week: week containing the first Thursday of the year is week 1
        const startDayOfWeek = startOfYear.getDay() || 7; // Mon=1..Sun=7
        const weekNumber = Math.ceil((dayOfYear + startDayOfWeek - 2) / 7);

        // Check existing posts for this week
        const { data: existingPosts } = await supabase
          .from('posts')
          .select('id')
          .eq('user_id', profile.id)
          .eq('week_number', weekNumber);

        const postsToGenerate = Math.max(0, postsNeeded - (existingPosts?.length || 0));

        if (postsToGenerate === 0) {
          console.log(`User ${profile.id} already has enough posts for this week`);
          continue;
        }

        console.log(`Generating ${postsToGenerate} posts for user ${profile.id}`);

        // Generate posts
        for (let i = 0; i < postsToGenerate; i++) {
          // Generate content using Lovable AI
          const contentPrompt = `Tu es un expert en création de contenu pour les réseaux sociaux.

Génère un post engageant en français pour une entreprise avec ces caractéristiques:
- Secteur: ${profile.sector || 'Business'}
- Ton: ${profile.tone || 'Professionnel'}
- Description: ${profile.description || 'Entreprise innovante'}
- Nom: ${profile.company_name || 'Notre entreprise'}

Le post doit:
- Être en français uniquement
- Faire 60-100 mots maximum
- Inclure 2-3 émojis pertinents
- Apporter de la valeur (conseil, astuce, information)
- Être engageant et professionnel

Génère uniquement le texte du post, sans titre ni explication.`;

          const contentResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${lovableApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'google/gemini-2.5-flash',
              messages: [{ role: 'user', content: contentPrompt }],
            }),
          });

          const contentData = await contentResponse.json();
          const generatedContent = contentData.choices?.[0]?.message?.content || 'Contenu généré';

          // Calculate scheduled date based on preferred days
          // preferred_days can be stored as English IDs ("monday") or French labels ("Lundi")
          const preferredDays = profile.preferred_days || ['monday'];
          const dayMapping: Record<string, number> = {
            // French labels
            'Dimanche': 0, 'Lundi': 1, 'Mardi': 2, 'Mercredi': 3,
            'Jeudi': 4, 'Vendredi': 5, 'Samedi': 6,
            // English IDs (stored by onboarding form)
            'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
            'thursday': 4, 'friday': 5, 'saturday': 6,
          };

          const targetDay = preferredDays[i % preferredDays.length];
          const targetDayNumber = dayMapping[targetDay] ?? 1;
          
          const scheduledDate = new Date(now);
          const currentDay = scheduledDate.getDay();
          const daysUntilTarget = (targetDayNumber - currentDay + 7) % 7 || 7;
          scheduledDate.setDate(scheduledDate.getDate() + daysUntilTarget);
          scheduledDate.setHours(10, 0, 0, 0);

          // Create the post
          const { error: insertError } = await supabase
            .from('posts')
            .insert({
              user_id: profile.id,
              title: 'Contenu automatique',
              content: generatedContent,
              platforms: profile.platforms || ['Instagram'],
              status: 'pending',
              week_number: weekNumber,
              scheduled_for: scheduledDate.toISOString(),
            });

          if (insertError) {
            console.error(`Error inserting post for user ${profile.id}:`, insertError);
          } else {
            console.log(`Post created for user ${profile.id}`);
          }
        }

        results.push({ userId: profile.id, postsGenerated: postsToGenerate, success: true });
      } catch (userError) {
        console.error(`Error processing user ${profile.id}:`, userError);
        results.push({ userId: profile.id, error: String(userError), success: false });
      }
    }

    console.log('Weekly auto-generation completed');

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in auto-generate-weekly:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
