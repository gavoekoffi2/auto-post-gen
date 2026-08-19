# HANDOVER — Document de transmission (Pro Social AI)

> Rédigé le 13 juillet 2026, à l'issue d'un audit complet (sécurité, bugs,
> architecture) mené juste avant la passation. Ce document est le point
> d'entrée de l'équipe qui reprend le projet. Il complète — sans les
> remplacer — [`README.md`](../README.md) (démarrage), [`DEPLOYMENT.md`](../DEPLOYMENT.md)
> (secrets & mise en production, table de référence) et
> [`docs/PRICING.md`](./PRICING.md) (modèle économique complet, coûts, marges).

---

## 1. Démarrer

### En local (10 minutes)

```bash
git clone <repo> && cd auto-post-gen
npm install
cp .env.example .env.local        # remplir les 3 variables VITE_* (voir §6 Accès)
npm run dev                       # http://localhost:8080
```

Vérifications avant tout commit :

```bash
npm test        # 73 tests — DOIVENT tous passer
npm run lint    # 0 erreur (7 warnings shadcn/fast-refresh connus, non bloquants)
npm run build   # build Vite 7
```

La CI (`.github/workflows/ci.yml`) exécute exactement ces trois commandes sur
chaque PR : si ça passe en local, ça passera en CI.

### En production

Il n'y a **ni VPS, ni serveur à administrer, ni n8n**. Tout est géré :

| Quoi | Où | Déclencheur |
|---|---|---|
| Frontend (SPA React) | **Netlify** | push sur `main` touchant `src/**` → `.github/workflows/deploy-netlify.yml` |
| Edge Functions (23) | **Supabase** (projet `ixinojsmymqovekgkbdg`) | push sur `main` touchant `supabase/functions/**` → `.github/workflows/deploy-functions.yml` (déploie TOUT) |
| Base de données | **Supabase Postgres** | migrations dans `supabase/migrations/` (`supabase db push`) |
| Tâches planifiées | **Supabase Scheduler** (dashboard) | voir cadences dans `DEPLOYMENT.md` §Cron |

Déployer = merger sur `main`. Rien d'autre.

---

## 2. Architecture réelle (vérifiée, pas théorique)

```
Navigateur ── SPA React/Vite (Netlify, CSP stricte, headers sécurité)
    │  supabase-js (anon key + RLS)
    ▼
Supabase ──┬─ Auth (sessions JWT, localStorage, autoRefresh)
           ├─ Postgres : 6 tables, RLS activé PARTOUT
           │    profiles, posts, social_connections, social_comments,
           │    generation_usage, ip_rate_events
           ├─ Storage : bucket user-assets (affiches réhébergées)
           └─ 23 Edge Functions (Deno) ── APIs externes :
                ├─ OpenRouter        → TEXTE IA (gemini-2.5-flash)
                ├─ Graphiste GPT     → AFFICHES IA (exclusif, pas de repli)
                ├─ Zernio            → publication sociale (voie principale)
                ├─ Postiz / Ayrshare → publication (voies alternatives)
                ├─ OAuth direct      → LinkedIn / Meta / Twitter (coût zéro)
                ├─ Resend            → emails de validation + formulaire contact
                └─ RSS/DDG/Wikipedia → recherche web GRATUITE (pas de clé requise)
```

### Décisions techniques importantes (et pourquoi)

1. **Graphiste GPT est le SEUL moteur d'affiches, sans repli.** Décision
   produit : les affiches doivent être de vraies compositions marketing
   (GPT Image 2 premium 2K), pas des images génériques. Un repli silencieux
   vers un autre moteur produirait des visuels de qualité inférieure sans que
   personne ne s'en aperçoive. Le code échoue donc **explicitement** avec un
   message actionnable (clé manquante, crédits épuisés, 429…) plutôt que de
   dégrader. Des tests (`generate-image-graphiste-policy.test.js`) verrouillent
   cette politique — ne les « corrigez » pas en réintroduisant un repli sans
   décision produit explicite.

2. **La génération d'affiche est asynchrone et REPRENABLE.** Une affiche
   premium peut prendre plusieurs minutes ; aucun appel edge ne doit approcher
   le timeout Supabase (150 s). Le flux : `generate-image` lance un job
   Graphiste (`mode: async`), poll ~40 s, puis rend la main au client avec
   `{status:"processing", jobId, statusUrl}` **et persiste le job sur la ligne
   du post** (`image_job_id`, `image_status_url`, `image_status`). Le Dashboard
   re-poll (7 tentatives max, timeout client 90 s par appel), reprend les jobs
   pendants au chargement de la page, et `publish-post` fait une dernière
   tentative avant publication. Un job lancé n'est donc JAMAIS perdu, et une
   reprise ne relance JAMAIS une génération payante (c'est un simple GET).

3. **Publication par nombre de comptes connectés, pas par plateforme.**
   Zernio facture par compte social connecté ($1–6/compte/mois selon le volume
   global). Les plans (Starter 2, Pro 3, Enterprise 8 réseaux) sont donc
   dénommés en « nombre de réseaux », ce qui rend l'ajout futur de
   TikTok/YouTube **sans impact tarifaire** (voir PRICING.md §8). L'OAuth
   direct (Facebook/Instagram/LinkedIn), déjà codé, coûte 0 — c'est le levier
   n°1 de marge documenté dans PRICING.md.

4. **Sécurité en profondeur côté serveur, jamais côté client.**
   - RLS sur toutes les tables, `WITH CHECK` sur tous les UPDATE (un
     utilisateur ne peut pas déplacer une ligne vers un autre compte).
   - Colonnes de tokens sociaux **révoquées** pour `anon`/`authenticated`
     (GRANT colonne par colonne) : le front ne peut PAS lire les tokens.
   - `profiles.plan` protégé par trigger : un client ne peut pas s'auto-passer
     en Enterprise (RLS ne protège pas les colonnes, d'où le trigger).
   - Quotas de génération atomiques (RPC `consume_generation_quota`) +
     plafonds mensuels (200 textes, 200 images/utilisateur) + rate-limit IP
     sur les endpoints publics.
   - CORS fail-closed centralisé dans `_shared/cors.ts` (si `ALLOWED_ORIGINS`
     n'est pas configuré, tout est bloqué — c'est voulu).
   - `fetchImageBytes` (`_shared/safeFetch.ts`) : anti-SSRF (https only,
     blocage IP privées/métadonnées cloud, taille plafonnée).

5. **Tests = assertions sur les sources + tests comportementaux.** La plupart
   des tests lisent les fichiers sources et vérifient des invariants de
   POLITIQUE (« pas de repli image », « CORS fail-closed », « quotas
   présents »). C'est voulu : rapide, zéro harnais, et ça épingle les
   régressions de design. `tests/graphiste-parse.test.js` est comportemental
   (import TS réel via type-stripping Node 22). Étendez ce style ; ne
   supprimez pas un test qui casse — il casse parce qu'un invariant est violé.

6. **FCFA d'abord.** Marché cible : Afrique de l'Ouest francophone. Prix
   affichés en FCFA (USD indicatif), paiement Mobile Money prioritaire.
   Toute la justification économique (coûts réels par post/image/vidéo,
   marges par palier Zernio, prix des add-ons) est dans `docs/PRICING.md` —
   lisez-le AVANT de toucher aux prix ou aux quotas.

---

## 3. Audit de sécurité (résultats du 13/07/2026)

| Domaine | Verdict | Détail |
|---|---|---|
| Secrets dans le code | ✅ RAS | Aucun secret réel dans le repo ni l'historique. Seules d'anciennes clés **anon** (publiques par conception, `role:"anon"` vérifié) ont existé dans un `.env` historique, déjà supprimé de `main`. **Aucune rotation nécessaire.** |
| `.gitignore` | ✅ | `.env*` ignoré, seul `.env.example` versionné. |
| RLS | ✅ | Activé sur les 6 tables, `WITH CHECK` sur les UPDATE, tokens sociaux illisibles côté client, trigger anti-escalade de plan. |
| Auth edge functions | ✅ | JWT vérifié en fonction (`getUserIdFromAuthHeader`/`auth.getUser`) partout où un utilisateur appelle ; `CRON_SECRET` fail-closed pour les fonctions cron ; state OAuth signé HMAC-SHA256 avec expiration 30 min. |
| CORS | ✅ (corrigé) | 9 copies locales divergentes unifiées vers `_shared/cors.ts` (fail-closed) le 13/07 ; un test empêche la dérive de revenir. |
| Dépendances | ✅ 0 vulnérabilité | `npm audit` : 0 (prod ET dev) depuis la migration Vite 7. |
| Headers front | ✅ | CSP stricte, HSTS, X-Frame-Options DENY, etc. via `netlify.toml`. |

Notes mineures (acceptées, pas des trous) :
- La clé anon Supabase est visible dans le bundle front : c'est **normal**
  (elle est conçue pour ça) ; la sécurité repose sur RLS, pas sur son secret.
- La comparaison du `CRON_SECRET` est désormais à temps constant
  (`timingSafeEqual`, `_shared/rateLimit.ts`) — voir §3 bis.

---

## 3 bis. Audit de sécurité (18/08/2026)

Seconde passe. Quatre failles exploitables trouvées, toutes corrigées.

| Criticité | Faille | Mécanisme | Correctif |
|---|---|---|---|
| **CRITIQUE** | Exfiltration de `GRAPHISTE_GPT_API_KEY` (+ SSRF) | Chaque poll de job part avec `Authorization: Bearer <clé Graphiste>`. L'URL pollée venait de deux entrées contrôlées par l'utilisateur : le champ `statusUrl` du corps de `generate-image`, et la colonne `posts.image_status_url` que le navigateur pouvait écrire sur sa propre ligne (reprise par le cron `publish-post`). Pointer l'une des deux sur `https://attaquant.tld/` livrait la clé à un hôte arbitraire. | Constructeur d'URL unique et partagé (`_shared/graphisteStatusUrls.ts`) : une `statusUrl` fournie n'est retenue que si elle est en https **et** sur la même origine que l'endpoint Graphiste configuré. Les deux appelants passent par lui, aucune copie locale. |
| **CRITIQUE** | Prise de contrôle du compte `super_admin` | `admin-api` promouvait tout utilisateur authentifié dont l'email correspondait à l'adresse fondateur codée en dur. La production tourne avec `mailer_autoconfirm: true` (workflow de déploiement) : l'email n'est donc **pas** vérifié. Si le compte fondateur n'existait pas encore, n'importe qui pouvait s'inscrire avec cette adresse et obtenir la main sur tous les locataires. L'adresse était en plus livrée dans le bundle public (`Auth.tsx`), désignant la cible. | Le bootstrap est réellement *one-time* : il exige qu'**aucun** `super_admin` n'existe déjà (fail-closed si la vérification échoue), et l'adresse passe par `ADMIN_FOUNDER_EMAIL`. L'adresse a été retirée du bundle front. |
| **ÉLEVÉE** | Publication au nom d'un autre locataire | `authenticated` gardait le droit d'`INSERT` sur `social_connections`. `profile_key` décide *par quel profil fournisseur* un post est publié : insérer `{user_id: soi, provider:'zernio', profile_key: <profil victime>}` faisait sortir ses propres posts sur les comptes sociaux d'autrui. Le front n'insère jamais (il ne fait que lire et supprimer). | `REVOKE INSERT ... FROM authenticated, anon` + suppression de la policy devenue inatteignable. Les écritures passent uniquement par les edge functions (service role). |
| **ÉLEVÉE** | Colonnes serveur réinscriptibles depuis le navigateur | RLS filtre les *lignes*, jamais les *colonnes* : `posts` autorisait l'UPDATE sur toute la ligne. Un utilisateur pouvait réécrire `image_status_url`/`image_job_id` (cf. faille n°1), `provider_post_id` (qui pilote la reprise des publications bloquées), les colonnes de jeton de validation, et sortir une ligne de l'état `publishing` en pleine publication — exactement la course que le verrou atomique de `publish-post` existe pour empêcher. | Trigger `guard_post_server_columns` (même forme que `guard_profile_plan`) : colonnes serveur épinglées à leur valeur stockée, ligne gelée pendant `publishing`, états `publishing`/`published` réservés au publieur. Migration `20260818000000`, **exécutée et vérifiée sur une vraie base Postgres 16** (5 attaques bloquées, tous les flux applicatifs et le service role intacts). |

Durcissements complémentaires de la même passe :

- **SSRF** : les derniers `fetch()` bruts sur des URL d'image influençables
  (upload LinkedIn dans `publish-post`, re-hébergement dans `generate-image`,
  upload `_shared/postiz.ts`) passent par `fetchImageBytes`.
- **Fuite d'informations** : les 500 des fonctions destinées aux utilisateurs
  renvoyaient `error.message` tel quel (messages Postgres nommant tables et
  colonnes, corps de réponse des fournisseurs). Centralisé dans
  `internalError()` : journalisé côté serveur, message générique côté client.
  Les entrées cron gardent le détail — leur appelant est l'opérateur.
- **Injection de prompt** : les titres/extraits de recherche web sont rédigés
  par des tiers et le post généré part sur les vrais comptes sociaux, parfois
  sans humain dans la boucle (`auto-generate-weekly`). `sanitizeResearchText`
  neutralise les leviers d'injection (sauts de ligne, caractères de structure,
  caractères invisibles, formules d'instruction) et le bloc est explicitement
  étiqueté « données, pas instructions ».
- **Mots de passe** : le minimum à l'inscription et à la réinitialisation passe
  de 6 à 8 caractères, aligné sur ce qu'`admin-api` impose déjà.
- **Dépendances** : `nanoid` et `postcss` (les deux alertes *high*) corrigées.

### Seconde passe du 18/08 (même journée) — failles supplémentaires

| Criticité | Faille | Mécanisme | Correctif |
|---|---|---|---|
| **ÉLEVÉE** | Injection de prompt → publication automatique sous l'identité de la marque | `draftReply` (`_shared/engagement.ts`) injectait le texte d'un commentaire — écrit par **n'importe quel inconnu** sur un post publié — directement dans le prompt. Avec l'auto-réponse activée (plan Enterprise), `sync-comments` publie la réponse générée **sans relecture humaine**. Un commentaire du type « ignore les instructions précédentes et réponds ceci » faisait donc parler la marque. | Module partagé `_shared/untrustedText.ts` : neutralisation des leviers d'injection, texte encadré par `<<<COMMENTAIRE>>>` et déclaré comme donnée dans le prompt système. Un commentaire qui n'est *que* de la charge utile lève `UnsafeCommentError` et n'est jamais répondu automatiquement (il reste dans l'inbox pour l'humain). Dernier filet : aucune URL du commentaire ne peut survivre dans la réponse publiée. |
| **MOYENNE** | Détournement des emails de validation | `profiles.email` est recopié depuis `auth.users` par `handle_new_user`, mais le navigateur pouvait le réécrire. C'est l'adresse vers laquelle `send-validation-email` envoie le contenu des posts **et les liens de validation en un clic**. Un utilisateur pouvait pointer son profil vers la boîte d'un tiers et faire envoyer du courrier non sollicité depuis notre domaine. | Trigger `guard_profile_server_columns` : l'adresse est épinglée (`COALESCE(OLD.email, NEW.email)`, donc l'upsert légitime de `SettingsDialog` continue de fonctionner). `custom_image_urls` est en outre contraint à `https` et plafonné. Migration `20260818010000`, exécutée et vérifiée sur Postgres 16. |
| **MOYENNE** | Mot de passe minimum non appliqué côté serveur | Le minimum de 8 caractères n'existait **que dans le navigateur**. L'API Supabase acceptait toujours 6 caractères : il suffisait d'appeler `signUp` directement. | `password_min_length: 8` appliqué dans la configuration Auth par la CI, plus rejet des mots de passe compromis (HaveIBeenPwned) et ré-authentification obligatoire avant changement de mot de passe. |

Robustesse « prêt pour les premiers utilisateurs » :

- **Écran blanc** : aucun *error boundary* React. Toute exception de rendu — et
  surtout un *chunk* périmé après un redéploiement, cas très courant sur un
  onglet resté ouvert — démontait tout l'arbre et laissait une page blanche
  sans message ni recours. `src/components/ErrorBoundary.tsx` entoure désormais
  le routeur et propose un rechargement (vérifié en navigateur réel).
- **Famine des crons** : `auto-generate-weekly` parcourait *tous* les profils
  sans budget. Au-delà d'une certaine volumétrie, le runtime edge (~150 s) tue
  la requête en cours de liste. Ajout d'un budget horloge **et** d'un ordre
  aléatoire — un simple `LIMIT` sur un ordre fixe aurait garanti que la fin de
  la liste ne soit *jamais* servie. `send-validation-email` est plafonné de la
  même façon. Le rattrapage est naturel : la logique de complément est
  idempotente.
- **`robots.txt`** autorisait l'indexation de `/dashboard`, `/admin` et
  `/validate-post` ; ces routes sont maintenant exclues.
- **Dépendances** : `npm audit` = **0 vulnérabilité** (react-router passé en
  v7 ; les 13 routes, la navigation client et la garde d'authentification ont
  été vérifiées dans un vrai navigateur, pas seulement au build).

### Points laissés en l'état — décision opérateur requise

1. **Une seule action reste à faire de votre côté : ajouter 4 secrets GitHub.**
   La confirmation d'email est **automatiquement activée** dès que
   `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` et `SMTP_SENDER_EMAIL` existent
   (avec Resend : `smtp.resend.com` / `465` / `resend` / votre
   `RESEND_API_KEY` / une adresse sur un domaine vérifié). Tant qu'ils sont
   absents, `mailer_autoconfirm` reste volontairement actif et la CI émet un
   avertissement visible : basculer sans expéditeur fonctionnel enfermerait
   dehors chaque nouvel inscrit. **Tant que ce n'est pas fait, n'importe qui
   peut s'inscrire avec l'adresse d'autrui** — la promotion `super_admin` qui
   en découlait est fermée côté code, mais l'usurpation d'adresse reste
   possible.
2. **`?token=<JWT>` sur `oauth-start-*`** : le JWT transite en query string
   (donc dans les journaux d'accès). C'est un compromis inhérent — un
   fournisseur OAuth ne peut pas poser d'en-tête sur une redirection. Ces six
   fonctions ne sont **plus appelées par le front** (mode Zernio only) et les
   connexions qu'elles créent sont explicitement ignorées par `publish-post`.
   Les retirer du déploiement supprimerait la surface d'attaque, mais c'est une
   décision produit (abandon définitif de l'OAuth direct) : je ne l'ai pas
   prise à votre place.

---

## 4. Bugs traités lors de la passation (13/07/2026)

| Criticité | Bug | Cause | Correctif |
|---|---|---|---|
| **BLOQUANT** (prod) | « Seul le texte se génère, jamais l'affiche » | Double cause : (a) l'extracteur de job prenait le `request_id` (identifiant de trace, niveau racine) au lieu de `data.job_id` → tous les polls de reprise 404aient ; (b) très probablement `GRAPHISTE_GPT_API_KEY` absente/invalide côté Supabase (à vérifier, voir checklist §7). Les 5 commits « timeout » faits en parallèle sur `main` traitaient le symptôme, pas la cause. | Parseur corrigé et centralisé (`_shared/graphisteParse.ts`, testé unitairement) ; script `scripts/diagnose-graphiste.mjs` pour prouver en 1 commande où ça casse. |
| **MAJEUR** | Affiche lente = perdue | Le job en cours n'était persisté nulle part sur le flux interactif : client fermé → job orphelin (mais facturé !). | Job persisté sur la ligne du post ; reprise automatique au chargement du Dashboard et à la publication. |
| **MAJEUR** (UX) | Appel edge suspendu = spinner infini | Aucun timeout client sur `functions.invoke`. | `invokeGenerateImageWithTimeout` (race 90 s) avec garde anti-double-facturation : un PREMIER appel expiré ne relance pas de génération payante (le job persisté est repris au prochain chargement). |
| **MAJEUR** (process) | `main` et la branche de travail avaient divergé (9 commits vs 16) avec conflits sur les fichiers les plus sensibles | Deux lignes de développement parallèles sur le même bug image. | Merge réconcilié et testé (73/73) : contrat de reprise unifié + toolchain Vite 7 de `main` conservée. La branche merge maintenant **sans conflit** dans `main`. |
| Mineur | 9 copies locales de CORS antérieures au durcissement (header `undefined` possible) | Copier-coller historique. | Unifiées sur `_shared/cors.ts` + test anti-dérive. |
| Mineur | Docs opérationnelles omettant `GRAPHISTE_GPT_API_KEY` (README **et** DEPLOYMENT.md) — cause racine plausible de la panne : la checklist d'installation ne mentionnait jamais la clé | Documentation en retard sur le code. | README, DEPLOYMENT.md et `.env.example` corrigés ; le secret est maintenant marqué OBLIGATOIRE partout. |
| Info | Alerte npm esbuild/vite (outillage dev uniquement) | Vite 5. | Résolue par la migration Vite 7 héritée de `main` : `npm audit` = 0. |

---

## 5. Fragilités connues & feuille de route proposée

### P0 — avant d'encaisser le moindre franc
1. **Configurer et prouver `GRAPHISTE_GPT_API_KEY`** (checklist §7, étape 2).
   C'est LE point qui conditionne la promesse produit.
2. **Brancher le paiement Mobile Money** (CinetPay ou PayDunya) : aujourd'hui
   `profiles.plan` est attribué **à la main** en SQL. Les add-ons du
   PRICING.md §4 dépendent de la même brique. Le webhook de paiement doit
   écrire `plan` via service role (le trigger laisse passer le service role).
3. **Configurer les 4 crons Supabase** (cadences dans DEPLOYMENT.md) — sans
   eux : pas de posts automatiques, pas d'emails de validation, pas de
   publication planifiée.
4. **Emails : vérifier le domaine dans Resend + DNS.** Tant que `RESEND_FROM`
   n'est pas sur un domaine vérifié avec SPF+DKIM (et idéalement DMARC), les
   emails de validation finiront en spam. Runbook §6.

### P1 — fiabilité d'exploitation
5. **Observabilité : il n'y en a AUCUNE.** Les erreurs partent en
   `console.error` (logs Supabase) et personne n'est alerté si un cron échoue.
   Minimum viable : Sentry sur le front + un cron de « health check » qui
   appelle `scripts/diagnose-graphiste.mjs` et alerte (email) si la clé/les
   crédits tombent. C'est la prochaine vraie dette.
6. **Routage image par plan** (GPT Image 2 prioritaire pour Pro/Enterprise) :
   documenté et budgété dans PRICING.md §1, PAS encore codé.
7. **Fonctionnalité vidéo IA** : affichée « bientôt disponible » sur la page
   tarifs, budgétée (Veo 3.1 Lite, quotas PRICING.md §3), PAS développée.
   Plafonds mensuels durs obligatoires le jour où vous la codez.

### P2 — dette technique (non urgente, à traiter au fil de l'eau)
8. **`src/pages/Dashboard.tsx` fait ~1 300 lignes.** Extraire des hooks
   (`usePosterGeneration`, `usePosts`) et des sous-composants. L'idée
   `applyGeneratedImage(postId, imageUrl)` (helper unique posts+dialog) vue
   sur main est bonne à reprendre à cette occasion.
9. **`src/integrations/supabase/types.ts` est généré** : après toute
   migration, regénérer (`supabase gen types typescript --project-id
   ixinojsmymqovekgkbdg > src/integrations/supabase/types.ts`).
10. **`deno check` des edge functions n'est pas dans la CI** (Deno absent du
    runner CI actuel). L'ajouter éviterait qu'une erreur de type edge ne se
    découvre qu'au déploiement.

---

## 6. Accès & identifiants — OÙ ils sont (jamais dans le repo)

| Accès | Où le trouver / le mettre |
|---|---|
| Secrets des edge functions (OpenRouter, Graphiste, Zernio, Resend, CRON_SECRET…) | **Supabase Dashboard → Project Settings → Edge Functions → Secrets** (projet `ixinojsmymqovekgkbdg`). Liste de référence : DEPLOYMENT.md §2. |
| Variables front (VITE_*) | Local : `.env.local` (jamais commité). CI/prod : **GitHub → repo → Settings → Secrets and variables → Actions** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, + `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, `SUPABASE_ACCESS_TOKEN`). |
| Compte Graphiste GPT (clé + crédits) | Compte Graphiste GPT du propriétaire ; solde vérifiable via `GET /v1/account/credits` ou le script de diagnostic. |
| Zernio | https://zernio.com/dashboard/api-keys (clé `sk_` + 64 hex). |
| Resend (email) | https://resend.com → API Keys + Domains (vérification SPF/DKIM). |
| Netlify | Compte Netlify du propriétaire (site id dans les secrets GitHub). |
| Base de données / SQL | Supabase Dashboard → SQL Editor. Attribution manuelle d'un plan : `UPDATE public.profiles SET plan='pro' WHERE id='<uuid>';` (service role uniquement — depuis le dashboard ça marche). |

### Runbook email (SPF / DKIM / DMARC) — à faire une fois

1. Resend → **Domains** → Add domain (le domaine de `RESEND_FROM`).
2. Poser chez le registrar les enregistrements que Resend affiche :
   TXT SPF (`v=spf1 include:...`), CNAME/TXT DKIM (`resend._domainkey...`).
3. Ajouter DMARC (recommandé) : TXT sur `_dmarc.votredomaine` →
   `v=DMARC1; p=quarantine; rua=mailto:postmaster@votredomaine`.
4. Vérifier :
   ```bash
   dig TXT votredomaine.com +short          # doit contenir v=spf1 ... include resend
   dig TXT resend._domainkey.votredomaine.com +short   # DKIM
   dig TXT _dmarc.votredomaine.com +short   # DMARC
   ```
5. Dans Supabase Secrets, `RESEND_FROM="Pro Social AI <no-reply@votredomaine.com>"`
   — l'adresse DOIT être sur le domaine vérifié, sinon Resend refuse ou spam.

---

## 7. CHECKLIST FINALE — à dérouler AVANT de développer quoi que ce soit

Cochez dans l'ordre. Chaque étape a un résultat observable.

### A. Reprendre le code
- [ ] 1. Merger la PR de la branche `claude/kind-ramanujan-1n68fi` dans `main`
      (vérifié : **0 conflit**). C'est elle qui porte le fix image, l'audit
      sécurité et cette documentation. Le merge déclenchera automatiquement
      le déploiement des fonctions ET du front.
- [ ] 2. `git pull` sur main, puis `npm ci && npm test && npm run lint && npm run build`
      → attendu : 73 tests OK, 0 erreur lint, build vert.

### B. Prouver la génération d'images (la panne historique)
- [ ] 3. Supabase → Edge Functions → Secrets : vérifier que
      `GRAPHISTE_GPT_API_KEY` **existe**. Si absente → c'est la cause de
      « texte sans image » : l'ajouter.
- [ ] 4. Lancer `GRAPHISTE_GPT_API_KEY="..." node scripts/diagnose-graphiste.mjs`
      → attendu : `✅ LA GÉNÉRATION D'IMAGE FONCTIONNE`. Si 401 → régénérer la
      clé ; si 402 → recharger les crédits ; si timeout → contacter Graphiste.
- [ ] 5. Dans l'app (compte de test) : « Générer un post » → le texte apparaît
      immédiatement, l'affiche suit (jusqu'à quelques minutes, spinner visible,
      et elle survit à un rechargement de page grâce à la reprise de job).

### C. Vérifier la configuration de production
- [ ] 6. Secrets Supabase tous présents (liste DEPLOYMENT.md §2 ; minimum :
      OPENROUTER_API_KEY, GRAPHISTE_GPT_API_KEY, ZERNIO_API_KEY, CRON_SECRET,
      ALLOWED_ORIGINS=<origine Netlify exacte>, APP_BASE_URL, RESEND_API_KEY,
      RESEND_FROM).
- [ ] 7. Secrets GitHub Actions présents (VITE_*, NETLIFY_*, SUPABASE_ACCESS_TOKEN)
      → les 3 workflows verts dans l'onglet Actions après le merge.
- [ ] 8. Crons Supabase configurés avec le header `x-cron-secret` (4 cadences,
      DEPLOYMENT.md) → attendu lundi suivant : posts auto générés + email de
      validation reçu.
- [ ] 9. Email : domaine vérifié dans Resend + les 3 `dig` du runbook §6
      répondent → un email de validation atterrit en boîte de réception (pas
      en spam).

### D. Parcours utilisateur complet (30 min, compte de test)
- [ ] 10. Inscription → onboarding → connexion d'un réseau (Zernio) →
      génération d'un post (texte + affiche) → validation → publication →
      le post est visible sur le réseau social → il apparaît dans Statistiques.
- [ ] 11. Vérifier le plan : un nouveau compte est `starter` ; tenter
      `UPDATE profiles SET plan='enterprise'` **depuis le client** (console
      navigateur) → doit être ignoré (trigger). L'attribuer depuis le SQL
      Editor → l'auto-réponse aux commentaires se débloque.

### E. Avant la mise en paiement (plus tard, mais bloquant pour encaisser)
- [ ] 12. Intégration Mobile Money (CinetPay/PayDunya) + webhook → `plan`.
- [ ] 13. Relire `docs/PRICING.md` en entier (quotas, add-ons, marges par
      palier Zernio) avant de figer la grille publique.
- [ ] 14. Mettre en place l'observabilité minimale (§5 P1) — ne lancez pas
      commercialement un produit dont vous ne voyez pas les pannes.

---

*Bonne reprise. Le projet est en bien meilleur état qu'il n'y paraît : la
sécurité est sérieuse, les tests sont verts, la CI déploie tout, et la seule
panne visible (« pas d'image ») a une cause identifiée, corrigée côté code,
et un script qui vous dira en une commande ce qui reste à configurer côté
compte. Suivez la checklist dans l'ordre.*
