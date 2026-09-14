// deno-lint-ignore-file no-explicit-any
//
// health-check: the operational safety net the project was missing.
//
// Until now nothing watched production: an expired Graphiste GPT key, an empty
// credit balance, a cron that stopped firing or posts stuck in "publishing"
// were only discovered when a user complained. This endpoint checks the things
// that actually break the product and, when something is wrong, emails the
// operator (RESEND_API_KEY + ADMIN_ALERT_EMAIL).
//
// Cron it every hour with the shared secret:
//   curl -H "x-cron-secret: $CRON_SECRET" .../functions/v1/health-check
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

type Level = "ok" | "warn" | "error";

interface Check {
  name: string;
  level: Level;
  detail: string;
}

const GRAPHISTE_GPT_DEFAULT_URL =
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

const WORST: Record<Level, number> = { ok: 0, warn: 1, error: 2 };

function worst(checks: Check[]): Level {
  return checks.reduce<Level>((acc, c) => (WORST[c.level] > WORST[acc] ? c.level : acc), "ok");
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Secrets without which a user-visible feature is simply broken.
const REQUIRED_SECRETS = [
  ["OPENROUTER_API_KEY", "génération de texte"],
  ["GRAPHISTE_GPT_API_KEY", "génération d'affiches"],
  ["CRON_SECRET", "tâches planifiées"],
  ["ALLOWED_ORIGINS", "appels du navigateur (CORS fail-closed)"],
  ["APP_BASE_URL", "liens de validation par email"],
];

// Secrets that degrade the product without breaking it.
const RECOMMENDED_SECRETS = [
  ["RESEND_API_KEY", "emails de validation"],
  ["RESEND_FROM", "expéditeur des emails"],
  ["ZERNIO_API_KEY", "publication sociale via Zernio"],
];

async function checkGraphisteCredits(): Promise<Check> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) {
    return { name: "graphiste_credits", level: "error", detail: "GRAPHISTE_GPT_API_KEY absente" };
  }
  const endpoint = Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
  const root = endpoint.replace(/\/v1\/posters\/generate\/?$/, "");
  try {
    const resp = await fetch(`${root}/v1/account/credits`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    if (resp.status === 401 || resp.status === 403) {
      return { name: "graphiste_credits", level: "error", detail: `clé refusée (${resp.status}) — régénérez GRAPHISTE_GPT_API_KEY` };
    }
    if (!resp.ok) {
      return { name: "graphiste_credits", level: "warn", detail: `statut ${resp.status}: ${text.slice(0, 120)}` };
    }
    const credits = body?.data?.credits ?? body?.credits ?? body?.data?.balance ?? body?.balance;
    if (typeof credits === "number") {
      if (credits <= 0) {
        return { name: "graphiste_credits", level: "error", detail: "crédits épuisés — plus aucune affiche ne sera générée" };
      }
      if (credits < 20) {
        return { name: "graphiste_credits", level: "warn", detail: `crédits bas (${credits})` };
      }
      return { name: "graphiste_credits", level: "ok", detail: `${credits} crédits` };
    }
    return { name: "graphiste_credits", level: "ok", detail: "clé acceptée (solde non exposé)" };
  } catch (err) {
    return {
      name: "graphiste_credits",
      level: "warn",
      detail: `API injoignable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkOpenRouter(): Promise<Check> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return { name: "openrouter", level: "error", detail: "OPENROUTER_API_KEY absente" };
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 401) return { name: "openrouter", level: "error", detail: "clé invalide (401)" };
    if (!resp.ok) return { name: "openrouter", level: "warn", detail: `statut ${resp.status}` };
    const body = await resp.json().catch(() => null);
    const limit = body?.data?.limit_remaining;
    if (typeof limit === "number" && limit <= 0) {
      return { name: "openrouter", level: "error", detail: "crédit OpenRouter épuisé" };
    }
    return {
      name: "openrouter",
      level: "ok",
      detail: typeof limit === "number" ? `crédit restant: ${limit}` : "clé acceptée",
    };
  } catch (err) {
    return {
      name: "openrouter",
      level: "warn",
      detail: `API injoignable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Fail CLOSED like every other cron endpoint (verify_jwt = false here).
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (!expectedSecret) {
    console.error("CRON_SECRET is not configured; refusing to run.");
    return jsonResponse({ error: "Server not configured" }, { status: 503, cors: corsHeaders });
  }
  const provided =
    req.headers.get("x-cron-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401, cors: corsHeaders });
  }

  const checks: Check[] = [];

  for (const [name, why] of REQUIRED_SECRETS) {
    checks.push(
      Deno.env.get(name)
        ? { name: `secret:${name}`, level: "ok", detail: "configuré" }
        : { name: `secret:${name}`, level: "error", detail: `absent — ${why} indisponible` },
    );
  }
  for (const [name, why] of RECOMMENDED_SECRETS) {
    checks.push(
      Deno.env.get(name)
        ? { name: `secret:${name}`, level: "ok", detail: "configuré" }
        : { name: `secret:${name}`, level: "warn", detail: `absent — ${why} désactivé` },
    );
  }

  const [graphiste, openrouter] = await Promise.all([checkGraphisteCredits(), checkOpenRouter()]);
  checks.push(graphiste, openrouter);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let stats: Record<string, number> = {};
  if (!supabaseUrl || !serviceKey) {
    checks.push({ name: "database", level: "error", detail: "configuration Supabase serveur absente" });
  } else {
    const supabase = createClient(supabaseUrl, serviceKey);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const stuckBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const count = async (build: (q: any) => any): Promise<number | null> => {
      const { count: c, error } = await build(
        supabase.from("posts").select("id", { count: "exact", head: true }),
      );
      if (error) {
        checks.push({ name: "database", level: "error", detail: error.message });
        return null;
      }
      return c ?? 0;
    };

    const failed = await count((q: any) => q.eq("status", "failed").gte("updated_at", since24h));
    const stuckPublishing = await count((q: any) =>
      q.eq("status", "publishing").lt("updated_at", stuckBefore),
    );
    const overdue = await count((q: any) =>
      q.eq("status", "validated").lt("scheduled_for", stuckBefore),
    );
    const createdLast7d = await count((q: any) => q.gte("created_at", since7d));
    const posterStuck = await count((q: any) =>
      q.eq("image_status", "processing").lt("updated_at", stuckBefore),
    );

    if (failed !== null) {
      stats = { failedLast24h: failed, stuckPublishing: stuckPublishing ?? 0, overduePublications: overdue ?? 0, postsCreatedLast7d: createdLast7d ?? 0, postersStuck: posterStuck ?? 0 };
      checks.push({
        name: "posts_failed_24h",
        level: failed > 0 ? "warn" : "ok",
        detail: `${failed} publication(s) en échec sur 24h`,
      });
      checks.push({
        name: "posts_stuck_publishing",
        level: (stuckPublishing ?? 0) > 0 ? "error" : "ok",
        detail: `${stuckPublishing ?? 0} post(s) bloqué(s) en 'publishing' depuis >30 min`,
      });
      checks.push({
        name: "publications_overdue",
        level: (overdue ?? 0) > 0 ? "error" : "ok",
        detail: `${overdue ?? 0} post(s) validé(s) dont l'heure est passée — le cron publish-post tourne-t-il ?`,
      });
      checks.push({
        name: "posters_stuck",
        level: (posterStuck ?? 0) > 0 ? "warn" : "ok",
        detail: `${posterStuck ?? 0} affiche(s) en génération depuis >30 min`,
      });
    }

    // Is the weekly generator still producing anything at all?
    const { count: eligible, error: profilesError } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .or("auto_publish.eq.true,auto_generate_enabled.eq.true");
    if (profilesError) {
      checks.push({ name: "weekly_generation", level: "warn", detail: profilesError.message });
    } else if ((eligible ?? 0) > 0 && (createdLast7d ?? 0) === 0) {
      checks.push({
        name: "weekly_generation",
        level: "error",
        detail: `${eligible} profil(s) attendent des posts mais aucun post créé depuis 7 jours — cron auto-generate-weekly ?`,
      });
    } else {
      checks.push({
        name: "weekly_generation",
        level: "ok",
        detail: `${eligible ?? 0} profil(s) éligible(s), ${createdLast7d ?? 0} post(s) créé(s) sur 7 jours`,
      });
    }
  }

  const level = worst(checks);
  const problems = checks.filter((c) => c.level !== "ok");

  // Alert the operator when something is actually wrong.
  const alertTo = Deno.env.get("ADMIN_ALERT_EMAIL");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  let alertSent = false;
  if (level === "error" && alertTo && resendKey) {
    try {
      const rows = problems
        .map((p) => `<li><strong>${escapeHtml(p.name)}</strong> (${p.level}) — ${escapeHtml(p.detail)}</li>`)
        .join("");
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("RESEND_FROM") || "Pro Social AI <no-reply@example.com>",
          to: [alertTo],
          subject: `[Pro Social AI] Alerte production (${problems.length} problème(s))`,
          html: `<h2>Diagnostic automatique</h2><ul>${rows}</ul>`,
        }),
      });
      alertSent = resp.ok;
      if (!resp.ok) console.error("health-check alert email failed:", await resp.text());
    } catch (err) {
      console.error("health-check alert email threw:", err);
    }
  }

  if (level !== "ok") {
    console.error("health-check problems:", JSON.stringify(problems));
  }

  return jsonResponse(
    { status: level, checks, stats, alertSent, checkedAt: new Date().toISOString() },
    { status: level === "error" ? 500 : 200, cors: corsHeaders },
  );
});
