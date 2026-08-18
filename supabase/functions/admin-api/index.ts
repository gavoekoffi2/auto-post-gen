import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import { buildCorsHeaders, internalError, jsonResponse } from "../_shared/cors.ts";

// Canonical owner address. Overridable per-deployment so the address is not
// baked into the source; the historical default keeps existing installs working.
const FOUNDER_EMAIL = (Deno.env.get("ADMIN_FOUNDER_EMAIL") || "c1domefa@gmail.com")
  .trim()
  .toLowerCase();
const VALID_PLANS = new Set(["starter", "pro", "enterprise"]);

type AdminBody = {
  action?: string;
  userId?: string;
  email?: string;
  password?: string;
  plan?: string;
  role?: "user" | "admin" | "super_admin";
  blocked?: boolean;
  companyName?: string;
};

// True when at least one account already holds the super_admin role. Used to
// make the founder bootstrap one-time; scanning is fine here because the check
// only runs on the rare bootstrap path.
async function hasSuperAdmin(admin: SupabaseClient): Promise<boolean> {
  const MAX_PAGES = 10;
  const PER_PAGE = 1000;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    // Fail CLOSED: if we cannot prove the system is un-bootstrapped, refuse to
    // hand out super_admin.
    if (error) return true;
    const users = data?.users ?? [];
    if (users.some((u) => u.app_metadata?.role === "super_admin")) return true;
    if (users.length < PER_PAGE) return false;
  }
  return true;
}

function safeUser(user: User) {
  return {
    id: user.id,
    email: user.email ?? "",
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    role: user.app_metadata?.role ?? "user",
    blocked: !!user.banned_until && new Date(user.banned_until).getTime() > Date.now(),
  };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Méthode non autorisée" }, { status: 405, cors: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Service indisponible" }, { status: 500, cors: corsHeaders });
  }

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token) return jsonResponse({ error: "Connexion requise" }, { status: 401, cors: corsHeaders });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const actor = authData?.user;
  if (authError || !actor) {
    return jsonResponse({ error: "Session invalide" }, { status: 401, cors: corsHeaders });
  }

  // Founder bootstrap — genuinely ONE-TIME.
  //
  // Matching the founder email is NOT sufficient on its own: production runs
  // with mailer_autoconfirm enabled, so the address on a fresh account is an
  // unverified claim. If the founder account did not exist yet, anyone could
  // sign up as that address and be handed super_admin over every tenant.
  // The promotion therefore additionally requires that NO super_admin exists
  // yet, which closes the path permanently the moment the real owner is set up.
  // Afterwards, roles come only from app_metadata, which browser clients
  // cannot edit.
  let actorRole = actor.app_metadata?.role ?? "user";
  if (actor.email?.toLowerCase() === FOUNDER_EMAIL && actorRole !== "super_admin") {
    if (!(await hasSuperAdmin(admin))) {
      const { data, error } = await admin.auth.admin.updateUserById(actor.id, {
        app_metadata: { ...actor.app_metadata, role: "super_admin" },
      });
      if (error || !data.user) {
        return jsonResponse({ error: "Impossible d’activer le compte propriétaire" }, { status: 500, cors: corsHeaders });
      }
      actorRole = "super_admin";
    } else {
      console.error("Refused founder bootstrap: a super_admin already exists", actor.id);
    }
  }
  if (!new Set(["admin", "super_admin"]).has(actorRole)) {
    return jsonResponse({ error: "Accès administrateur requis" }, { status: 403, cors: corsHeaders });
  }

  let body: AdminBody = {};
  try { body = await req.json(); } catch { /* overview by default */ }
  const action = body.action || "overview";

  try {
    if (action === "me") {
      return jsonResponse({ user: { ...safeUser(actor), role: actorRole } }, { cors: corsHeaders });
    }

    if (action === "overview") {
      const { data: authList, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listError) throw listError;
      const users = authList.users;
      const ids = users.map((u) => u.id);
      const [profilesResult, postsResult, usageResult, connectionsResult] = await Promise.all([
        ids.length ? admin.from("profiles").select("id,email,company_name,sector,plan,created_at").in("id", ids) : Promise.resolve({ data: [], error: null }),
        admin.from("posts").select("user_id,status,created_at"),
        admin.from("generation_usage").select("user_id,status,created_at"),
        admin.from("social_connections").select("user_id,platform,provider,created_at"),
      ]);
      for (const result of [profilesResult, postsResult, usageResult, connectionsResult]) {
        if (result.error) throw result.error;
      }
      const profiles = new Map((profilesResult.data || []).map((p: Record<string, unknown>) => [p.id, p]));
      const postsByUser = new Map<string, { total: number; published: number }>();
      for (const post of postsResult.data || []) {
        const current = postsByUser.get(post.user_id) || { total: 0, published: 0 };
        current.total += 1;
        if (post.status === "published") current.published += 1;
        postsByUser.set(post.user_id, current);
      }
      const generationsByUser = new Map<string, number>();
      for (const item of usageResult.data || []) generationsByUser.set(item.user_id, (generationsByUser.get(item.user_id) || 0) + 1);
      const connectionsByUser = new Map<string, number>();
      for (const item of connectionsResult.data || []) connectionsByUser.set(item.user_id, (connectionsByUser.get(item.user_id) || 0) + 1);
      const enriched = users.map((user) => ({
        ...safeUser(user),
        profile: profiles.get(user.id) || null,
        posts: postsByUser.get(user.id) || { total: 0, published: 0 },
        generations: generationsByUser.get(user.id) || 0,
        connections: connectionsByUser.get(user.id) || 0,
      }));
      return jsonResponse({
        actor: { ...safeUser(actor), role: actorRole },
        stats: {
          users: users.length,
          active: enriched.filter((u) => !u.blocked).length,
          blocked: enriched.filter((u) => u.blocked).length,
          admins: enriched.filter((u) => u.role === "admin" || u.role === "super_admin").length,
          posts: (postsResult.data || []).length,
          published: (postsResult.data || []).filter((p) => p.status === "published").length,
          generations: (usageResult.data || []).length,
          connections: (connectionsResult.data || []).length,
        },
        users: enriched,
      }, { cors: corsHeaders });
    }

    if (actorRole !== "super_admin") {
      return jsonResponse({ error: "Action réservée au super administrateur" }, { status: 403, cors: corsHeaders });
    }

    if (action === "create_user") {
      const email = body.email?.trim().toLowerCase();
      if (!email || !body.password || body.password.length < 8) {
        return jsonResponse({ error: "Email et mot de passe (8 caractères minimum) requis" }, { status: 400, cors: corsHeaders });
      }
      const role = body.role || "user";
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: body.password,
        email_confirm: true,
        app_metadata: { role },
      });
      if (error || !data.user) throw error || new Error("Création impossible");
      if (body.plan && VALID_PLANS.has(body.plan)) {
        await admin.from("profiles").update({ plan: body.plan, company_name: body.companyName || null }).eq("id", data.user.id);
      }
      return jsonResponse({ success: true, user: safeUser(data.user) }, { cors: corsHeaders });
    }

    const targetId = body.userId;
    if (!targetId) return jsonResponse({ error: "Compte requis" }, { status: 400, cors: corsHeaders });
    const { data: targetData, error: targetError } = await admin.auth.admin.getUserById(targetId);
    if (targetError || !targetData.user) return jsonResponse({ error: "Compte introuvable" }, { status: 404, cors: corsHeaders });
    const target = targetData.user;
    const targetIsFounder = target.email?.toLowerCase() === FOUNDER_EMAIL;

    if (action === "set_plan") {
      if (!body.plan || !VALID_PLANS.has(body.plan)) return jsonResponse({ error: "Forfait invalide" }, { status: 400, cors: corsHeaders });
      const { error } = await admin.from("profiles").update({ plan: body.plan }).eq("id", targetId);
      if (error) throw error;
    } else if (action === "set_role") {
      if (!body.role || !new Set(["user", "admin", "super_admin"]).has(body.role)) return jsonResponse({ error: "Rôle invalide" }, { status: 400, cors: corsHeaders });
      if (targetIsFounder && body.role !== "super_admin") return jsonResponse({ error: "Le propriétaire principal ne peut pas être rétrogradé" }, { status: 400, cors: corsHeaders });
      const { error } = await admin.auth.admin.updateUserById(targetId, { app_metadata: { ...target.app_metadata, role: body.role } });
      if (error) throw error;
    } else if (action === "set_blocked") {
      if (targetIsFounder || targetId === actor.id) return jsonResponse({ error: "Ce compte ne peut pas être bloqué" }, { status: 400, cors: corsHeaders });
      const { error } = await admin.auth.admin.updateUserById(targetId, { ban_duration: body.blocked ? "876000h" : "none" });
      if (error) throw error;
    } else if (action === "reset_password") {
      if (!body.password || body.password.length < 8) return jsonResponse({ error: "Le mot de passe doit contenir au moins 8 caractères" }, { status: 400, cors: corsHeaders });
      const { error } = await admin.auth.admin.updateUserById(targetId, { password: body.password });
      if (error) throw error;
    } else if (action === "delete_user") {
      if (targetIsFounder || targetId === actor.id) return jsonResponse({ error: "Ce compte ne peut pas être supprimé" }, { status: 400, cors: corsHeaders });
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) throw error;
    } else {
      return jsonResponse({ error: "Action inconnue" }, { status: 400, cors: corsHeaders });
    }

    return jsonResponse({ success: true }, { cors: corsHeaders });
  } catch (error) {
    return internalError(`admin-api ${action}`, error, corsHeaders);
  }
});
