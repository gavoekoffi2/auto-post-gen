import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { prompt, userPreferences } = await req.json();
    
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY not configured');
    }

    // Build system prompt based on user preferences (with defaults if profile not set)
    const systemPrompt = userPreferences 
      ? `Tu es un expert en création de contenu pour les réseaux sociaux. 
Secteur: ${userPreferences.sector}
Type de contenu: ${userPreferences.contentTypes?.join(', ') || 'mixte'}
Tonalité: ${userPreferences.tone}
Description de l'entreprise: ${userPreferences.description || ''}

Génère un post engageant et créatif qui respecte ces préférences. Le post doit être prêt à publier, accrocheur et adapté aux réseaux sociaux.`
      : `Tu es un expert en création de contenu pour les réseaux sociaux. Génère un post engageant et créatif, accrocheur et adapté aux réseaux sociaux.`;

    // Step 1: Generate text content
    const textResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt || 'Génère un post pertinent pour mon audience' }
        ],
      }),
    });

    if (!textResponse.ok) {
      if (textResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Limite de taux atteinte, réessayez plus tard.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (textResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: 'Crédit insuffisant, veuillez recharger votre compte.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const errorText = await textResponse.text();
      console.error('AI Gateway error:', textResponse.status, errorText);
      throw new Error('AI Gateway error');
    }

    const textData = await textResponse.json();
    const generatedContent = textData.choices[0].message.content;

    // Step 2: Generate image based on the content
    const imagePrompt = `Crée une image illustrative professionnelle pour ce post de réseaux sociaux: "${generatedContent.substring(0, 200)}..."`;
    
    const imageResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-image-preview',
        messages: [
          {
            role: 'user',
            content: imagePrompt
          }
        ],
        modalities: ["image", "text"]
      }),
    });

    let imageUrl = null;
    if (imageResponse.ok) {
      const imageData = await imageResponse.json();
      imageUrl = imageData.choices?.[0]?.message?.images?.[0]?.image_url?.url || null;
    } else {
      console.error('Image generation failed:', await imageResponse.text());
    }

    return new Response(
      JSON.stringify({ content: generatedContent, imageUrl }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error: any) {
    console.error('Error in generate-content:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});