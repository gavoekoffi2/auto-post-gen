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
npm test        # DOIVENT tous passer
npm run lint    # 0 erreur (7 warnings shadcn/fast-refresh connus, non bloquants)
npm run build   # build Vite 7
```

La CI (`.github/workflows/ci.yml`) exécute ces commandes plus `npm run
typecheck` (vite build n'analyse pas les types), `deno check` sur les Edge
Functions et `npm run test:schema` (migrations sur un vrai Postgres).

### En production

> **Corrigé le 10/09/2026.** Cette section décrivait un hébergement Netlify et
> le projet Supabase `ixinojsmymqovekgkbdg`. Les deux sont faux : le frontend
> a été déplacé sur un VPS et le backend pointe sur `tktoyntaeajgsuplhntd`.

| Quoi | Où | Déclencheur |
|---|---|---|
| Frontend (SPA React) | **VPS** — nginx dans Docker derrière Traefik, `docker-compose.vps.yml` + `nginx.vps.conf`, sur `https://auto-post-gen.76.13.129.252.sslip.io` | **manuel** : `npm run build` puis copier `dist/` sur le VPS et `docker compose -f docker-compose.vps.yml up -d`. `deploy-netlify.yml` ne déploie plus rien (lint/tests/build uniquement, sur déclenchement manuel). |
| Edge Functions (23) | **Supabase** (projet `tktoyntaeajgsuplhntd`) | push sur `main` touchant `supabase/**` → `.github/workflows/deploy-functions.yml` (déploie TOUT) |
| Base de données | **Supabase Postgres** | le même workflow ré-applique toutes les migrations datées ≥ `MIGRATION_CUTOFF` (`20260721000000`), puis vérifie que le schéma contient les colonnes/fonctions utilisées par les Edge Functions. Les migrations antérieures au cutoff ne sont **jamais** rejouées : elles sont supposées déjà appliquées. |
| Tâches planifiées | **Supabase Scheduler** (dashboard) | voir cadences dans `DEPLOYMENT.md` §Cron — **à configurer à la main, rien ne les crée** |

Déployer le **backend** = merger sur `main`. Déployer le **frontend** = à la
main, voir ci-dessus.

Toute nouvelle migration doit être **idempotente** (elle est ré-appliquée à
chaque déploiement). `npm run test:schema` l'applique à un vrai Postgres,
vérifie qu'elle est rejouable et rejoue les invariants du produit (RLS,
quotas, file de publication).

---

## 2. Architecture réelle (vérifiée, pas théorique)

```
Navigateur ── SPA React/Vite (VPS nginx/Traefik, CSP stricte, headers sécurité)
    │  supabase-js (anon key + RLS)
    ▼
Supabase ──┬─ Auth (sessions JWT, localStorage, autoRefresh)
           ├─ Postgres : 6 tables, RLS activé PARTOUT
           │    profiles, posts, social_connections, social_comments,
           │    generation_usage, ip_rate_events
           ├─ Storage : bucket user-assets (affiches réhébergées)
           └─ 23 Edge Functions (Deno) ── APIs externes :
                ├─ OpenRouter        → TEXTE IA (Claude uniquement, chaîne
                │                       de repli Claude dans _shared/ai.ts)
                ├─ Graphiste GPT     → AFFICHES IA (exclusif, pas de repli)
                ├─ Zernio            → publication sociale (SEULE voie active)
                ├─ Postiz / Ayrshare → CODE MORT : publish-post les ignore
                ├─ OAuth direct      → CODE MORT : publish-post les ignore
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

3. **La publication passe UNIQUEMENT par Zernio.** `publish-post` ne lit que
   les connexions `provider = 'zernio'`. Les fonctions Postiz, Ayrshare et
   OAuth direct existent encore dans `supabase/functions/` mais **aucune n'est
   utilisée** : un compte connecté autrement ne publiera jamais. Le dialogue
   « Gérer vos réseaux sociaux » n'offre donc que les 4 réseaux réellement
   publiables (LinkedIn, Facebook, Instagram, X) — c'est aussi ce que
   contraint `posts.platforms` en base. Pour en ajouter un, il faut modifier
   les trois endroits ensemble : la contrainte CHECK, le sélecteur de réseaux
   (Onboarding/Profil) et `ZERNIO_PLATFORMS`.

4. **Publication par nombre de comptes connectés, pas par plateforme.**
   Zernio facture par compte social connecté ($1–6/compte/mois selon le volume
   global). Les plans (Starter 2, Pro 3, Enterprise 8 réseaux) sont donc
   dénommés en « nombre de réseaux », ce qui rend l'ajout futur de
   TikTok/YouTube **sans impact tarifaire** (voir PRICING.md §8). L'OAuth
   direct (Facebook/Instagram/LinkedIn), déjà codé, coûte 0 — c'est le levier
   n°1 de marge documenté dans PRICING.md.

5. **Sécurité en profondeur côté serveur, jamais côté client.**
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

6. **Tests = assertions sur les sources + tests comportementaux.** La plupart
   des tests lisent les fichiers sources et vérifient des invariants de
   POLITIQUE (« pas de repli image », « CORS fail-closed », « quotas
   présents »). C'est voulu : rapide, zéro harnais, et ça épingle les
   régressions de design. `tests/graphiste-parse.test.js` est comportemental
   (import TS réel via type-stripping Node 22). Étendez ce style ; ne
   supprimez pas un test qui casse — il casse parce qu'un invariant est violé.

7. **FCFA d'abord.** Marché cible : Afrique de l'Ouest francophone. Prix
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
| Headers front | ✅ | CSP stricte, HSTS, X-Frame-Options DENY, etc. via `nginx.vps.conf`. `netlify.toml` n'est plus utilisé. |

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

## 4 bis. Bugs traités lors de l'audit du 10/09/2026

Passe d'audit avant l'ouverture aux premiers utilisateurs. Chaque point
ci-dessous était atteignable en usage normal.

| Criticité | Bug | Cause | Correctif |
|---|---|---|---|
| **BLOQUANT** | Les publications d'un utilisateur pouvaient ne JAMAIS partir à cause d'un autre utilisateur | `publish-post` remettait en `validated` tout post non publiable (aucun réseau connecté, ou réponse « en file » du fournisseur) alors que son `scheduled_for` était déjà passé. Le cron sélectionne les posts dus **triés du plus ancien au plus récent avec LIMIT 12** : une poignée de posts bloqués occupait donc le lot entier à chaque tick, indéfiniment, et affamait la file de tout le monde. | Colonnes `publish_attempts` / `next_publish_attempt_at` (migration `20260910000000`), backoff entre tentatives, échec définitif après 5 essais → le post apparaît en « échec » dans le dashboard avec son motif et un bouton Réessayer. Reproduit et vérifié sur un vrai Postgres (`npm run test:schema`). |
| **BLOQUANT** | Aucune nouvelle migration n'atteignait la production | Le workflow de déploiement appliquait **trois fichiers de migration nommés en dur**. Une nouvelle migration n'était appliquée que si quelqu'un pensait à ajouter une quatrième étape — et une Edge Function poussée en même temps référençait alors une colonne inexistante. | Boucle sur toutes les migrations ≥ `MIGRATION_CUTOFF`, + garde-fou qui fait échouer le déploiement si une migration datée sous le cutoff apparaît, + étape qui vérifie que le schéma de production contient toutes les colonnes/fonctions utilisées par les Edge Functions. |
| **MAJEUR** | Spinner d'affiche infini, à chaque chargement de page | En cas d'échec définitif du job Graphiste, la ligne du post gardait `image_status = 'processing'` et un `image_job_id` mort. Le dashboard relançait donc ce job mort à **chaque** chargement, sans jamais pouvoir aboutir. | Les échecs sont persistés (`image_status = 'failed'`, job effacé) ; le dashboard ne reprend que les jobs réellement en cours. |
| **MAJEUR** | Une clé Graphiste invalide consommait le quota d'images de l'utilisateur | La réservation horaire était prise avant l'appel au fournisseur et jamais rendue. | La réservation est relâchée (suppression **par id**) quand le fournisseur échoue avant tout rendu payant. |
| **MAJEUR** | Toute indisponibilité du modèle texte dégradait silencieusement chaque post | Un seul slug de modèle était figé ; à la moindre erreur, `generate-content` renvoyait l'un de ses 3 textes de repli, sans que rien ne le signale. | Chaîne de repli **exclusivement Claude** dans `_shared/ai.ts` ; on n'avance dans la chaîne que sur les statuts signifiant « ce modèle est inutilisable » (jamais sur 401/402). |
| **MAJEUR** | Deux posts programmés à la seconde près | `preferredDays[i % preferredDays.length]` : avec plus de posts par semaine que de jours choisis, les posts 4 et 5 recevaient le même `scheduled_for` que les posts 1 et 2 et partaient à la suite. | L'index de créneau continue au-delà des posts déjà en file et décale l'heure à chaque repassage sur un même jour. |
| **MAJEUR** | Les posts générés manuellement ne se publiaient jamais tout seuls | Ils étaient enregistrés avec `scheduled_for = NULL` : absents du calendrier, date vide sur la carte, et invisibles pour le cron (dont la requête filtre sur `scheduled_for`). | Ils reçoivent le prochain créneau préféré de l'utilisateur. |
| **MAJEUR** | Modifier un post décalait son horaire | Le dashboard envoyait `"AAAA-MM-JJTHH:MM:00"` (sans fuseau) à une colonne `timestamptz`, lue comme de l'UTC, alors que l'affichage était en heure locale. | Conversion explicite heure locale → instant ISO. |
| **MAJEUR** | Un compte connecté pouvait n'être jamais publiable | Le dialogue de connexion proposait 7 réseaux (YouTube, Pinterest, Threads…) que `posts.platforms` et le sélecteur de profil refusent. | Le dialogue n'offre plus que les 4 réseaux réellement publiables. |
| **MAJEUR** | En-têtes de sécurité perdus + page blanche après déploiement | `nginx.vps.conf` : un `add_header` dans un `location` **remplace** les en-têtes hérités — les assets perdaient donc CSP et HSTS ; et `index.html` n'avait aucun `Cache-Control`, donc un navigateur gardait l'ancien et demandait des bundles supprimés. | `expires` au lieu de `add_header` : CSP/HSTS conservés partout, `index.html` en `no-cache`. Vérifié avec un vrai nginx servant le build réel. |
| Moyen | SSRF possible dans la re-publication d'affiche | Le chemin interactif de `generate-image` utilisait un `fetch()` nu sur une URL issue d'une réponse d'API externe (pas de garde, pas de plafond de taille), alors que le chemin cron utilisait bien `fetchImageBytes`. | Même helper protégé des deux côtés. |
| Moyen | 8 erreurs de types invisibles | `vite build` utilise SWC, qui **supprime** les types sans les vérifier, et Deno n'était pas dans la CI : 5 erreurs edge + 3 erreurs front pouvaient partir en production avec un build vert. | Corrigées, et la CI exécute désormais `tsc --noEmit`, `deno check` et `npm run test:schema`. |
| Moyen | Régénérer le texte laissait l'ancienne affiche en cours | `image_job_id` / `image_status` n'étaient pas effacés, et `content_category` n'était pas mis à jour. | Les deux sont remis à zéro avec le nouveau texte. |
| Moyen | Faux témoignages clients en page d'accueil | Quatre clients inventés (noms, rôles, photos de banque d'images, « +300 % d'engagement ») au-dessus de chiffres d'usage inventés, pour un produit sans aucun utilisateur. | Remplacés par des affirmations vérifiables sur ce que le produit fait. Remettez de vrais témoignages quand de vrais clients en auront donné, avec leur accord. |
| Info | Documentation trompeuse | README/HANDOVER décrivaient un hébergement Netlify automatique et le projet Supabase `ixinojsmymqovekgkbdg`. En réalité : VPS, déploiement frontend **manuel**, projet `tktoyntaeajgsuplhntd`. | Corrigés. |

---

## 4 ter. Bugs traités lors de la seconde passe (11/09/2026)

Relecture complète des chemins non couverts par la première passe.

| Criticité | Bug | Cause | Correctif |
|---|---|---|---|
| **BLOQUANT** | Un nouvel utilisateur pouvait ne JAMAIS terminer son inscription | À l'étape 3 de l'onboarding, `handleNext` faisait `return` quand `detect-audiences` échouait. Le bouton « Ajouter une cible personnalisée » se trouve à l'étape **4** : pendant une panne du fournisseur IA, l'utilisateur était donc bloqué définitivement, sans aucune issue. | L'analyse est une commodité, jamais un verrou : on passe à l'étape 4 dans tous les cas, avec un message expliquant comment saisir la cible à la main. **Vérifié dans un vrai navigateur** en simulant la panne (`detect-audiences` renvoie 502). |
| **SÉCURITÉ (multi-locataire)** | Un utilisateur pouvait publier sur les réseaux sociaux d'un AUTRE utilisateur | `zernio-connect` retombait sur le profil Zernio **par défaut de l'opérateur** quand la création d'un profil dédié échouait (limite du plan), « pour que la connexion fonctionne quand même ». Or `publish-post` publie vers les comptes rattachés au profil : deux utilisateurs dans le même profil = publications croisées. | Refus explicite avec le motif et la marche à suivre. Un profil partagé n'est jamais attribué. |
| **SÉCURITÉ (multi-locataire)** | Les comptes et commentaires de tous les locataires pouvaient fuiter | `zernioListAccounts(null)` et `zernioListCommentedPosts(null)` omettaient `profileId`, ce qui fait renvoyer par l'API **tous** les comptes / toutes les publications commentées, tous profils confondus. `zernio-status` et `sync-comments` transmettaient un `profile_key` potentiellement NULL tel quel. | Les deux helpers refusent désormais un `profileId` absent ; les appelants ignorent une ligne sans clé de profil. |
| **MAJEUR** | Un post ciblant X/Twitter ne pouvait pas être publié | Aucune limite de longueur n'était appliquée dans le chemin réel — le seul `slice(0, 280)` se trouvait dans le publieur Twitter direct, qui est du code mort. Les posts générés font 600-1100 caractères : tout post adressé à X dépassait plusieurs fois les 280 autorisés et ne pouvait être que refusé ou coupé en plein milieu par le fournisseur (perdant l'appel à l'action et les hashtags). | Nouveau module `platformTextLimits` (miroir front/edge, identité vérifiée par test). Le réseau le plus contraignant sélectionné impose la limite : les deux générateurs briefent le modèle en conséquence, `ensurePostEngagement` reçoit un plafond dur, le dashboard affiche un compteur en direct et alerte sur la carte, et `publish-post` échoue en nommant le réseau et le dépassement — tout en publiant vers les réseaux qui, eux, passent. |
| **MAJEUR** | Le texte des posts était corrompu | `ensurePostEngagement` retirait **tous** les hashtags du corps : « suivez le hashtag #Marketing pour… » devenait « suivez le hashtag  pour… », et « le #1 des conseils » perdait son « #1 » (récupéré comme hashtag). | Seul un bloc de hashtags **final** est déplacé ; un hashtag dans la phrase y reste et est exclu de la ligne finale pour ne pas apparaître deux fois. |
| **MAJEUR** | Le ciblage d'audience était silencieusement perdu | Le dashboard gardait une cible sans description, le serveur la supprimait. Un utilisateur pouvait sélectionner une cible, l'enregistrer, et voir tous ses posts rédigés « pour tout le monde » sans aucune explication. | Même règle des deux côtés ; l'éditeur refuse de cocher une cible que le serveur écarterait, et dit pourquoi. Une cible ajoutée à la main démarre **vide** au lieu d'être pré-remplie d'un texte de substitution envoyé au modèle comme un vrai brief. |
| Moyen | Une analyse d'audience ratée consommait un essai | Le quota était réservé avant l'appel et jamais rendu — l'utilisateur brûlait ses 10 essais horaires pendant une panne, en plein onboarding. | Réservation relâchée en cas d'échec. |
| Moyen | Injection d'en-tête possible via le formulaire de contact | `name` et `subject` étaient recopiés dans des champs d'en-tête d'e-mail sans filtrer les retours à la ligne. | CR/LF supprimés. |
| Moyen | La suppression de compte ne supprimait pas tout | Le nettoyage du stockage s'arrêtait aux 1000 premiers objets ; un compte actif peut générer 200 affiches par mois. | Pagination bornée. Le profil Zernio, lui, survit (l'API n'expose aucun endpoint de suppression) : c'est désormais journalisé explicitement pour que l'opérateur le retire à la main — sinon il continue d'être facturé. |
| Info | Isolation du stockage : **vérifiée, rien à corriger** | La politique UPDATE de `storage.objects` ne déclare qu'un `USING` sans `WITH CHECK`. Postgres réutilise alors le `USING` comme `WITH CHECK` : un utilisateur ne peut donc pas renommer son fichier vers le dossier d'un autre. Comportement prouvé sur un vrai Postgres et verrouillé par trois tests (`npm run test:schema`). |

---

## 5. Fragilités connues & feuille de route proposée

### P0 — avant d'encaisser le moindre franc

> Les deux bugs bloquants trouvés le 10/09/2026 (file de publication affamée,
> migrations qui n'atteignaient jamais la production) sont corrigés — voir
> §4 bis. Ce qui reste ci-dessous est de la **configuration**, pas du code.

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
   tktoyntaeajgsuplhntd > src/integrations/supabase/types.ts`).
10. ~~**`deno check` des edge functions n'est pas dans la CI**~~ — fait
    (10/09/2026). La CI a maintenant trois jobs : `check` (lint, `tsc
    --noEmit`, tests, build), `functions` (`deno check`) et `schema`
    (migrations appliquées à un vrai Postgres + invariants du produit).
11. **Le frontend n'a AUCUN déploiement automatique** depuis le passage de
    Netlify au VPS. C'est aujourd'hui la principale marche manquante : un
    merge sur `main` met à jour les Edge Functions mais laisse le frontend
    figé. À automatiser (rsync/scp du `dist/` + `docker compose up -d` depuis
    une action GitHub avec une clé SSH de déploiement).
12. **Aucun fuseau horaire par profil.** `auto-generate-weekly` calcule le jour
    et l'heure de publication dans le fuseau du runtime edge, c'est-à-dire UTC.
    C'est juste pour le marché principal (Côte d'Ivoire, Sénégal, Mali… sont en
    UTC+0), mais un utilisateur au Cameroun (UTC+1) reçoit ses posts décalés
    d'une heure. Le correctif est une colonne `timezone` (IANA) sur `profiles`,
    demandée à l'onboarding, utilisée par le générateur — schéma + UI, pas un
    patch ponctuel.
13. **Aucun test ne s'exécute contre les vraies APIs externes** (Graphiste,
    OpenRouter, Zernio). Les tests vérifient les invariants du code et du
    schéma ; ils ne prouvent pas qu'une clé est valide. `scripts/diagnose-graphiste.mjs`
    reste le seul contrôle bout-en-bout, et il est manuel.

---

## 6. Accès & identifiants — OÙ ils sont (jamais dans le repo)

| Accès | Où le trouver / le mettre |
|---|---|
| Secrets des edge functions (OpenRouter, Graphiste, Zernio, Resend, CRON_SECRET…) | **Supabase Dashboard → Project Settings → Edge Functions → Secrets** (projet `tktoyntaeajgsuplhntd`). Liste de référence : DEPLOYMENT.md §2. |
| Variables front (VITE_*) | Local : `.env.local` (jamais commité). CI/prod : **GitHub → repo → Settings → Secrets and variables → Actions** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, + `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, `SUPABASE_ACCESS_TOKEN`). |
| Compte Graphiste GPT (clé + crédits) | Compte Graphiste GPT du propriétaire ; solde vérifiable via `GET /v1/account/credits` ou le script de diagnostic. |
| Zernio | https://zernio.com/dashboard/api-keys (clé `sk_` + 64 hex). |
| Resend (email) | https://resend.com → API Keys + Domains (vérification SPF/DKIM). |
| VPS frontend | Accès SSH au VPS du propriétaire (Traefik + Docker). Le frontend se déploie à la main. |
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
      ALLOWED_ORIGINS=https://auto-post-gen.76.13.129.252.sslip.io, APP_BASE_URL, RESEND_API_KEY,
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
