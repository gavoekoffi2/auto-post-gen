// Lists the Postiz integrations (connected social accounts) of the caller.
// Also caches them on profiles.postiz_integrations so the UI can show
// connection status even without hitting Postiz every time.

import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getServiceClient, getUserFromRequest } from '../_shared/auth.ts';
import {
  DEFAULT_POSTIZ_BASE_URL,
  PostizClient,
  PostizError,
} from '../_shared/postiz.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const supabase = getServiceClient();
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('postiz_api_key, postiz_base_url')
      .eq('id', user.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile?.postiz_api_key) {
      return jsonResponse({ integrations: [], configured: false });
    }

    const client = new PostizClient(
      profile.postiz_api_key,
      profile.postiz_base_url || DEFAULT_POSTIZ_BASE_URL,
    );

    const integrations = await client.listIntegrations();

    await supabase
      .from('profiles')
      .update({
        postiz_integrations: integrations,
        postiz_last_sync: new Date().toISOString(),
      })
      .eq('id', user.id);

    return jsonResponse({ integrations, configured: true });
  } catch (err) {
    console.error('postiz-integrations error:', err);
    if (err instanceof PostizError) {
      return jsonResponse(
        { error: `Postiz: ${err.message}`, status: err.status },
        err.status === 401 || err.status === 403 ? 401 : 502,
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
});
