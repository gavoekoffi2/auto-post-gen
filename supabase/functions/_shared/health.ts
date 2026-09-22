// deno-lint-ignore-file no-explicit-any
//
// Operational self-diagnosis for the admin control plane.
//
// Until now the platform had NO observability: a missing OPENROUTER_API_KEY, an
// expired Graphiste key, an exhausted credit balance or a cron that stopped
// firing all surfaced the same way — a user complaining that "it doesn't work".
// This module answers, in one call, the two questions an operator actually has:
// "is everything configured?" and "is anything silently broken right now?".
//
// Rules: never return a secret VALUE (presence only), never throw (a probe that
// fails is a result, not an error), and keep every probe bounded so the admin
// page can never hang on a dead third party.

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the operator should do when this is not ok. */
  remedy?: string;
}

const PROBE_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errText(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return `pas de réponse en ${PROBE_TIMEOUT_MS / 1000}s`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Required secrets, with what breaks when each one is missing. */
const REQUIRED_SECRETS: Array<{ name: string; impact: string }> = [
  { name: "OPENROUTER_API_KEY", impact: "les posts sont générés en texte générique au lieu du texte IA" },
  { name: "GRAPHISTE_GPT_API_KEY", impact: "aucune affiche n'est jamais générée (texte seul)" },
  { name: "ZERNIO_API_KEY", impact: "aucune publication ne part vers les réseaux sociaux" },
  { name: "CRON_SECRET", impact: "les tâches planifiées ne peuvent pas s'authentifier" },
  { name: "ALLOWED_ORIGINS", impact: "CORS fail-closed : le navigateur bloque TOUS les appels" },
  { name: "APP_BASE_URL", impact: "les liens des emails de validation sont invalides" },
];

const OPTIONAL_SECRETS: Array<{ name: string; impact: string }> = [
  { name: "RESEND_API_KEY", impact: "pas d'email de validation ni de formulaire de contact" },
  { name: "RESEND_FROM", impact: "expéditeur email non configuré" },
];

function secretChecks(): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const { name, impact } of REQUIRED_SECRETS) {
    const present = !!Deno.env.get(name);
    checks.push({
      id: `secret:${name}`,
      label: name,
      status: present ? "ok" : "error",
      detail: present ? "configuré" : `absent — ${impact}`,
      remedy: present ? undefined : `Supabase → Project Settings → Edge Functions → Secrets : ajoutez ${name}.`,
    });
  }
  for (const { name, impact } of OPTIONAL_SECRETS) {
    const present = !!Deno.env.get(name);
    checks.push({
      id: `secret:${name}`,
      label: name,
      status: present ? "ok" : "warn",
      detail: present ? "configuré" : `absent (optionnel) — ${impact}`,
      remedy: present ? undefined : `Optionnel : ajoutez ${name} dans les secrets Supabase.`,
    });
  }
  return checks;
}

/** OpenRouter: key valid + credit balance. */
async function openRouterCheck(): Promise<HealthCheck> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) {
    return {
      id: "provider:openrouter",
      label: "OpenRouter (texte IA)",
      status: "skipped",
      detail: "clé absente — test impossible",
    };
  }
  try {
    const resp = await fetchWithTimeout("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      return {
        id: "provider:openrouter",
        label: "OpenRouter (texte IA)",
        status: "error",
        detail: `clé refusée (${resp.status})`,
        remedy: "Régénérez la clé sur openrouter.ai et mettez OPENROUTER_API_KEY à jour.",
      };
    }
    if (!resp.ok) {
      return {
        id: "provider:openrouter",
        label: "OpenRouter (texte IA)",
        status: "warn",
        detail: `réponse ${resp.status}`,
        remedy: "Vérifiez le statut d'OpenRouter ; la génération de texte peut être dégradée.",
      };
    }
    const json = await resp.json().catch(() => null);
    const total = Number(json?.data?.total_credits ?? NaN);
    const used = Number(json?.data?.total_usage ?? NaN);
    if (Number.isFinite(total) && Number.isFinite(used)) {
      const left = total - used;
      if (left <= 0) {
        return {
          id: "provider:openrouter",
          label: "OpenRouter (texte IA)",
          status: "error",
          detail: "crédits épuisés — les posts sortiront en texte générique",
          remedy: "Rechargez le compte OpenRouter.",
        };
      }
      return {
        id: "provider:openrouter",
        label: "OpenRouter (texte IA)",
        status: left < 2 ? "warn" : "ok",
        detail: `clé valide · crédits restants ≈ ${left.toFixed(2)}`,
        remedy: left < 2 ? "Solde bas : rechargez le compte OpenRouter avant la panne." : undefined,
      };
    }
    return { id: "provider:openrouter", label: "OpenRouter (texte IA)", status: "ok", detail: "clé valide" };
  } catch (err) {
    return {
      id: "provider:openrouter",
      label: "OpenRouter (texte IA)",
      status: "error",
      detail: `injoignable : ${errText(err)}`,
      remedy: "Vérifiez la connectivité sortante et le statut d'OpenRouter.",
    };
  }
}

/** Graphiste GPT: key valid + credit balance (the historic failure mode). */
async function graphisteCheck(): Promise<HealthCheck> {
  const key = Deno.env.get("GRAPHISTE_GPT_API_KEY");
  if (!key) {
    return {
      id: "provider:graphiste",
      label: "Graphiste GPT (affiches)",
      status: "skipped",
      detail: "clé absente — test impossible",
    };
  }
  const configured = Deno.env.get("GRAPHISTE_GPT_API_URL") ||
    "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";
  // .../v1/posters/generate → .../v1/account/credits
  const creditsUrl = configured.replace(/\/v1\/posters\/generate.*$/, "/v1/account/credits");
  try {
    const resp = await fetchWithTimeout(creditsUrl, {
      headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
    });
    if (resp.status === 401 || resp.status === 403) {
      return {
        id: "provider:graphiste",
        label: "Graphiste GPT (affiches)",
        status: "error",
        detail: `clé refusée (${resp.status}) — aucune affiche ne sera générée`,
        remedy: "Régénérez la clé Graphiste GPT et mettez GRAPHISTE_GPT_API_KEY à jour.",
      };
    }
    if (!resp.ok) {
      return {
        id: "provider:graphiste",
        label: "Graphiste GPT (affiches)",
        status: "warn",
        detail: `réponse ${resp.status} sur /v1/account/credits`,
        remedy: "Le service d'affiches peut être dégradé ; relancez scripts/diagnose-graphiste.mjs.",
      };
    }
    const json = await resp.json().catch(() => null);
    const credits = json?.data?.credits ?? json?.credits ?? json?.data?.balance ?? json?.balance;
    if (credits !== undefined && Number(credits) <= 0) {
      return {
        id: "provider:graphiste",
        label: "Graphiste GPT (affiches)",
        status: "error",
        detail: `crédits = ${credits} — chaque génération d'affiche échouera (402)`,
        remedy: "Rechargez les crédits du compte Graphiste GPT.",
      };
    }
    return {
      id: "provider:graphiste",
      label: "Graphiste GPT (affiches)",
      status: "ok",
      detail: credits !== undefined ? `clé valide · crédits : ${credits}` : "clé valide",
    };
  } catch (err) {
    return {
      id: "provider:graphiste",
      label: "Graphiste GPT (affiches)",
      status: "error",
      detail: `injoignable : ${errText(err)}`,
      remedy: "Vérifiez le service Graphiste GPT (scripts/diagnose-graphiste.mjs).",
    };
  }
}

/** Zernio: key valid (the publishing backend). */
async function zernioCheck(): Promise<HealthCheck> {
  const key = Deno.env.get("ZERNIO_API_KEY");
  if (!key) {
    return {
      id: "provider:zernio",
      label: "Zernio (publication)",
      status: "skipped",
      detail: "clé absente — test impossible",
    };
  }
  const base = (Deno.env.get("ZERNIO_API_URL") || "https://zernio.com/api/v1").replace(/\/+$/, "");
  try {
    const resp = await fetchWithTimeout(`${base}/accounts`, {
      headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
    });
    if (resp.status === 401 || resp.status === 403) {
      return {
        id: "provider:zernio",
        label: "Zernio (publication)",
        status: "error",
        detail: `clé refusée (${resp.status}) — aucune publication ne partira`,
        remedy: "Régénérez la clé sur zernio.com/dashboard/api-keys.",
      };
    }
    if (resp.status === 402) {
      return {
        id: "provider:zernio",
        label: "Zernio (publication)",
        status: "error",
        detail: "paiement requis — limite de comptes connectés atteinte",
        remedy: "Ajoutez un moyen de paiement dans Zernio ou libérez un compte connecté.",
      };
    }
    return {
      id: "provider:zernio",
      label: "Zernio (publication)",
      status: resp.ok ? "ok" : "warn",
      detail: resp.ok ? "clé valide" : `réponse ${resp.status}`,
      remedy: resp.ok ? undefined : "Vérifiez le statut de Zernio.",
    };
  } catch (err) {
    return {
      id: "provider:zernio",
      label: "Zernio (publication)",
      status: "error",
      detail: `injoignable : ${errText(err)}`,
      remedy: "Vérifiez la connectivité sortante et le statut de Zernio.",
    };
  }
}

/**
 * Pipeline checks read from the database. These are what actually catch a cron
 * that stopped firing — the failure nobody notices until a customer does.
 */
async function pipelineChecks(supabase: any): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const nowIso = new Date().toISOString();
  const count = async (build: (q: any) => any): Promise<number | null> => {
    try {
      const { count: n, error } = await build(
        supabase.from("posts").select("id", { count: "exact", head: true }),
      );
      return error ? null : (n ?? 0);
    } catch {
      return null;
    }
  };

  // 1. Posts due more than 30 minutes ago and still not published: the
  //    publish-post cron is not running (or cannot reach Zernio).
  const overdueSince = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const overdue = await count((q) =>
    q.eq("status", "validated").not("scheduled_for", "is", null).lte("scheduled_for", overdueSince),
  );
  checks.push({
    id: "pipeline:overdue",
    label: "Publication planifiée",
    status: overdue === null ? "warn" : overdue > 0 ? "error" : "ok",
    detail: overdue === null
      ? "vérification impossible"
      : overdue > 0
        ? `${overdue} post(s) dont l'heure est passée depuis plus de 30 min et qui ne sont pas publiés`
        : "aucun post en retard",
    remedy: overdue && overdue > 0
      ? "Vérifiez le cron publish-post (toutes les 15 min, header x-cron-secret) et la connexion Zernio."
      : undefined,
  });

  // 2. Posts stuck in 'publishing': a run crashed mid-flight.
  const stuckSince = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const stuck = await count((q) => q.eq("status", "publishing").lte("auto_publish_attempted_at", stuckSince));
  checks.push({
    id: "pipeline:stuck",
    label: "Publications bloquées",
    status: stuck === null ? "warn" : stuck > 0 ? "warn" : "ok",
    detail: stuck === null
      ? "vérification impossible"
      : stuck > 0
        ? `${stuck} post(s) bloqué(s) en cours de publication depuis plus de 30 min`
        : "aucune publication bloquée",
    remedy: stuck && stuck > 0
      ? "recover_stuck_publishing s'exécute au prochain cron ; si le nombre ne baisse pas, inspectez les logs publish-post."
      : undefined,
  });

  // 3. Poster jobs stuck 'processing' for hours: Graphiste jobs never finished.
  const posterSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const posters = await count((q) =>
    q.eq("image_status", "processing").is("image_url", null).lte("created_at", posterSince),
  );
  checks.push({
    id: "pipeline:posters",
    label: "Affiches en attente",
    status: posters === null ? "warn" : posters > 0 ? "warn" : "ok",
    detail: posters === null
      ? "vérification impossible"
      : posters > 0
        ? `${posters} affiche(s) en génération depuis plus de 6 h`
        : "aucune affiche bloquée",
    remedy: posters && posters > 0
      ? "Vérifiez la clé et les crédits Graphiste GPT ci-dessus, puis régénérez l'affiche depuis le tableau de bord."
      : undefined,
  });

  // 4. Weekly generation actually ran for the auto-publish users.
  //
  //    Scoped to THOSE users' rows on purpose. Counting posts platform-wide
  //    would let a single manual generation by any other account mask a dead
  //    cron — the check would report healthy in exactly the situation it
  //    exists to catch.
  try {
    const { data: autoProfiles, error: autoError } = await supabase
      .from("profiles")
      .select("id")
      .eq("auto_publish", true)
      .limit(500);
    if (autoError) throw autoError;
    const autoIds = (autoProfiles || []).map((row: { id: string }) => row.id);

    if (autoIds.length === 0) {
      checks.push({
        id: "pipeline:weekly",
        label: "Génération hebdomadaire",
        status: "ok",
        detail: "aucun compte en publication automatique",
      });
    } else {
      const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const upcoming = await count((q) =>
        q.in("user_id", autoIds).in("status", ["pending", "validated"]).gte("scheduled_for", nowIso),
      );
      const recent = await count((q) => q.in("user_id", autoIds).gte("created_at", weekAgo));
      const healthy = (upcoming ?? 0) > 0 || (recent ?? 0) > 0;
      checks.push({
        id: "pipeline:weekly",
        label: "Génération hebdomadaire",
        status: healthy ? "ok" : "error",
        detail: healthy
          ? `${autoIds.length} compte(s) en automatique · ${upcoming ?? 0} post(s) à venir`
          : `${autoIds.length} compte(s) en automatique mais aucun post créé depuis 8 jours`,
        remedy: healthy
          ? undefined
          : "Vérifiez le cron auto-generate-weekly (quotidien 06:00 UTC, header x-cron-secret).",
      });
    }
  } catch {
    checks.push({
      id: "pipeline:weekly",
      label: "Génération hebdomadaire",
      status: "warn",
      detail: "vérification impossible",
    });
  }

  return checks;
}

export async function runHealthChecks(supabase: any): Promise<{
  status: CheckStatus;
  checkedAt: string;
  checks: HealthCheck[];
}> {
  const [providers, pipeline] = await Promise.all([
    Promise.all([openRouterCheck(), graphisteCheck(), zernioCheck()]),
    pipelineChecks(supabase),
  ]);
  const checks = [...secretChecks(), ...providers, ...pipeline];
  const status: CheckStatus = checks.some((c) => c.status === "error")
    ? "error"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
  return { status, checkedAt: new Date().toISOString(), checks };
}
