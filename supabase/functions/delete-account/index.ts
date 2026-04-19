// Fully deletes the caller's account: posts, profile, and the auth user.
// Requires verify_jwt = true so we can trust the Authorization header.

import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getServiceClient, getUserFromRequest } from '../_shared/auth.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const supabase = getServiceClient();

    await supabase.from('posts').delete().eq('user_id', user.id);
    await supabase.from('profiles').delete().eq('id', user.id);

    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) {
      console.error('admin.deleteUser failed:', error);
      return jsonResponse({ error: error.message }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('delete-account error:', message);
    return jsonResponse({ error: message }, 500);
  }
});
