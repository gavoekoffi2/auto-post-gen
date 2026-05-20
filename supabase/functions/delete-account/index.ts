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
    try {
      const { data: files } = await admin.storage
        .from("user-assets")
        .list(userId, { limit: 1000 });
      if (files && files.length > 0) {
        const paths = files.map((f) => `${userId}/${f.name}`);
        await admin.storage.from("user-assets").remove(paths);
      }
    } catch (storageError) {
      console.error("Storage cleanup failed for", userId, storageError);
    }

    // 2. Delete app data. The auth.users delete cascades to public tables
    // that reference it via ON DELETE CASCADE, but we run explicit deletes
    // first so the order is deterministic and we can return a useful error.
    await admin.from("social_connections").delete().eq("user_id", userId);
    await admin.from("generation_usage").delete().eq("user_id", userId);
    await admin.from("posts").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);

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
