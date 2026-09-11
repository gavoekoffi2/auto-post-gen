// Fully delete the authenticated user. Calls the admin API so even the
// auth.users row is removed.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server misconfigured" }, { status: 500, cors: corsHeaders });
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) {
    return jsonResponse({ error: "Not authenticated" }, { status: 401, cors: corsHeaders });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Invalid token" }, { status: 401, cors: corsHeaders });
  }
  const userId = userData.user.id;

  try {
    // 1. Best-effort: wipe storage objects under the user's folder.
    // Paginated: a single list(limit: 1000) left every object past the first
    // thousand behind, and an active account can mint 200 posters a month, so
    // a deletion could silently keep years of the user's images.
    try {
      const PAGE = 1000;
      // Always read the first page: each pass deletes what it read, so the next
      // page shifts down into the same window. Bounded so a removal that
      // silently no-ops ends the loop instead of spinning forever.
      const MAX_PASSES = 50;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const { data: files, error: listErr } = await admin.storage
          .from("user-assets")
          .list(userId, { limit: PAGE });
        if (listErr) throw listErr;
        if (!files || files.length === 0) break;
        const paths = files.map((f) => `${userId}/${f.name}`);
        const { error: removeErr } = await admin.storage.from("user-assets").remove(paths);
        if (removeErr) throw removeErr;
        if (files.length < PAGE) break;
        if (pass === MAX_PASSES - 1) {
          console.error(`Storage cleanup for ${userId} hit the pass limit; objects may remain.`);
        }
      }
    } catch (storageError) {
      console.error("Storage cleanup failed for", userId, storageError);
    }

    // 2. Delete app data. The auth.users delete cascades to public tables that
    // reference it, but we run explicit deletes first so the order is
    // deterministic. We check each step's error and ABORT before deleting the
    // auth user, so we never leave orphaned rows the user can no longer reach.
    // Read the Zernio profile key before the row is deleted (see 2b below).
    const { data: zernioRow } = await admin
      .from("social_connections")
      .select("profile_key")
      .eq("user_id", userId)
      .eq("provider", "zernio")
      .maybeSingle();
    const zernioProfileKey: string | null = zernioRow?.profile_key ?? null;

    const deletions: Array<{ table: string; run: PromiseLike<{ error: unknown }> }> = [
      { table: "social_comments", run: admin.from("social_comments").delete().eq("user_id", userId) },
      { table: "social_connections", run: admin.from("social_connections").delete().eq("user_id", userId) },
      { table: "generation_usage", run: admin.from("generation_usage").delete().eq("user_id", userId) },
      { table: "posts", run: admin.from("posts").delete().eq("user_id", userId) },
      { table: "profiles", run: admin.from("profiles").delete().eq("id", userId) },
    ];
    for (const { table, run } of deletions) {
      const { error } = await run;
      if (error) throw new Error(`Failed to delete ${table}: ${(error as { message?: string }).message ?? String(error)}`);
    }

    // 2b. The user's Zernio profile is NOT removed here: the Zernio API this
    // integration uses exposes no profile-deletion endpoint. The profile (and
    // any social account still connected under it) therefore survives the
    // deletion and keeps counting against the operator's Zernio plan. Remove it
    // by hand in the Zernio dashboard, or wire it up here if Zernio adds the
    // endpoint. Log the key so an operator can find it after the row is gone.
    if (zernioProfileKey) {
      console.warn(
        `delete-account: Zernio profile ${zernioProfileKey} (user ${userId}) must be removed manually — the API exposes no delete endpoint.`,
      );
    }

    // 3. Finally remove the auth.users row.
    const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserError) throw deleteUserError;

    return jsonResponse({ success: true }, { cors: corsHeaders });
  } catch (err) {
    console.error("delete-account error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, cors: corsHeaders },
    );
  }
});
