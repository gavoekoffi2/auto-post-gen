import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// Builds a Supabase service-role client. Used in edge functions that must
// perform privileged operations (fetching a user's profile/postiz key, etc).
export function getServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    throw new Error('Supabase env vars missing (SUPABASE_URL / SERVICE_ROLE_KEY)');
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Resolves the caller user id from the incoming Authorization header.
// Returns null when no (or invalid) token is present.
export async function getUserFromRequest(
  req: Request,
): Promise<{ id: string; email?: string | null } | null> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return null;

  const client = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}
