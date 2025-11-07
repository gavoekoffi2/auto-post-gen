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

PROFIL DU CLIENT:
Secteur: ${userPreferences.sector}
Type de contenu: ${userPreferences.contentTypes?.join(', ') || 'mixte'}
Tonalité: ${userPreferences.tone}
Description de l'entreprise: ${userPreferences.description || ''}
${userPreferences.styleExample ? `Style de contenu préféré: ${userPreferences.styleExample}` : ''}

INSTRUCTIONS CRITIQUES:
- Génère un post UNIQUE et ORIGINAL à chaque fois (ne répète JAMAIS le même contenu)
- Le contenu doit être en FRANÇAIS UNIQUEMENT, 100% français
- Utilise des émojis pertinents pour rendre le post plus engageant et professionnel
- Adapte le contenu PRÉCISÉMENT au secteur: ${userPreferences.sector}
- Respecte la tonalité demandée: ${userPreferences.tone}
- Crée un post prêt à publier, accrocheur et parfaitement adapté
${userPreferences.styleExample ? '- Inspire-toi fortement de l\'exemple de style fourni pour créer un contenu similaire' : ''}
- Varie les sujets et angles d'approche pour chaque génération
- Le post doit refléter l'identité de l'entreprise: ${userPreferences.description || 'professionnel et engageant'}
- Si tu mentionnes le nom de l'entreprise, utilise "${userPreferences.description}" directement, JAMAIS entre crochets`
      : `Tu es un expert en création de contenu pour les réseaux sociaux. 

INSTRUCTIONS:
- Génère un post UNIQUE et ORIGINAL en français uniquement
- Utilise des émojis pertinents
- Crée un contenu professionnel, engageant et accrocheur
- Varie les sujets à chaque génération`;

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

    let imageUrl = null;

    // Check if user wants to use custom images
    if (userPreferences?.use_custom_images && userPreferences?.custom_image_urls?.length > 0) {
      // Pick a random image from the user's custom images
      const randomIndex = Math.floor(Math.random() * userPreferences.custom_image_urls.length);
      imageUrl = userPreferences.custom_image_urls[randomIndex];
      console.log('Using custom image from library:', imageUrl);
    } else {
      // Generate image with AI if no custom images
      const imagePrompt = `Crée une image illustrative professionnelle et visuelle pour ce post de réseaux sociaux: "${generatedContent.substring(0, 200)}..."
      
INSTRUCTIONS CRITIQUES:
- Image 100% visuelle SANS TEXTE (pas de mots, pas de lettres, pas de chiffres)
- Style professionnel et moderne
- Couleurs vives et attrayantes
- Composition équilibrée et esthétique
- Adaptée pour réseaux sociaux (Instagram, Facebook, LinkedIn)`;
      
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
              content: [
                { type: 'text', text: imagePrompt }
              ]
            }
          ],
          modalities: ["image", "text"]
        }),
      });

      if (imageResponse.ok) {
        const imageData = await imageResponse.json();
        imageUrl = imageData?.choices?.[0]?.message?.images?.[0]?.image_url?.url
          || imageData?.choices?.[0]?.message?.image_url?.url
          || null;

        // Fallback attempt with the non-preview image model if nothing returned
        if (!imageUrl) {
          const fallbackResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${LOVABLE_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'google/gemini-2.5-flash-image',
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: imagePrompt }
                  ]
                }
              ],
              modalities: ["image"]
            }),
          });

          if (fallbackResp.ok) {
            const fb = await fallbackResp.json();
            imageUrl = fb?.choices?.[0]?.message?.images?.[0]?.image_url?.url
              || fb?.choices?.[0]?.message?.image_url?.url
              || null;
          } else {
            console.error('Fallback image generation failed:', await fallbackResp.text());
          }
        }
      } else {
        console.error('Image generation failed:', await imageResponse.text());
      }
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