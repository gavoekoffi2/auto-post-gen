import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

// Day mapping supporting both the legacy English ids and the French labels
// we now store. Falls back to 'Lundi' when unknown.
const DAY_TO_INDEX: Record<string, number> = {
  // French
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3,
  jeudi: 4, vendredi: 5, samedi: 6,
  // English
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function dayToIndex(day: string): number {
  return DAY_TO_INDEX[day?.toLowerCase?.()] ?? 1;
}

async function generateContent(lovableApiKey: string, profile: any): Promise<string> {
  const contentPrompt = `Tu es un expert en création de contenu pour les réseaux sociaux.

Génère un post engageant en français pour une entreprise avec ces caractéristiques:
- Secteur: ${profile.sector || 'Business'}
- Ton: ${profile.tone || 'Professionnel'}
- Description: ${profile.description || 'Entreprise innovante'}
- Nom: ${profile.company_name || 'Notre entreprise'}
- Type préféré: ${(profile.content_types || []).join(', ') || 'mixte'}

Règles:
- Uniquement en français
- 60-100 mots max
- 2-3 emojis pertinents
- Apporte de la valeur (conseil, astuce, info)
- Pro et engageant

Retourne uniquement le texte du post.`;

  const res = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
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
  if (!res.ok) {
    console.error('Content generation failed:', res.status, await res.text());
    return 'Contenu généré';
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'Contenu généré';
}

async function generateImage(lovableApiKey: string, profile: any, content: string): Promise<string | null> {
  // User wants to reuse their own library -> pick random.
  if (profile.use_custom_images && Array.isArray(profile.custom_image_urls) && profile.custom_image_urls.length > 0) {
    return profile.custom_image_urls[Math.floor(Math.random() * profile.custom_image_urls.length)];
  }

  const peopleType = profile.image_people_type || 'african';
  const peopleDescription = peopleType === 'african'
    ? 'des personnes africaines/noires ultra-réalistes'
    : 'des personnes caucasiennes/blanches ultra-réalistes';

  const prompt = `Image ultra-réaliste et professionnelle pour ce post: "${content.substring(0, 150)}..."

- Inclure ${peopleDescription}, expressions naturelles, contexte professionnel
- Aucun texte sur l'image (ni mot, ni lettre, ni chiffre)
- Photo-réaliste, éclairage naturel, couleurs vibrantes
- Format réseaux sociaux (carré ou portrait)`;

  try {
    const res = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-pro-image-preview',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        modalities: ['image', 'text'],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
        || data?.choices?.[0]?.message?.image_url?.url
        || null;
  } catch (err) {
    console.error('Image generation failed:', err);
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');

    if (!lovableApiKey) {
      return jsonResponse({ error: 'LOVABLE_API_KEY missing' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*')
      .eq('auto_publish', true);

    if (profilesError) throw profilesError;

    console.log(`Found ${profiles?.length ?? 0} profile(s) with auto_publish`);

    const results: Array<Record<string, unknown>> = [];
    const now = new Date();

    // ISO week number
    const tmp = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNumber = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

    for (const profile of profiles ?? []) {
      try {
        const postsNeeded = profile.post_frequency || 2;

        const { data: existingPosts } = await supabase
          .from('posts')
          .select('id')
          .eq('user_id', profile.id)
          .eq('week_number', weekNumber);

        const toGenerate = Math.max(0, postsNeeded - (existingPosts?.length ?? 0));
        if (toGenerate === 0) {
          results.push({ userId: profile.id, skipped: 'already-enough' });
          continue;
        }

        const preferredDays: string[] = profile.preferred_days && profile.preferred_days.length > 0
          ? profile.preferred_days
          : ['Lundi', 'Mercredi', 'Vendredi'];

        for (let i = 0; i < toGenerate; i++) {
          const content = await generateContent(lovableApiKey, profile);
          const imageUrl = await generateImage(lovableApiKey, profile, content);

          const targetDay = preferredDays[i % preferredDays.length];
          const targetDayIndex = dayToIndex(targetDay);

          const scheduled = new Date(now);
          const currentDay = scheduled.getDay();
          const delta = (targetDayIndex - currentDay + 7) % 7 || 7;
          scheduled.setDate(scheduled.getDate() + delta);
          scheduled.setHours(10, 0, 0, 0);

          const { error: insertError } = await supabase.from('posts').insert({
            user_id: profile.id,
            title: 'Contenu hebdomadaire',
            content,
            image_url: imageUrl,
            platforms: profile.platforms || ['Instagram'],
            status: 'pending',
            week_number: weekNumber,
            scheduled_for: scheduled.toISOString(),
          });

          if (insertError) {
            console.error(`Insert failed for ${profile.id}:`, insertError);
          }
        }

        results.push({ userId: profile.id, generated: toGenerate });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`User ${profile.id} failed:`, message);
        results.push({ userId: profile.id, error: message });
      }
    }

    return jsonResponse({ success: true, weekNumber, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('auto-generate-weekly error:', message);
    return jsonResponse({ error: message }, 500);
  }
});
