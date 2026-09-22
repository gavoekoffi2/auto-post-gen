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
npm test         # 103 tests — DOIVENT tous passer
npm run lint     # 0 erreur (7 warnings shadcn/fast-refresh connus, non bloquants)
npm run typecheck # tsc : `vite build` NE typecheck PAS, d'où ce gate séparé
npm run build    # build Vite 7
```

La CI (`.github/workflows/ci.yml`) exécute exactement ces quatre commandes sur
chaque PR : si ça passe en local, ça passera en CI.

### En production

Le **frontend est hébergé sur un VPS** (Docker + Nginx derrière Traefik) ;
le backend (base, auth, storage, fonctions) reste **managé par Supabase**.
Il n'y a pas de n8n.

| Quoi | Où | Déclencheur |
|---|---|---|
| Frontend (SPA React) | **VPS** (Docker + Nginx derrière Traefik) | build `npm run build` puis `docker compose -f docker-compose.vps.yml up -d` sur le VPS |
| Edge Functions (23) | **Supabase** (projet `tktoyntaeajgsuplhntd`) | push sur `main` touchant `supabase/functions/**` → `.github/workflows/deploy-functions.yml` (déploie TOUT) |
| Base de données | **Supabase Postgres** | migrations dans `supabase/migrations/`, appliquées automatiquement par `scripts/apply-migrations.mjs` depuis la CI |
| Tâches planifiées | **Supabase Scheduler** (dashboard) | voir cadences dans `DEPLOYMENT.md` §Cron |

Déployer le backend = merger sur `main`. Le frontend se redéploie sur le VPS
(`npm run build` puis `docker compose -f docker-compose.vps.yml up -d`).

---

## 2. Architecture réelle (vérifiée, pas théorique)

```
Navigateur ── SPA React/Vite (VPS Nginx, CSP stricte, headers sécurité)
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
| Headers front | ✅ | CSP stricte, HSTS, X-Frame-Options DENY, etc. via `nginx.vps.conf`. |

Notes mineures (acceptées, pas des trous) :
- La comparaison du `CRON_SECRET` est un `!==` simple (pas timing-safe). Avec
  un secret long aléatoire sur TLS, l'attaque par timing est impraticable ;
  si vous y touchez un jour, utilisez une comparaison à temps constant.
- La clé anon Supabase est visible dans le bundle front : c'est **normal**
  (elle est conçue pour ça) ; la sécurité repose sur RLS, pas sur son secret.

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

## 4 bis. Deuxième passe d'audit (22/09/2026)

Audit complet du code **avant toute modification**, puis correction. Les
défauts ci-dessous étaient tous présents en production.

### Bloquants pour un premier utilisateur

| Défaut | Pourquoi c'était grave |
|---|---|
| L'onboarding pouvait être une **impasse définitive** : l'étape 3 refusait d'avancer tant que l'analyse IA des cibles n'aboutissait pas | Clé OpenRouter absente, quota épuisé ou panne du fournisseur = un nouveau compte n'atteignait **jamais** le tableau de bord. Analyse désormais best-effort, saisie manuelle en repli. |
| La **programmation corrompait les heures** | Le tableau de bord lisait la date en UTC et l'heure en local, puis sauvegardait les deux collés sans fuseau — que Postgres relit comme de l'UTC. Chaque post ré-enregistré dérivait ; près de minuit il changeait de jour. Tout passe par `src/lib/datetime.ts`. |
| Du **texte générique présenté comme de l'IA** | `generate-content` répond 200 avec un post pré-écrit quand le fournisseur est injoignable ; l'écran affichait quand même « Post enrichi par recherche web généré ». |
| Erreurs illisibles partout | « Edge Function returned a non-2xx status code » au lieu de la vraie cause. `src/lib/functionError.ts` extrait le message réel. |

### Sécurité

| Défaut | Impact |
|---|---|
| **Fuite de la clé Graphiste GPT** | Les deux boucles de polling ajoutaient le `statusUrl` reçu à leur liste d'URL puis le requêtaient avec `Authorization: Bearer <GRAPHISTE_GPT_API_KEY>`. Cette valeur est choisie par l'attaquant de deux façons : `generate-image` la lit dans le corps de la requête, et `publish-post` lit `posts.image_status_url`, colonne que RLS laisse écrire à son propriétaire. N'importe quel compte connecté pouvait donc pointer le polling vers son serveur et récupérer la clé payante de l'opérateur. Corrigé par `safeGraphisteStatusUrl` (même origine, https). |
| **Prise de contrôle du compte propriétaire** | `admin-api` laissait tout super-admin réinitialiser le mot de passe du propriétaire, compte pourtant protégé contre la rétrogradation, le blocage et la suppression. |
| **10 endpoints publics morts** | `ayrshare-*`, `postiz-*` et les 6 fonctions OAuth directes, injoignables depuis l'app depuis le passage en Zernio-only mais toujours déployées et appelables — les callbacks écrivaient encore des jetons sociaux en base. Supprimées. |
| Email personnel du fondateur livré dans le bundle JS public | Remplacé par un drapeau `protectedOwner` renvoyé par le serveur. |
| Téléchargement d'image non borné dans `generate-image` | Passe par le helper anti-SSRF avec plafond de taille. |

### Modèle économique : les forfaits étaient vendus mais **jamais appliqués**

La page tarifs vend 3/7/10 posts par semaine et 2/3/8 réseaux ; la colonne
`plan` ne conditionnait que l'auto-réponse aux commentaires. Un compte Starter
pouvait mettre `post_frequency` à 10, connecter autant de réseaux qu'il
voulait, et consommer le même budget IA forfaitaire que tout le monde.

`supabase/functions/_shared/plans.ts` est désormais la source unique, appliquée
**côté serveur** : le cron hebdomadaire plafonne au forfait, les quotas
mensuels texte/affiche viennent du forfait, et `zernio-connect` refuse un
réseau supplémentaire au-delà du nombre inclus (reconnecter un réseau déjà lié
reste toujours possible). Le forfait est toujours lu en base avec le rôle
service — jamais pris dans la requête. `src/lib/plans.ts` en est le miroir pour
l'interface, et un test échoue si les deux divergent.

### Liens de validation : le TTL ne fonctionnait pas

`posts.validation_token` a une valeur par défaut depuis 20251203, mais
`validation_token_created_at` n'en a jamais eu : NULL sur chaque post créé
depuis, et `validate-post` saute le contrôle d'expiration quand c'est NULL.
L'expiration de 24 h documentée ne s'est donc **jamais** appliquée à un seul
post réel — ces liens étaient permanents. Corrigé par migration, et la durée de
vie se compte maintenant depuis l'envoi de l'email (une fenêtre mesurée depuis
la création pouvait être à moitié écoulée avant que le mail parte).

### Page d'accueil : allégations fabriquées

Quatre témoignages de clients inexistants (noms, entreprises, photos de
personnes réelles prises sur Unsplash, résultats inventés), « plus de 10 000
créateurs », 10K+ utilisateurs, 500K+ posts, 98 % de satisfaction — pour un
produit sans premier utilisateur. Présenter de faux témoignages figure à
l'annexe I de la directive 2005/29/CE parmi les pratiques déloyales **en toutes
circonstances**, et les fausses allégations sur la clientèle relèvent de la
pratique commerciale trompeuse (C. conso. L121-2). Témoignages et chiffres
viennent désormais de `src/lib/testimonials.ts`, **livré vide** : les sections
ne s'affichent que s'il y a quelque chose de vrai à y mettre.

### Autres corrections notables

- Le workflow de déploiement n'appliquait que **3 migrations nommées à la
  main** : toute migration ajoutée depuis n'a jamais été appliquée en
  production. Remplacé par `scripts/apply-migrations.mjs` (registre en base,
  liste explicite des migrations déjà live, n'exécute que les nouvelles).
- **TypeScript n'était jamais vérifié** (`vite build` ne typecheck pas) :
  3 vraies erreurs dormaient dans `main`. Gate `npm run typecheck` en CI.
- Politique de mot de passe incohérente (6 à l'inscription, 8 en réglages) —
  unifiée à 8, appliquée aussi par le service d'auth.
- Suppression de compte : le nettoyage du stockage listait au plus 1000
  objets, dans un bucket **public**. Le reste restait téléchargeable après la
  suppression du compte.
- Un logo remplacé n'était jamais supprimé : l'ancien fichier restait public
  indéfiniment et s'accumulait à chaque changement.
- Le nom d'objet stocké tirait son extension du nom de fichier de
  l'utilisateur ; il vient maintenant du type MIME vérifié (SVG refusé).
- Import des commentaires : un `insert` simple faisait échouer **tout le lot**
  sur un seul doublon, erreur avalée — donc un cron concurrent avec une
  synchro manuelle n'importait rien, silencieusement.
- Le tableau de bord admin comptait avec `.length` sur des lignes plafonnées
  par PostgREST : les totaux cessaient silencieusement d'augmenter.
- Changement d'email en libre-service (« contactez le support » demandait
  d'écrire à une adresse qu'on ne peut justement plus atteindre), avec un
  trigger qui garde `profiles.email` — utilisée pour les emails de validation
  — synchronisée quelle que soit la façon dont l'adresse change.

### Observabilité : traitée

`/admin` porte un panneau **« État de la plateforme »** et
`health-alert` (cron horaire) **envoie un email** dès qu'un point est
réellement bloquant. Voir §5 P1.

---

## 5. Fragilités connues & feuille de route proposée

### P0 — avant d'encaisser le moindre franc
1. **Configurer et prouver `GRAPHISTE_GPT_API_KEY`** (checklist §7, étape 2).
   C'est LE point qui conditionne la promesse produit. Le panneau
   « État de la plateforme » de `/admin` le vérifie désormais en un clic.
2. **Brancher le paiement Mobile Money** (CinetPay ou PayDunya) : aujourd'hui
   `profiles.plan` est attribué **à la main** en SQL. Les add-ons du
   PRICING.md §4 dépendent de la même brique. Le webhook de paiement doit
   écrire `plan` via service role (le trigger laisse passer le service role).
   **Les limites de chaque forfait sont maintenant réellement appliquées**
   (§4 bis) : il ne reste que l'encaissement et l'attribution automatique.
3. **Configurer les 5 crons Supabase** (cadences dans DEPLOYMENT.md) — sans
   eux : pas de posts automatiques, pas d'emails de validation, pas de
   publication planifiée, et **aucune alerte** quand quelque chose casse.
   Commencez par `health-alert` : c'est celui qui vous prévient pour les
   quatre autres.
4. **Emails : vérifier le domaine dans Resend + DNS.** Tant que `RESEND_FROM`
   n'est pas sur un domaine vérifié avec SPF+DKIM (et idéalement DMARC), les
   emails de validation finiront en spam. Runbook §6.

### P1 — fiabilité d'exploitation
5. **Observabilité : partiellement traitée (16/09/2026).** Le centre de
   contrôle `/admin` expose désormais un panneau **« État de la plateforme »**
   (`admin-api`, action `health`, code dans `supabase/functions/_shared/health.ts`)
   qui vérifie à la demande : présence de chaque secret obligatoire, validité
   et crédits d'OpenRouter / Graphiste GPT / Zernio, et les signaux du
   pipeline (posts en retard de publication = cron mort, posts bloqués en
   `publishing`, affiches en attente > 6 h, génération hebdomadaire
   silencieuse). Chaque ligne en défaut porte sa correction.

   **Reste à faire** pour clore la dette : l'alerte *poussée*. Aujourd'hui il
   faut ouvrir la page pour voir la panne. Brancher un cron qui appelle
   `health` et envoie un email (Resend est déjà configuré) dès que `status`
   vaut `error`, et/ou Sentry sur le front pour les erreurs navigateur.
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
   tktoyntaeajgsuplhntd > src/integrations/supabase/types.ts`).
10. **`deno check` des edge functions n'est pas dans la CI** (Deno absent du
    runner CI actuel). L'ajouter éviterait qu'une erreur de type edge ne se
    découvre qu'au déploiement.

---

## 6. Accès & identifiants — OÙ ils sont (jamais dans le repo)

| Accès | Où le trouver / le mettre |
|---|---|
| Secrets des edge functions (OpenRouter, Graphiste, Zernio, Resend, CRON_SECRET…) | **Supabase Dashboard → Project Settings → Edge Functions → Secrets** (projet `tktoyntaeajgsuplhntd`). Liste de référence : DEPLOYMENT.md §2. |
| Variables front (VITE_*) | Local : `.env.local` (jamais commité). CI/prod : **GitHub → repo → Settings → Secrets and variables → Actions** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, + `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, `SUPABASE_ACCESS_TOKEN`). |
| Compte Graphiste GPT (clé + crédits) | Compte Graphiste GPT du propriétaire ; solde vérifiable via `GET /v1/account/credits` ou le script de diagnostic. |
| Zernio | https://zernio.com/dashboard/api-keys (clé `sk_` + 64 hex). |
| Resend (email) | https://resend.com → API Keys + Domains (vérification SPF/DKIM). |
| VPS frontend | Accès SSH au VPS du propriétaire ; Traefik + Let's Encrypt gèrent le TLS. |
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
      ALLOWED_ORIGINS=<origine VPS exacte>, APP_BASE_URL, RESEND_API_KEY,
      RESEND_FROM).
- [ ] 7. Secrets GitHub Actions présents (VITE_*, NETLIFY_*, SUPABASE_ACCESS_TOKEN)
      → les 3 workflows verts dans l'onglet Actions après le merge.
- [ ] 8. Crons Supabase configurés avec le header `x-cron-secret` (5 cadences,
      DEPLOYMENT.md) → attendu le lendemain : posts auto générés + email de
      validation reçu. **`health-alert` en premier** (horaire) : c'est lui qui
      vous signalera l'échec des autres.
- [ ] 8 bis. Ouvrir `/admin` → panneau « État de la plateforme » : tout doit
      être au vert. Chaque ligne en défaut porte sa correction.
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
- [ ] 11 bis. Vérifier les limites du forfait : sur un compte `starter`, le
      profil ne doit proposer que jusqu'à 3 posts/semaine, et la connexion
      d'un 3ᵉ réseau doit être refusée avec un message explicite.
- [ ] 11 ter. Renseigner `VITE_SUPPORT_EMAIL` (les pages légales la donnent
      comme contact pour les demandes RGPD — elle doit recevoir du courrier)
      et, si vous en avez, `VITE_SOCIAL_*`. Ajouter vos vrais témoignages dans
      `src/lib/testimonials.ts` quand des clients acceptent d'être cités.

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
