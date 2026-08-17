# Runbook — Pro Social AI

Procédures opérationnelles. Pour l'architecture produit voir `README.md`, pour
le déploiement initial `DEPLOYMENT.md`, pour la sécurité `SECURITY.md`.

---

## Migrations de base de données

### Comment ça marche

Les migrations sont appliquées **une seule fois chacune**, par
`scripts/apply-migrations.mjs`, qui tient un registre dans la table
`public.applied_migrations`.

Historique : le déploiement rejouait autrefois *tout* le dossier à chaque run
(destructif), puis on l'a remplacé par des étapes nommant trois fichiers en dur
— ce qui faisait que **toute nouvelle migration n'était jamais appliquée**. Le
registre corrige les deux.

- **Baseline** : au premier run, tout ce qui est ≤ `DEFAULT_BASELINE`
  (`20260723000000`) est enregistré comme déjà appliqué **sans être exécuté**,
  car ces migrations sont déjà en production. Rien n'est rejoué.
- **Checksums** : modifier une migration déjà appliquée fait **échouer** le
  déploiement. C'est voulu — écrivez une nouvelle migration.

### Ajouter une migration

```bash
# 1. Le nom DOIT être <timestamp 14 chiffres>_<nom>.sql et trier après la baseline
touch supabase/migrations/$(date -u +%Y%m%d%H%M%S)_ma_migration.sql

# 2. Valider la forme et voir le plan
npm run migrate:plan          # n'écrit rien

# 3. Le déploiement l'applique automatiquement au merge sur main
```

Écrivez toujours des migrations **idempotentes** (`IF NOT EXISTS`,
`CREATE OR REPLACE`, `DROP ... IF EXISTS`) : une migration peut être relancée
après un échec partiel.

### Appliquer à la main

```bash
export SUPABASE_ACCESS_TOKEN=...   # Supabase → Account → Access Tokens
export PROJECT_REF=tktoyntaeajgsuplhntd
npm run migrate:plan               # vérifier le plan d'abord
npm run migrate
```

### En cas de blocage

| Symptôme | Cause | Action |
|---|---|---|
| `was modified after it was applied` | Une migration déjà appliquée a été éditée | Restaurer le fichier et écrire une nouvelle migration |
| Une migration échoue à mi-parcours | SQL invalide, ou état inattendu | Corriger le SQL ; le registre n'a pas enregistré l'échec, donc elle sera retentée |
| Le registre est vide sur une base existante | Première exécution | Normal : la baseline est adoptée sans rien exécuter |

---

## Secrets

Tous les secrets serveur vivent dans **Supabase → Edge Functions → Secrets**.
`.env` ne sert qu'au frontend (`VITE_*`, valeurs publiques). Voir `.env.example`.

Obligatoires en production :

| Secret | Sans lui |
|---|---|
| `OPENROUTER_API_KEY` | Aucun texte généré (repli local générique) |
| `GRAPHISTE_GPT_API_KEY` | Aucune affiche générée (posts texte seul) |
| `ZERNIO_API_KEY` | Aucune publication possible |
| `CRON_SECRET` | Les fonctions cron refusent **toute** requête (fail closed) |
| `ALLOWED_ORIGINS` | Aucun en-tête CORS émis → le navigateur bloque l'app |
| `APP_BASE_URL` | Liens de validation par email cassés |
| `RESEND_API_KEY` / `RESEND_FROM` | Aucun email envoyé (mode dry-run journalisé) |

Le déploiement échoue volontairement si `GRAPHISTE_GPT_API_KEY` ou
`OPENROUTER_API_KEY` manque.

---

## Tâches planifiées

À configurer dans Supabase → Database → Cron, avec l'en-tête
`x-cron-secret: $CRON_SECRET` :

| Fonction | Fréquence conseillée | Rôle |
|---|---|---|
| `auto-generate-weekly` | 1×/semaine | Génère la semaine de contenu des profils en auto |
| `publish-post` (sans corps) | Toutes les 15 min | Publie les posts échus + récupère les blocages + **maintenance BDD** |
| `send-validation-email` | 1×/jour | Envoie les emails de validation en attente |
| `sync-comments` | Toutes les heures | Rapatrie les commentaires et répond (plan Enterprise) |

`publish-post` appelle `run_maintenance()` à chaque passage cron : purge
`generation_usage` (90 jours) et `ip_rate_events` (24 h). Sans ce cron, ces
tables grossissent indéfiniment et ralentissent chaque contrôle de quota.

---

## Quotas

Par utilisateur et par heure, via `consume_generation_quota` (atomique) :

| Fonction | Limite/h | Plafond mensuel |
|---|---|---|
| `generate-content` | 20 | 200 |
| `generate-image` | 30 | 200 |
| `comment-reply` | 60 | — |
| `sync-comments` (manuel) | 12 | — |
| `admin-api` | 120 | — |

Les quotas **échouent ouverts** : si la RPC est indisponible, la requête passe
et un `console.error` est émis. Une dégradation permanente est un risque de
facturation — surveillez ces lignes de log.

Endpoints publics limités par IP (`hit_ip_rate_limit`) : `send-contact` (5/h),
`validate-post` (60/h).

---

## Incidents courants

**« Seul le texte est généré, pas d'image »**
`GRAPHISTE_GPT_API_KEY` absente ou invalide. Vérifier :
`GRAPHISTE_GPT_API_KEY="..." node scripts/diagnose-graphiste.mjs`

**« Les posts partent à la mauvaise heure »**
`profiles.timezone` vaut `UTC` (valeur par défaut des comptes créés avant le
support des fuseaux). L'utilisateur doit ré-enregistrer son profil depuis son
fuseau habituel ; le navigateur le détecte automatiquement.

**« Des posts restent bloqués en `publishing` »**
`recover_stuck_publishing()` les récupère après 10 minutes, au prochain cron
`publish-post`. Ceux qui portent déjà un `provider_post_id` passent en
`published` (ils sont partis) ; les autres repassent en `validated`.

**CORS bloqué dans le navigateur**
`ALLOWED_ORIGINS` doit contenir l'origine **exacte** (schéma + hôte + port).
Le comportement est fail-closed : sans correspondance, aucun en-tête n'est émis.

---

## Dette technique connue

**Deux versions du client Supabase dans les fonctions edge.**
15 fonctions importent `@supabase/supabase-js@2.38.4`, `admin-api` importe
`@2.74.0` (la version du frontend). Les deux fonctionnent, mais deux clients
sont téléchargés et maintenus. Consolider vers `2.74.0` via une import map
(`supabase/functions/deno.json`) est la bonne cible ; à faire en une seule
passe, avec `deno check` vert sur les 26 entrypoints avant merge.

**Le type-check Deno des entrypoints est récent.**
`deno check` ne portait sur rien avant ; les modules `_shared` sont vérifiés
verts, les 26 `index.ts` sont vérifiés pour la première fois par la CI. Si des
erreurs de type préexistantes apparaissent, elles sont réelles — le runtime
Deno se contente d'effacer les types sans les vérifier.

**Pas de suivi d'erreurs côté serveur.**
Les fonctions edge journalisent dans `console.error`, visibles uniquement dans
les logs Supabase. Un collecteur (Sentry ou équivalent) permettrait d'être
alerté sur les échecs de publication plutôt que de les découvrir dans le
tableau de bord d'un client.
