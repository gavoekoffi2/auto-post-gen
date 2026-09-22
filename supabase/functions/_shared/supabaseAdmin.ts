// Service-role Supabase client + JWT verification, shared by the edge
// functions that authenticate the caller themselves.
//
// This was `_shared/oauth.ts`, which also carried HMAC state signing, redirect
// URI building, a connection upsert and HTML success/error pages for the
// direct per-platform OAuth flows. Those flows were removed with the switch to
// Zernio-only, leaving eight unused exports — including one that demanded an
// OAUTH_STATE_SECRET operators were still being told to configure. Only the
// two pieces anything actually uses are kept, with their behaviour unchanged.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

export function getSupabaseAdmin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server misconfigured");
  return createClient(url, key);
}

/** The caller's user id from a Bearer token, or null when it is absent/invalid. */
export async function getUserIdFromAuthHeader(
  authHeader: string | null,
): Promise<string | null> {
  if (!authHeader) return null;
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user.id;
}
