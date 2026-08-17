import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";

const FOUNDER_EMAIL = "c1domefa@gmail.com";
const VALID_PLANS = new Set(["starter", "pro", "enterprise"]);
const VALID_ROLES = new Set(["user", "admin", "super_admin"]);

// PostgREST caps an unbounded select at 1000 rows, so the overview's totals
// silently stopped counting past the first 1000 posts / generations /
// connections. Page through explicitly instead, with a hard ceiling so a huge
// table cannot run the function past the edge timeout.
const PAGE_SIZE = 1000;
const MAX_PAGES = 25;
// Ids go into an `in(...)` filter, i.e. the query string — keep each request's
// URL a sane length.
const ID_CHUNK_SIZE = 200;

async function fetchAllRows<T>(
  // deno-lint-ignore no-explicit-any
  build: () => any,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data || []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

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

  // One-time founder bootstrap: only the already-authenticated canonical owner
  // email can promote itself. Every subsequent request relies on app_metadata,
  // which ordinary browser clients cannot edit.
  let actorRole = actor.app_metadata?.role ?? "user";
  if (actor.email?.toLowerCase() === FOUNDER_EMAIL && actorRole !== "super_admin") {
    const { data, error } = await admin.auth.admin.updateUserById(actor.id, {
      app_metadata: { ...actor.app_metadata, role: "super_admin" },
    });
    if (error || !data.user) {
      return jsonResponse({ error: "Impossible d’activer le compte propriétaire" }, { status: 500, cors: corsHeaders });
    }
    actorRole = "super_admin";
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
      // listUsers is also paginated; a single page stopped at 1000 accounts.
      const users: User[] = [];
      let usersTruncated = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data: authList, error: listError } = await admin.auth.admin.listUsers({
          page,
          perPage: PAGE_SIZE,
        });
        if (listError) throw listError;
        users.push(...authList.users);
        if (authList.users.length < PAGE_SIZE) break;
        if (page === MAX_PAGES) usersTruncated = true;
      }
      // `in(...)` puts every id in the query string, so it is chunked rather
      // than sent as one enormous URL once the account count grows.
      const ids = users.map((u) => u.id);
      const idChunks: string[][] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
        idChunks.push(ids.slice(i, i + ID_CHUNK_SIZE));
      }
      const [profilesResult, postsResult, usageResult, connectionsResult] = await Promise.all([
        (async () => {
          const rows: Record<string, unknown>[] = [];
          for (const chunk of idChunks) {
            const page = await fetchAllRows<Record<string, unknown>>(() =>
              admin.from("profiles").select("id,email,company_name,sector,plan,created_at").in("id", chunk)
            );
            rows.push(...page.rows);
          }
          return { rows, truncated: false };
        })(),
        fetchAllRows<{ user_id: string; status: string }>(() =>
          admin.from("posts").select("user_id,status,created_at")
        ),
        fetchAllRows<{ user_id: string }>(() =>
          admin.from("generation_usage").select("user_id,status,created_at")
        ),
        fetchAllRows<{ user_id: string }>(() =>
          admin.from("social_connections").select("user_id,platform,provider,created_at")
        ),
      ]);
      const truncated = usersTruncated ||
        [profilesResult, postsResult, usageResult, connectionsResult].some((r) => r.truncated);
      const profiles = new Map(profilesResult.rows.map((p) => [p.id, p]));
      const postsByUser = new Map<string, { total: number; published: number }>();
      for (const post of postsResult.rows) {
        const current = postsByUser.get(post.user_id) || { total: 0, published: 0 };
        current.total += 1;
        if (post.status === "published") current.published += 1;
        postsByUser.set(post.user_id, current);
      }
      const generationsByUser = new Map<string, number>();
      for (const item of usageResult.rows) generationsByUser.set(item.user_id, (generationsByUser.get(item.user_id) || 0) + 1);
      const connectionsByUser = new Map<string, number>();
      for (const item of connectionsResult.rows) connectionsByUser.set(item.user_id, (connectionsByUser.get(item.user_id) || 0) + 1);
      const enriched = users.map((user) => ({
        ...safeUser(user),
        profile: profiles.get(user.id) || null,
        posts: postsByUser.get(user.id) || { total: 0, published: 0 },
        generations: generationsByUser.get(user.id) || 0,
        connections: connectionsByUser.get(user.id) || 0,
      }));
      return jsonResponse({
        actor: { ...safeUser(actor), role: actorRole },
        // true when a table exceeded MAX_PAGES × PAGE_SIZE rows, so the UI can
        // say the totals are a floor rather than quietly showing a wrong number.
        truncated,
        stats: {
          users: users.length,
          active: enriched.filter((u) => !u.blocked).length,
          blocked: enriched.filter((u) => u.blocked).length,
          admins: enriched.filter((u) => u.role === "admin" || u.role === "super_admin").length,
          posts: postsResult.rows.length,
          published: postsResult.rows.filter((p) => p.status === "published").length,
          generations: usageResult.rows.length,
          connections: connectionsResult.rows.length,
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
      // `role` lands in app_metadata, which every later authorisation check
      // reads. set_role validated it; create_user did not, so an arbitrary
      // string could be persisted as a role.
      const role = body.role ?? "user";
      if (!VALID_ROLES.has(role)) {
        return jsonResponse({ error: "Rôle invalide" }, { status: 400, cors: corsHeaders });
      }
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
      if (!body.role || !VALID_ROLES.has(body.role)) return jsonResponse({ error: "Rôle invalide" }, { status: 400, cors: corsHeaders });
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
    console.error("admin-api", action, error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Erreur interne" }, { status: 500, cors: corsHeaders });
  }
});
