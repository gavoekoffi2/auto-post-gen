import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { runHealthChecks } from "../_shared/health.ts";
import { emailLayout, escapeHtml, formatFcfa, getEmailConfig, sendEmail } from "../_shared/email.ts";
import { ENTITLEMENT_COLUMNS, PLAN_LIMITS, isPlanId, type PlanId } from "../_shared/plans.ts";

// Canonical owner account, overridable without a code change. Keep the default
// so an existing deployment behaves identically when the secret is not set.
const FOUNDER_EMAIL = (Deno.env.get("FOUNDER_EMAIL") || "c1domefa@gmail.com")
  .trim()
  .toLowerCase();
const VALID_PLANS = new Set(["starter", "pro", "enterprise"]);
const MAX_TRIAL_EXTENSION_DAYS = 30;

type AdminBody = {
  action?: string;
  userId?: string;
  email?: string;
  password?: string;
  plan?: string;
  role?: "user" | "admin" | "super_admin";
  blocked?: boolean;
  companyName?: string;
  requestId?: string;
  note?: string;
  days?: number;
};

/**
 * Same calendar day `months` later, clamped to the end of a shorter month
 * (31 January + 1 month = 28/29 February, not 3 March).
 */
function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function formatDateFr(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Abidjan" });
}

// GoTrue returns banned_until on the user, but supabase-js does not type it.
function isBanned(user: User): boolean {
  const bannedUntil = (user as User & { banned_until?: string | null }).banned_until;
  return !!bannedUntil && new Date(bannedUntil).getTime() > Date.now();
}

function safeUser(user: User) {
  return {
    id: user.id,
    email: user.email ?? "",
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    role: user.app_metadata?.role ?? "user",
    blocked: isBanned(user),
    // The owner account cannot be demoted, blocked or deleted (enforced below).
    // Sent to the admin UI so it does not have to embed the owner's email
    // address in the public JS bundle to grey out those controls.
    protectedOwner: (user.email ?? "").toLowerCase() === FOUNDER_EMAIL,
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

    // Operational self-diagnosis: configuration, live provider probes and
    // pipeline signals (overdue publications, stuck jobs, silent cron). The
    // platform had no observability at all before this; an expired key or a
    // cron that stopped firing was only discovered through a user complaint.
    if (action === "health") {
      return jsonResponse(await runHealthChecks(admin), { cors: corsHeaders });
    }

    if (action === "overview") {
      const { data: authList, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listError) throw listError;
      const users = authList.users;
      const ids = users.map((u) => u.id);
      // Per-user aggregation needs the rows, but PostgREST caps how many it
      // returns. Fetching rows and calling .length would therefore report a
      // number that quietly stops growing — an admin dashboard that lies is
      // worse than one that says it is truncated. The HEADLINE totals below
      // come from exact COUNT queries instead, which are cheap and correct
      // whatever the row cap is.
      const ROW_CAP = 5000;
      const [
        profilesResult,
        postsResult,
        usageResult,
        connectionsResult,
        postsTotal,
        publishedTotal,
        usageTotal,
        connectionsTotal,
        pendingSubscriptions,
      ] = await Promise.all([
        ids.length ? admin.from("profiles").select(`id,email,company_name,sector,created_at,${ENTITLEMENT_COLUMNS}`).in("id", ids) : Promise.resolve({ data: [], error: null }),
        admin.from("posts").select("user_id,status").order("created_at", { ascending: false }).limit(ROW_CAP),
        admin.from("generation_usage").select("user_id").order("created_at", { ascending: false }).limit(ROW_CAP),
        admin.from("social_connections").select("user_id").order("created_at", { ascending: false }).limit(ROW_CAP),
        admin.from("posts").select("id", { count: "exact", head: true }),
        admin.from("posts").select("id", { count: "exact", head: true }).eq("status", "published"),
        admin.from("generation_usage").select("id", { count: "exact", head: true }),
        admin.from("social_connections").select("id", { count: "exact", head: true }),
        admin.from("subscription_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      ]);
      // The count queries belong in this guard too. Left out, a failed count
      // became `?? 0` or fell back to the length of the truncated sample — the
      // dashboard would report "0 published" for a platform with thousands,
      // silently, which is the exact failure this pair of queries replaced.
      for (const result of [
        profilesResult, postsResult, usageResult, connectionsResult,
        postsTotal, publishedTotal, usageTotal, connectionsTotal, pendingSubscriptions,
      ]) {
        if (result.error) throw result.error;
      }
      // True once a per-user column is computed from a truncated sample, so
      // the UI can say so rather than present it as complete.
      const perUserTruncated =
        (postsResult.data || []).length >= ROW_CAP ||
        (usageResult.data || []).length >= ROW_CAP ||
        (connectionsResult.data || []).length >= ROW_CAP;
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
          // Exact counts; the guard above means a failure surfaces as an
          // error rather than as a plausible-looking wrong number.
          posts: postsTotal.count ?? 0,
          published: publishedTotal.count ?? 0,
          generations: usageTotal.count ?? 0,
          connections: connectionsTotal.count ?? 0,
          pendingSubscriptions: pendingSubscriptions.count ?? 0,
        },
        perUserTruncated,
        users: enriched,
      }, { cors: corsHeaders });
    }

    // Payment declarations to verify, newest first, with who sent them.
    if (action === "subscriptions") {
      const { data: requests, error } = await admin
        .from("subscription_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const userIds = [...new Set((requests || []).map((r) => r.user_id))];
      const { data: owners, error: ownersError } = userIds.length
        ? await admin.from("profiles").select(`id,email,company_name,${ENTITLEMENT_COLUMNS}`).in("id", userIds)
        : { data: [], error: null };
      if (ownersError) throw ownersError;
      const byId = new Map((owners || []).map((o) => [o.id, o]));
      return jsonResponse({
        requests: (requests || []).map((r) => ({ ...r, profile: byId.get(r.user_id) || null })),
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
      // With a plan, the operator is granting it (no end date); without one
      // the account gets the same free trial as a self-service signup.
      const granted = body.plan && VALID_PLANS.has(body.plan)
        ? { plan: body.plan, subscription_status: "active", current_period_ends_at: null }
        : {};
      if (body.companyName || Object.keys(granted).length) {
        const { error: profileError } = await admin
          .from("profiles")
          .update({ ...granted, ...(body.companyName ? { company_name: body.companyName } : {}) })
          .eq("id", data.user.id);
        if (profileError) throw profileError;
      }
      return jsonResponse({ success: true, user: safeUser(data.user) }, { cors: corsHeaders });
    }

    if (action === "approve_subscription" || action === "reject_subscription") {
      if (!body.requestId) return jsonResponse({ error: "Demande requise" }, { status: 400, cors: corsHeaders });
      const { data: request, error: requestError } = await admin
        .from("subscription_requests")
        .select("*")
        .eq("id", body.requestId)
        .maybeSingle();
      if (requestError) throw requestError;
      if (!request) return jsonResponse({ error: "Demande introuvable" }, { status: 404, cors: corsHeaders });
      if (request.status !== "pending") {
        return jsonResponse({ error: "Cette demande a déjà été traitée" }, { status: 409, cors: corsHeaders });
      }
      const { data: owner, error: ownerError } = await admin
        .from("profiles")
        .select(`email, company_name, ${ENTITLEMENT_COLUMNS}`)
        .eq("id", request.user_id)
        .maybeSingle();
      if (ownerError) throw ownerError;
      if (!owner) return jsonResponse({ error: "Compte introuvable" }, { status: 404, cors: corsHeaders });

      const decidedAt = new Date();
      const note = (body.note || "").trim().slice(0, 500) || null;
      // Claim the request first, conditionally on it still being pending, so
      // two admins clicking at once cannot grant the same payment twice.
      const { data: claimed, error: claimError } = await admin
        .from("subscription_requests")
        .update({
          status: action === "approve_subscription" ? "approved" : "rejected",
          admin_note: note,
          decided_at: decidedAt.toISOString(),
          decided_by: actor.id,
        })
        .eq("id", request.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) return jsonResponse({ error: "Cette demande a déjà été traitée" }, { status: 409, cors: corsHeaders });

      const email = getEmailConfig();
      const planLabel = isPlanId(request.plan) ? PLAN_LIMITS[request.plan as PlanId].label : String(request.plan);

      if (action === "reject_subscription") {
        if (email && owner.email) {
          await sendEmail(email, {
            to: owner.email,
            subject: "Votre paiement Pro Social AI n'a pas pu être confirmé",
            html: emailLayout(
              "Paiement non confirmé",
              `<p>Nous n'avons pas pu confirmer votre paiement de ${escapeHtml(formatFcfa(request.amount_fcfa))}
               (référence <strong>${escapeHtml(request.payment_reference)}</strong>) pour le forfait
               ${escapeHtml(planLabel)}.</p>
               ${note ? `<p><strong>Motif :</strong> ${escapeHtml(note)}</p>` : ""}
               <p>Vérifiez la référence de la transaction et renvoyez votre demande, ou répondez à cet
               email si vous pensez qu'il s'agit d'une erreur.</p>
               ${email.appUrl ? `<p><a href="${escapeHtml(email.appUrl)}/abonnement">Revenir à mon abonnement</a></p>` : ""}`,
            ),
          });
        }
        return jsonResponse({ success: true }, { cors: corsHeaders });
      }

      // A renewal paid while the current paid period still runs extends it
      // (no day is lost by paying early); anything else starts today. An
      // upgrade mid-period applies the new plan immediately and extends from
      // the current end date, in the customer's favour.
      const currentEnd = owner.current_period_ends_at ? new Date(owner.current_period_ends_at) : null;
      const base = owner.subscription_status === "active" && currentEnd && currentEnd > decidedAt
        ? currentEnd
        : decidedAt;
      const periodEnd = addMonths(base, request.billing_period === "annual" ? 12 : 1);
      const { error: activateError } = await admin
        .from("profiles")
        .update({
          plan: request.plan,
          subscription_status: "active",
          current_period_ends_at: periodEnd.toISOString(),
          expiry_reminder_sent_at: null,
        })
        .eq("id", request.user_id);
      if (activateError) {
        // Never leave a payment marked approved on an account that was not
        // upgraded: put it back in the queue and report the failure.
        await admin
          .from("subscription_requests")
          .update({ status: "pending", admin_note: null, decided_at: null, decided_by: null })
          .eq("id", request.id);
        throw activateError;
      }
      if (email && owner.email) {
        await sendEmail(email, {
          to: owner.email,
          subject: `Votre abonnement ${planLabel} est actif`,
          html: emailLayout(
            "Merci, votre abonnement est actif",
            `<p>Votre paiement de ${escapeHtml(formatFcfa(request.amount_fcfa))} a été confirmé.
             Votre forfait <strong>${escapeHtml(planLabel)}</strong> est actif jusqu'au
             <strong>${escapeHtml(formatDateFr(periodEnd))}</strong>.</p>
             <p>Nous vous enverrons un rappel quelques jours avant l'échéance.</p>
             ${email.appUrl ? `<p><a href="${escapeHtml(email.appUrl)}/dashboard">Ouvrir mon tableau de bord</a></p>` : ""}`,
          ),
        });
      }
      return jsonResponse({ success: true, currentPeriodEndsAt: periodEnd.toISOString() }, { cors: corsHeaders });
    }

    const targetId = body.userId;
    if (!targetId) return jsonResponse({ error: "Compte requis" }, { status: 400, cors: corsHeaders });
    const { data: targetData, error: targetError } = await admin.auth.admin.getUserById(targetId);
    if (targetError || !targetData.user) return jsonResponse({ error: "Compte introuvable" }, { status: 404, cors: corsHeaders });
    const target = targetData.user;
    const targetIsFounder = target.email?.toLowerCase() === FOUNDER_EMAIL;

    if (action === "set_plan") {
      if (!body.plan || !VALID_PLANS.has(body.plan)) return jsonResponse({ error: "Forfait invalide" }, { status: 400, cors: corsHeaders });
      // Setting a plan by hand activates it. A paid period still running
      // keeps its end date (this is a plan change, not a free extension); an
      // elapsed one is cleared, otherwise the account would stay expired and
      // the change would appear to do nothing.
      const { data: current, error: readError } = await admin
        .from("profiles")
        .select("current_period_ends_at")
        .eq("id", targetId)
        .maybeSingle();
      if (readError) throw readError;
      const stillRunning = current?.current_period_ends_at &&
        new Date(current.current_period_ends_at).getTime() > Date.now();
      const { error } = await admin.from("profiles").update({
        plan: body.plan,
        subscription_status: "active",
        current_period_ends_at: stillRunning ? current.current_period_ends_at : null,
      }).eq("id", targetId);
      if (error) throw error;
    } else if (action === "extend_trial") {
      // For a prospect who needs a few more days to decide. Counted from the
      // later of now and the current trial end, so extending an expired trial
      // reopens it and extending a running one does not waste its remainder.
      const days = Math.floor(Number(body.days));
      if (!Number.isFinite(days) || days < 1 || days > MAX_TRIAL_EXTENSION_DAYS) {
        return jsonResponse({ error: `Durée invalide (1 à ${MAX_TRIAL_EXTENSION_DAYS} jours)` }, { status: 400, cors: corsHeaders });
      }
      const { data: current, error: readError } = await admin
        .from("profiles")
        .select("subscription_status, trial_ends_at")
        .eq("id", targetId)
        .maybeSingle();
      if (readError) throw readError;
      if (!current) return jsonResponse({ error: "Compte introuvable" }, { status: 404, cors: corsHeaders });
      if (current.subscription_status !== "trialing") {
        return jsonResponse({ error: "Ce compte n'est pas en essai" }, { status: 400, cors: corsHeaders });
      }
      const currentEnd = current.trial_ends_at ? new Date(current.trial_ends_at).getTime() : 0;
      const base = Math.max(Date.now(), currentEnd);
      const { error } = await admin.from("profiles").update({
        trial_ends_at: new Date(base + days * 24 * 60 * 60 * 1000).toISOString(),
        expiry_reminder_sent_at: null,
      }).eq("id", targetId);
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
      // Blocking and deleting the owner are already refused; resetting its
      // password was not, which left any other super admin a one-click
      // takeover of the owner account. Only the owner may reset its own.
      if (targetIsFounder && targetId !== actor.id) {
        return jsonResponse({ error: "Le mot de passe du propriétaire principal ne peut être réinitialisé que par lui-même" }, { status: 403, cors: corsHeaders });
      }
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
