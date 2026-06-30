#!/usr/bin/env node
// Diagnostic de bout en bout pour l'API Graphiste GPT (génération d'affiches).
//
// Pourquoi : si "seul le texte se génère, jamais l'image", la cause est presque
// toujours côté configuration/compte (clé absente, crédits épuisés, clé
// invalide) — invisible depuis le code. Ce script reproduit EXACTEMENT la
// requête envoyée par l'Edge Function `generate-image` et déroule les 3 étapes
// réelles, en affichant clairement où ça casse.
//
// Utilisation (la clé n'est JAMAIS affichée) :
//   GRAPHISTE_GPT_API_KEY="sk_..." node scripts/diagnose-graphiste.mjs
//
// Option : surcharger l'URL si elle a changé côté Supabase :
//   GRAPHISTE_GPT_API_URL=".../v1/posters/generate" GRAPHISTE_GPT_API_KEY=... node scripts/diagnose-graphiste.mjs

const KEY = process.env.GRAPHISTE_GPT_API_KEY;
const GENERATE_URL =
  process.env.GRAPHISTE_GPT_API_URL ||
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

const API_ROOT = GENERATE_URL.replace(/\/v1\/posters\/generate\/?$/, "");
const ok = (m) => console.log(`\x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

if (!KEY) {
  bad("GRAPHISTE_GPT_API_KEY absente de l'environnement.");
  info("Lance le script ainsi (sans afficher la clé) :");
  info('  GRAPHISTE_GPT_API_KEY="ta_cle" node scripts/diagnose-graphiste.mjs');
  info("");
  info("👉 Si dans Supabase la clé est ABSENTE aussi, c'est LA cause : l'Edge");
  info("   Function renvoie alors 'missing_api_key' et ne génère jamais d'image.");
  process.exit(2);
}

const authHeaders = { Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(resp) {
  const text = await resp.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

// Recursively find a final raster image URL (mirrors the Edge Function parser).
function findImageUrl(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const v = value.trim();
    if (v.includes("/reference-templates/")) return null;
    if (/^data:image\/svg/i.test(v)) return null;
    if (v.startsWith("data:image/")) return v;
    if (/^https?:\/\/\S+/i.test(v) && !/\.svg(\?|#|$)/i.test(v)) return v;
    return null;
  }
  if (Array.isArray(value)) {
    for (const it of value) {
      const f = findImageUrl(it);
      if (f) return f;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const f of ["image_url", "poster_url", "final_image_url", "url", "data", "result", "images", "outputs"]) {
      const found = findImageUrl(value[f]);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  console.log("Diagnostic Graphiste GPT — génération d'affiches");
  info(`Endpoint : ${GENERATE_URL}`);
  info(`Clé      : présente (longueur ${KEY.length}, non affichée)`);

  // ÉTAPE 1 — la clé est-elle valide et y a-t-il des crédits ?
  head("Étape 1/3 — Vérification du compte (clé + crédits)");
  try {
    const resp = await fetch(`${API_ROOT}/v1/account/credits`, { headers: authHeaders });
    const { json, text } = await readJson(resp);
    if (resp.status === 401) {
      bad("401 — Clé INVALIDE ou expirée. → C'est la cause. Régénère la clé Graphiste GPT et mets-la dans Supabase (GRAPHISTE_GPT_API_KEY).");
      process.exit(1);
    }
    if (resp.status === 403) {
      bad("403 — Clé sans les droits nécessaires (scope). → Vérifie les permissions de la clé.");
      process.exit(1);
    }
    if (!resp.ok) {
      bad(`Statut ${resp.status} sur /v1/account/credits : ${text.slice(0, 200)}`);
    } else {
      ok("Clé acceptée (200).");
      const credits = json?.data?.credits ?? json?.credits ?? json?.data?.balance ?? json?.balance;
      if (credits !== undefined) {
        if (Number(credits) <= 0) {
          bad(`Crédits = ${credits}. → C'est la cause : sans crédits, chaque génération échoue (402). Recharge le compte.`);
          process.exit(1);
        }
        ok(`Crédits disponibles : ${credits}`);
      } else {
        info(`Réponse brute : ${JSON.stringify(json ?? text).slice(0, 300)}`);
      }
    }
  } catch (err) {
    bad(`Impossible de joindre l'API : ${err.message}`);
    process.exit(1);
  }

  // ÉTAPE 2 — lancer une vraie génération (même corps que l'Edge Function).
  head("Étape 2/3 — Lancement d'une génération réelle (mode async)");
  const requestBody = {
    domain: "business",
    subject:
      "Affiche publicitaire professionnelle premium pour les réseaux sociaux (carré 1:1). " +
      "Entreprise: Test Diagnostic. Message: offre spéciale de lancement. " +
      "Composition: vraie affiche marketing, titre lisible, mise en page moderne. " +
      "premium social media poster, cinematic lighting, large readable headline, clear CTA.",
    title: "Offre spéciale",
    quality: "premium",
    aspect_ratio: "1:1",
    resolution: "2K",
    mode: "async",
  };
  let jobId = null;
  let statusUrl = null;
  try {
    const resp = await fetch(GENERATE_URL, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(requestBody),
    });
    const { json, text } = await readJson(resp);
    info(`Statut HTTP : ${resp.status}`);
    if (Array.isArray(json?.warnings) && json.warnings.length) {
      info(`⚠ warnings de l'API : ${JSON.stringify(json.warnings)}`);
      info("  (si 'quality' apparaît ici, ce n'est qu'un avertissement, pas bloquant)");
    }
    if (resp.status === 402 || json?.error?.code === "PAYMENT_REQUIRED") {
      bad("402 — Crédits insuffisants. → Recharge le compte Graphiste GPT.");
      process.exit(1);
    }
    if (resp.status === 400) {
      bad(`400 — Requête refusée : ${JSON.stringify(json?.error ?? text).slice(0, 300)}`);
      bad("→ Le corps de requête est rejeté par l'API (contrat). Dis-le moi : je corrige le code.");
      process.exit(1);
    }
    if (!resp.ok && resp.status !== 202) {
      bad(`Échec inattendu (${resp.status}) : ${text.slice(0, 250)}`);
      process.exit(1);
    }
    const directImage = findImageUrl(json);
    jobId = json?.data?.job_id ?? json?.job_id ?? null;
    statusUrl = json?.data?.status_url ?? json?.status_url ?? null;
    if (directImage) {
      ok(`Image renvoyée immédiatement (mode rapide) : ${directImage.slice(0, 80)}...`);
      ok("✅ LA GÉNÉRATION D'IMAGE FONCTIONNE. Le souci venait donc du code (déjà corrigé) ou du déploiement.");
      process.exit(0);
    }
    if (!jobId && !statusUrl) {
      bad(`Ni image ni job_id renvoyés. Réponse : ${JSON.stringify(json ?? text).slice(0, 300)}`);
      process.exit(1);
    }
    ok(`Job accepté. job_id=${jobId ?? "(absent)"} ; status_url=${statusUrl ? "présent" : "(absent)"}`);
  } catch (err) {
    bad(`Erreur lors du lancement : ${err.message}`);
    process.exit(1);
  }

  // ÉTAPE 3 — attendre la fin du job (l'affiche premium peut prendre 1-3 min).
  head("Étape 3/3 — Attente de l'affiche finale (jusqu'à 3 min)");
  const pollUrl = statusUrl || `${API_ROOT}/v1/posters/${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + 3 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    await sleep(5000);
    tick++;
    try {
      const resp = await fetch(pollUrl, { headers: authHeaders });
      if (!resp.ok) {
        info(`(poll ${tick}) statut ${resp.status}, on réessaie…`);
        continue;
      }
      const { json } = await readJson(resp);
      const status = (json?.data?.status ?? json?.status ?? "").toLowerCase();
      const image = findImageUrl(json);
      if (image) {
        ok(`Affiche prête : ${image.slice(0, 80)}...`);
        ok("✅ LA GÉNÉRATION D'IMAGE FONCTIONNE de bout en bout avec ta clé.");
        info("→ Si l'app ne montre toujours pas l'image, c'est le déploiement : redéploie les Edge Functions + le front.");
        process.exit(0);
      }
      if (["failed", "error", "canceled", "cancelled"].includes(status)) {
        bad(`Le job a échoué côté Graphiste GPT (status=${status}). Réponse : ${JSON.stringify(json).slice(0, 300)}`);
        process.exit(1);
      }
      info(`(poll ${tick}) status=${status || "?"}, génération en cours…`);
    } catch (err) {
      info(`(poll ${tick}) erreur réseau : ${err.message}`);
    }
  }
  bad("Délai dépassé (3 min) sans image. La génération est ANORMALEMENT lente côté Graphiste GPT.");
  info("→ Soit le service est surchargé/en panne, soit le job reste bloqué. Renvoie-moi le job_id ci-dessus.");
  process.exit(1);
}

main().catch((err) => {
  bad(`Erreur inattendue : ${err.message}`);
  process.exit(1);
});
