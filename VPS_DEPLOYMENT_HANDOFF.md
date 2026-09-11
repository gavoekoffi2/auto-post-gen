# VPS Deployment Handoff — Pro Social AI / Auto Post Gen

Document de reprise pour l'ingénieur qui déploiera cette branche sur le VPS.

> **Ce qui a été vérifié, et ce qui ne l'a pas été.** Tout ce qui est affirmé
> ici a été exécuté dans un bac à sable Linux : PostgreSQL 16 local, l'API
> démarrée et interrogée au curl, la suite de tests complète. **Rien n'a été
> exécuté sur le VPS, aucun déploiement n'a été fait, et aucun test de
> production n'a été passé.** La section 15 sépare explicitement les trois
> catégories. Ne lisez aucune phrase de ce document comme une confirmation que
> la production fonctionne.

---

## 1. SHA final de la branche

Branche : `claude/lucid-johnson-14zub1`

Dernier commit de code : `dd00433` (`git rev-parse dd00433` pour le SHA complet)

Ce document ne peut pas contenir le SHA de son propre commit. Le SHA ci-dessus
est celui du dernier commit de **code** ; la pointe de la branche est le
commit qui ajoute cette ligne, immédiatement après. Confirmez-la avant de
déployer :

```bash
git rev-parse claude/lucid-johnson-14zub1
```

Base de comparaison (dernier commit commun avec `main`) :
`af70b9035e96b70db7001b2254099b226bbb641c`

---

## 2. Résumé des fonctionnalités migrées

Le produit ne dépend plus d'aucun service managé. Tout ce qui vivait dans
Supabase (Auth, Database, Storage, Edge Functions, RLS, Scheduler) a été
réimplémenté dans une API Fastify auto-hébergée, sur le PostgreSQL du VPS.

| Domaine | Avant | Après |
| --- | --- | --- |
| Authentification | Supabase Auth (JWT côté navigateur) | Cookie de session HttpOnly, jeton opaque dont **seul le SHA-256 est stocké**. Mots de passe en scrypt + sel, comparaison en temps constant. |
| Isolation des comptes | RLS PostgreSQL | Prédicat `profile_id = $1` sur **chaque** lecture et écriture, avec l'identité tirée du cookie vérifié. Le navigateur n'annonce jamais qui il est. |
| Stockage | Supabase Storage | Volume local `pro-social-ai_media`, un répertoire par compte, nom de fichier tiré d'un UUID. |
| Génération de texte | Edge Function `generate-content` | `server/src/services/text.ts` — chaîne Claude, repli signalé comme tel. |
| Analyse des cibles | Edge Function `detect-audiences` | `POST /api/profile/audiences/detect`. **Cette route n'existait pas** : le dashboard l'appelait déjà, l'onboarding échouait donc à l'étape 3 pour tous les comptes. |
| Génération d'affiches | Edge Function `generate-image` | `server/src/services/generation.ts` — contrat asynchrone `processing` + `job_id`, relecture pure du statut. |
| Publication | Edge Function `publish-post` + cron Supabase | `server/src/services/publish.ts` + **une file de publication interne**. Il n'y avait aucun exécuteur : un post programmé ne partait jamais. |
| Génération hebdomadaire | Edge Function `auto-generate-weekly` + cron | `server/src/services/weekly.ts` + runner quotidien. Idem : aucun exécuteur, donc `post_frequency`, `preferred_days` et les quotas promo/recherche ne changeaient rien. |
| Quotas | RPC `consume_generation_quota` | Même fonction SQL, sous verrou consultatif, dans `0001_core_schema.sql`. |
| Limitation par IP | RPC `hit_ip_rate_limit` | Idem, sur `/auth/*`, `/contact` et la validation par lien. |
| Emails | Edge Function `send-validation-email` | `server/src/lib/mail.ts` (Resend). |
| Administration | Edge Function `admin-api` (clé service-role) | `requireAdmin` sur `/api/admin/*`, rôle relu en base. |
| Suppression de compte | Edge Function `delete-account` | `DELETE /api/account` — mot de passe re-vérifié, lignes supprimées en cascade, répertoire média effacé. |

Quatre défauts sérieux ont été trouvés **pendant** la migration et corrigés ;
ils sont détaillés en section 14 avec ce qu'ils cassaient.

---

## 3. Fichiers modifiés

166 fichiers : 42 ajouts, 72 suppressions, 50 modifications, 2 déplacements.

### Ajouts — l'API (`server/`)

```
server/package.json, package-lock.json, tsconfig.json, .gitignore
server/migrations/0001_core_schema.sql
server/migrations/0002_media_public_token.sql
server/src/index.ts                 démarrage, gestion d'erreurs, runners
server/src/migrate.ts               applicateur de migrations
server/src/lib/db.ts                pool, query, transaction
server/src/lib/env.ts               variables requises/optionnelles, capacités manquantes
server/src/lib/errors.ts            HttpError et ses constructeurs
server/src/lib/mail.ts              envoi d'emails
server/src/lib/media.ts             stockage, garde de chemin, ré-hébergement
server/src/lib/password.ts          scrypt, comparaison en temps constant
server/src/lib/rateLimit.ts         limitation par IP (échoue ouvert)
server/src/lib/session.ts           cookie, création/lecture/destruction
server/src/lib/tenant.ts            requireTenant, requireAdmin, clientIp
server/src/lib/validate.ts          validation stricte des entrées
server/src/routes/{auth,profile,posts,media,generations,misc}.ts
server/src/services/audiences.ts    analyse des cibles
server/src/services/generation.ts   affiches
server/src/services/publish.ts      publication
server/src/services/quota.ts        réservation/restitution
server/src/services/scheduler.ts    runners publication + hebdomadaire
server/src/services/text.ts         texte éditorial, chaîne Claude
server/src/services/weekly.ts       génération hebdomadaire
server/src/shared/graphisteParse.ts parseurs purs des réponses du moteur
server/src/shared/platformTextLimits.ts
server/src/shared/postEngagement.ts
server/src/shared/weeklyPlan.ts     arithmétique des créneaux
server/tests/api.test.ts            19 tests contre un vrai PostgreSQL
```

### Ajouts — le dashboard

```
src/lib/api.ts                 le client d'API unique
src/lib/session.tsx            contexte de session
src/lib/platformTextLimits.ts  copie côté navigateur
```

### Déplacements

```
supabase/functions/_shared/audience.ts         → server/src/shared/audience.ts
supabase/functions/_shared/socialImageSpecs.ts → server/src/shared/socialImageSpecs.ts
```

### Modifications — le dashboard (tout appel Supabase retiré)

```
src/App.tsx
src/components/{AccountSettings,AudienceEditor,CustomImageLibrary,LogoUpload}.tsx
src/components/{ProtectedRoute,ProtectedAdminRoute,SettingsDialog,SocialMediaConnect}.tsx
src/components/landing/{DashboardPreview,TestimonialsNew}.tsx
src/lib/{audiences,socialImageSpecs}.ts
src/pages/{About,Admin,Auth,Calendar,Comments,Contact,Dashboard}.tsx
src/pages/{ForgotPassword,Onboarding,Profile,ResetPassword,Statistics,ValidatePost}.tsx
vite.config.ts                 proxy /api en dev, chunk supabase retiré
package.json                   dépendance @supabase/supabase-js retirée
```

### Modifications — configuration et documentation

```
.env.example        réécrit : aucune variable de build côté frontend
.github/workflows/ci.yml
README.md           décrit la pile VPS
DEPLOYMENT.md       référence des variables, nginx, conteneurs
docs/HANDOVER.md    marqué comme historique
nginx.vps.conf
tests/*.test.js     18 fichiers repointés
```

### Suppressions

```
supabase/                              (config, 23 Edge Functions, 25 migrations)
src/integrations/supabase/{client,types}.ts
.github/workflows/deploy-functions.yml
.github/workflows/deploy-netlify.yml
.github/workflows/export-public-config.yml
netlify.toml
scripts/{test-schema.sh,test-image-gen.sh,test-openrouter-image.sh,diagnose-graphiste.mjs}
```

---

## 4. Dépendances Supabase retirées

| Dépendance | Remplacée par |
| --- | --- |
| Paquet npm `@supabase/supabase-js` | `src/lib/api.ts` (`fetch` vers `/api`) |
| `src/integrations/supabase/client.ts` | `src/lib/api.ts` |
| `src/integrations/supabase/types.ts` | types déclarés dans `src/lib/api.ts` |
| `supabase.auth.*` | `auth.*` du client d'API ; session par cookie |
| `supabase.from(...)` | routes REST de l'API, chacune filtrée par `profile_id` |
| `supabase.storage.*` | `media.*` du client d'API ; volume local |
| `supabase.functions.invoke(...)` | routes `/api/...` |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | **aucune variable de build** |
| RLS PostgreSQL | prédicat `profile_id` derrière l'API |
| Supabase Scheduler | runners internes à l'API |
| `SUPABASE_SERVICE_ROLE_KEY` | n'existe plus ; l'API est le seul accès à la base |
| CLI Supabase dans la CI | `npm run migrate` |

---

## 5. Preuve qu'aucun appel Supabase ne subsiste

Commandes et sorties réelles, exécutées sur la branche :

```console
$ grep -rn "@supabase/supabase-js" src/ package.json
(aucun résultat)

$ grep -rn "integrations/supabase" src/
(aucun résultat)

$ grep -rnE "supabase\.(auth|from|storage|functions)" src/
(aucun résultat)

$ grep -rn "VITE_SUPABASE" src/ .env.example vite.config.ts
(aucun résultat)

$ grep -rnE "fetch\(['\"\`]https?://" src/
(aucun résultat)          # le dashboard n'appelle que des chemins relatifs

$ ls supabase
ls: cannot access 'supabase': No such file or directory

$ npm run build && grep -rc supabase dist/ | grep -v ':0'
(aucun résultat)          # le bundle produit ne contient pas le mot
```

### Le backend et la configuration nginx, pas seulement le dashboard

Cette section ne couvrait initialement que `src/`. Deux dépendances
**fonctionnelles** y avaient donc échappé ; elles sont corrigées :

* `server/src/services/generation.ts` repliait la génération d'affiches sur une
  adresse `*.supabase.co` codée en dur dès que `GRAPHISTE_GPT_API_URL` était
  absente. Un opérateur renseignant seulement la clé envoyait donc chaque
  affiche — nom de l'entreprise, secteur, couleurs, et toute photo de dirigeant
  consentie — vers un projet Supabase qui ne lui appartient pas. Il n'y a plus
  de valeur par défaut : sans l'URL, la fonctionnalité est désactivée et le
  serveur le dit.
* `nginx.vps.conf` autorisait encore `https://*.supabase.co` et le `wss://`
  correspondant dans `connect-src`. `connect-src` vaut désormais exactement
  `'self'`.

```
$ grep -rnE "https?://[^\"'\`[:space:]]*supabase\.(co|in)" server/src/ nginx.vps.conf
(aucun résultat)
```

La CI exécute exactement cette commande, en plus des contrôles sur `src/` et
sur le bundle. Deux tests la doublent côté suite : aucun hôte Supabase dans une
URL du serveur, et une demande d'affiche refusée quand l'URL manque. Les deux
ont été vérifiés en réintroduisant l'ancienne adresse — ils échouent bien.

Les occurrences restantes du mot « supabase » dans le dépôt sont de la prose :
commentaires expliquant d'où vient un test ou pourquoi une valeur par défaut a
été retirée, et `docs/HANDOVER.md` / `docs/PRICING.md`, explicitement marqués
comme historiques en tête de fichier.

---

## 6. Routes de l'API

Toutes sous le préfixe `/api`, toutes sur la même origine que le dashboard.
« Session » = cookie `psa_session` vérifié côté serveur ; **aucune route
n'accepte un `profileId` ou un `userId` envoyé par le navigateur**.

### Authentification

| Méthode | Chemin | Auth | Corps / réponse |
| --- | --- | --- | --- |
| POST | `/auth/register` | non (20/h par IP) | `{"email":"a@b.c","password":"…"}` → `201 {"user":{…}}` + cookie |
| POST | `/auth/login` | non (20/15 min par IP) | `{"email":"a@b.c","password":"…"}` → `200 {"user":{…}}` + cookie |
| POST | `/auth/logout` | session | — → `204` |
| GET | `/auth/me` | session | → `200 {"user":{"id","email","role","createdAt"}}` |
| PATCH | `/auth/password` | session | `{"currentPassword":"…","newPassword":"…"}` → `200 {"ok":true}` ; invalide toutes les autres sessions |
| POST | `/auth/password-reset/request` | non (5/h par IP) | `{"email":"a@b.c"}` → **toujours** `200 {"ok":true}` |
| POST | `/auth/password-reset/confirm` | non (20/h par IP) | `{"token":"…","password":"…"}` → `200 {"ok":true}` |

### Profil

| Méthode | Chemin | Auth | Corps / réponse |
| --- | --- | --- | --- |
| GET | `/profile` | session | → `200 {…profil…}` |
| PATCH | `/profile` | session | `{"sector":"Restauration","platforms":["LinkedIn"]}` → profil. **`plan`, `role`, `blocked_at`, `email` et le consentement sont refusés silencieusement** : ils ne figurent pas dans la liste blanche. |
| POST | `/profile/audiences/detect` | session (10/h) | corps ignoré → `200 {"audiences":[…]}` |
| POST | `/profile/leader-photo-consent` | session | `{"granted":true}` → profil |

### Publications

| Méthode | Chemin | Auth | Corps / réponse |
| --- | --- | --- | --- |
| GET | `/posts` | session | → `200 {"posts":[…]}` (500 max) |
| POST | `/posts` | session | `{"content":"…","platforms":["LinkedIn"],"scheduledFor":"2026-10-01T14:30:00Z","contentCategory":"value"}` → `201` |
| PATCH | `/posts/:id` | session | `{"content":"…"}` ou `{"scheduled_for":"…Z"}` → post. `status` n'est **pas** modifiable ici. |
| DELETE | `/posts/:id` | session | → `204` |
| POST | `/posts/:id/validate` | session | — → post validé, budget de retry remis à zéro **par le serveur** |
| POST | `/posts/:id/publish` | session | — → `{"results":[…],"post":{…}}` |
| POST | `/posts/validate-by-token` | non (60/h par IP) | `{"token":"…"}` → `200 {"ok":true,"postId":"…"}` |
| POST | `/posts/generate-week` | session | — → `{"profileId","generated","skipped?"}` |
| GET | `/posts/statistics` | session | → totaux, série hebdomadaire, répartition par réseau |

### Générations

| Méthode | Chemin | Auth | Corps / réponse |
| --- | --- | --- | --- |
| POST | `/generations/text` | session (20/h) | `{"platforms":["LinkedIn"],"prompt":"…"}` → `{"content","postType","angle","fallback?","textLimit"}` |
| POST | `/generations/image` | session (30/h) | `{"postId":"…","platforms":["LinkedIn"]}` → `{"jobId","status":"processing"}` ou `{"jobId","status":"completed","url"}` |
| GET | `/generations/:id` | session | → même forme. **Relecture pure : ne relance jamais de génération payante.** |
| POST | `/generations/video` | session | → `503` explicite : non disponible |

### Médias

| Méthode | Chemin | Auth | Corps / réponse |
| --- | --- | --- | --- |
| GET | `/media` | session | `?kind=logo` → `{"media":[…]}` |
| POST | `/media` | session | `multipart/form-data`, un fichier, 5 Mo max, PNG/JPEG/WebP/GIF (**SVG refusé**) → `201` |
| GET | `/media/:id/file` | session | → le fichier, si et seulement si le compte le possède |
| GET | `/media/public/:token` | **jeton** | → le fichier. Sans session, par nécessité : le publieur doit récupérer l'affiche. |
| DELETE | `/media/:id` | session | → `204` |

### Réseaux sociaux et commentaires

| Méthode | Chemin | Auth | État |
| --- | --- | --- | --- |
| GET | `/social/accounts` | session | implémenté |
| POST | `/social/connect` | session | **non terminé** → `503` explicite (section 14) |
| DELETE | `/social/accounts/:id` | session | implémenté |
| GET | `/comments` | session | implémenté (lecture) |
| PATCH | `/comments/:id` | session | implémenté (statut) |
| POST | `/comments/sync` | session | **non terminé** → `503` |
| POST | `/comments/:id/draft` | session | **non terminé** → `503` |
| POST | `/comments/:id/reply` | session | **non terminé** → `503` |

### Compte, administration, exploitation

| Méthode | Chemin | Auth | Corps / réponse |
| --- | --- | --- | --- |
| GET | `/account/export` | session | → toutes les données du compte, **sans le hachage ni le sel** |
| DELETE | `/account` | session | `{"password":"…"}` → `204`. Irréversible ; mot de passe re-vérifié. |
| GET | `/admin/me` | session **admin** | → `{"user":{…}}`, sinon `403` |
| POST | `/admin/actions` | session **admin** | `{"action":"set_plan","userId":"…","plan":"pro"}`. Le `userId` désigne la **cible**, jamais l'appelant. |
| POST | `/contact` | non (5/h par IP) | `{"name","email","subject","message"}` → `{"ok":true}` |
| POST | `/cron/publish` | `x-cron-secret` | → `{"recovered","attempted","published"}` |
| POST | `/cron/weekly` | `x-cron-secret` | → `{"results":[…]}` |
| GET | `/health` | non | → `{"ok":true}` |

Un secret cron absent ou faux répond **404**, pas 401 : une route qui répond
« non autorisé » confirme son existence.

---

## 7. Schéma PostgreSQL

Dix tables, cinq fonctions. Chaque table utilisateur porte
`profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE` — c'est
la frontière de tenant, et c'est aussi ce qui rend la suppression de compte
complète sans une requête par table.

| Table | Colonnes | Rôle |
| --- | --- | --- |
| `profiles` | 39 | Compte + identifiants + réglages éditoriaux et de marque. Porte `password_hash`, `password_salt`, `role`, `plan`, `blocked_at`, `leader_photo_consent_at`. |
| `sessions` | 7 | Sessions actives. **`token_hash` seulement** — aucune colonne ne peut contenir le jeton en clair. |
| `one_time_tokens` | 8 | Réinitialisation de mot de passe et validation par lien. Haché, daté, à usage unique. |
| `posts` | 22 | Publications, leur état, leur programmation, leur budget de retry et leur affiche. |
| `media_assets` | 8 | Fichiers du volume local, plus le jeton de capacité (0002). |
| `generation_jobs` | 13 | Rendus d'affiches en cours ou terminés. |
| `generation_usage` | 5 | Réservations de quota — l'historique est conservé, pas effacé. |
| `social_connections` | 14 | Comptes sociaux connectés, dont `provider_profile_key` : la frontière de tenant côté fournisseur. |
| `social_comments` | 19 | Boîte de réception des commentaires. |
| `ip_rate_events` | 3 | Compteurs de limitation par IP. |

| Fonction | Rôle |
| --- | --- |
| `consume_generation_quota(profile, fn, max, window)` | Réserve une unité **sous `pg_advisory_xact_lock`**. Sans ce verrou, des requêtes parallèles lisent le même compte et passent toutes — la façon classique dont une « limite » n'en est pas une. |
| `release_generation_quota(profile, fn)` | Rend exactement une réservation. |
| `hit_ip_rate_limit(bucket, max, window)` | Même principe, par IP. |
| `recover_stuck_publishing()` | Débloque les publications interrompues. Un post qui **avait déjà atteint le fournisseur** (`provider_post_id IS NOT NULL`) passe à `published` plutôt que d'être remis en file : publier deux fois est pire que ne pas réessayer. |
| `touch_updated_at()` | Déclencheur `updated_at`. |

Contraintes qui portent une règle produit :

- `posts_platforms_known` — un post ne peut viser que les quatre réseaux
  réellement publiables. Un cinquième en base serait un post impubliable.
- `posts_attempts_nonneg` — le compteur de retry ne peut pas devenir négatif.
- `media_size_positive` — taille bornée, cohérente avec la limite d'upload.
- `profiles_poster_footer_len` — 120 caractères, comme le formulaire et comme
  le brief envoyé au moteur.
- `idx_media_assets_public_token` (unique, partiel) — deux comptes ne peuvent
  pas partager un jeton de capacité.
- `posts_due_idx` (partiel, sur `status`, `scheduled_for`,
  `next_publish_attempt_at`) — la file le parcourt à chaque tick ; sans le
  prédicat de report dans l'index, la sélection dégénère en parcours
  séquentiel de toute la table à mesure que les posts s'accumulent.

---

## 8. Migrations à appliquer

Deux fichiers, dans l'ordre, **tous deux idempotents** :

| Fichier | Contenu |
| --- | --- |
| `0001_core_schema.sql` | Schéma complet : extensions, tables, index, contraintes, fonctions, déclencheurs. |
| `0002_media_public_token.sql` | `media_assets.public_token` + son index unique partiel. |

```bash
cd /opt/pro-social-ai/server
npm ci
DATABASE_URL="postgres://…" npm run migrate
```

L'applicateur tient un registre `schema_migrations` et enveloppe chaque
fichier dans une transaction : un échec ne laisse jamais le schéma à moitié
modifié. L'idempotence est doublement assurée — le registre saute ce qui est
appliqué, et chaque fichier converge de toute façon (`CREATE … IF NOT EXISTS`,
`CREATE OR REPLACE`, `DO $$ … EXCEPTION WHEN duplicate_object`).

**Vérifié dans le bac à sable :** les deux fichiers ont été rejoués
intégralement trois fois de suite sur une base qui les portait déjà, sans une
seule erreur. La CI le revérifie à chaque exécution.

Aucune intervention manuelle n'est requise. Il n'y a **aucune** migration
Supabase et **aucune** Edge Function à déployer.

---

## 9. Noms des variables d'environnement

**Noms uniquement.** Aucune valeur ne figure dans ce dépôt, et aucune ne doit
y être écrite. Elles vivent dans `.env.selfhosted` sur le VPS.

### Requises — l'API refuse de démarrer sans elles

```
DATABASE_URL
SESSION_COOKIE_SECRET
```

### Requises en pratique

```
APP_PUBLIC_URL        liens des emails ; sans elle, publier un post dont
                      l'affiche est stockée localement échoue explicitement
MEDIA_ROOT            défaut /app/media
```

### Fournisseurs — chaque absence désactive une capacité, jamais silencieusement

```
OPENROUTER_API_KEY
OPENROUTER_TEXT_MODEL       ignorée si elle ne vaut pas anthropic/claude-*
GRAPHISTE_GPT_API_KEY       requiert aussi GRAPHISTE_GPT_API_URL
GRAPHISTE_GPT_API_URL       aucun défaut : sans elle, les affiches sont
                            désactivées (et non envoyées à un tiers)
ZERNIO_API_KEY
ZERNIO_API_URL
RESEND_API_KEY
RESEND_FROM
CONTACT_TO
```

### Exploitation

```
APP_NAME
CRON_SECRET                 uniquement si la file est pilotée de l'extérieur
PORT                        défaut 8080
HOST                        défaut 0.0.0.0
PG_POOL_MAX                 défaut 10
PUBLISH_TICK_SECONDS        défaut 60 ; 0 désactive le runner interne
WEEKLY_GENERATION           "off" désactive le runner hebdomadaire
NODE_ENV                    "production" active le cookie Secure
```

### Côté dashboard

**Aucune.** Le bundle ne contient aucun secret, aucune URL de fournisseur et
aucune variable de build. C'est vérifiable : `grep -rn "import.meta.env" src/`
ne renvoie rien.

`SESSION_COOKIE_SECRET` mérite un avertissement : la changer invalide toutes
les sessions **et** tous les liens de réinitialisation et de validation en
cours, puisqu'elle sert aussi à dériver le hachage des jetons à usage unique.

---

## 10. Commandes exactes

### Prérequis : Node >= 22.18

Le dépôt le déclare (`engines`) et l'impose (`engine-strict=true` dans
`.npmrc`), pour les deux paquets. Sur une version antérieure, `npm ci`
s'arrête avec `EBADENGINE` et affiche la version attendue et la version
installée.

C'est volontaire : la suite de tests importe directement des modules `.ts` et
s'appuie sur le retrait des types par Node, disponible à partir de 22.18. Sans
ce garde-fou, l'installation réussissait et l'échec n'apparaissait qu'au
premier test, sous la forme d'un `ERR_UNKNOWN_FILE_EXTENSION` qui ressemble à
un dépôt cassé plutôt qu'à une mauvaise version de Node.

```bash
node --version         # doit afficher v22.18 ou plus
nvm use                # .nvmrc est fourni à la racine et dans server/
```

### Le dashboard

```bash
cd /root/projects/auto-post-gen
npm ci
npm run lint
npm run typecheck
npm test
npm run build          # produit dist/
```

### L'API

```bash
cd /opt/pro-social-ai/server
npm ci
npm run typecheck
npm run migrate        # nécessite DATABASE_URL
npm test               # nécessite un vrai PostgreSQL
npm run build
npm start
```

### Sortie obtenue dans le bac à sable

```
npm run lint       0 erreur, 8 avertissements (shadcn/fast-refresh, préexistants)
npm run typecheck  0 erreur
npm test           164 tests, 164 réussis, 0 échec
npm run build      OK
server typecheck   0 erreur
server test        19 tests, 19 réussis, 0 échec (PostgreSQL 16 local)
git diff --check   propre

npm ci             réussit sur Node 22.22 (dashboard et API), depuis un clone neuf
npm ci             échoue en EBADENGINE quand la plage requise dépasse la version
                   installée — le garde-fou a été vérifié dans les deux sens
```

---

## 11. Procédure de déploiement prévue — **non exécutée**

Rien de ce qui suit n'a été lancé. À dérouler par l'ingénieur, **après** la
sauvegarde de la section 12.

```bash
# 0. Sauvegarder (section 12). Ne pas sauter cette étape.
#
#    Les commandes ci-dessous supposent que le service de l'API s'appelle
#    "api" dans docker-compose.yml. Ce nom n'a pas pu être vérifié depuis le
#    bac à sable : lisez /opt/pro-social-ai/docker-compose.yml d'abord.

# 1. Récupérer la branche
cd /opt/pro-social-ai
git fetch origin
git checkout claude/lucid-johnson-14zub1

# 2. Renseigner les variables de la section 9 dans .env.selfhosted
#    (jamais dans le dépôt, jamais dans un commit)
$EDITOR /opt/pro-social-ai/.env.selfhosted
chmod 600 /opt/pro-social-ai/.env.selfhosted

# 3. Appliquer les migrations, base à l'arrêt de l'ancienne API si elle tourne
cd /opt/pro-social-ai/server
npm ci
DATABASE_URL="…" npm run migrate
#    Sortie attendue : "applied 0001…", "applied 0002…"
#    ou "skip … (already applied)" sur une base déjà migrée.

# 4. Construire et démarrer l'API
cd /opt/pro-social-ai
docker compose build api
docker compose up -d api
docker compose logs -f api        # vérifier les capacités annoncées au démarrage

# 5. Vérifier l'API avant de toucher au frontend
curl -s http://127.0.0.1:8080/api/health
#    attendu : {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/profile
#    attendu : 401

# 6. Construire le dashboard
cd /root/projects/auto-post-gen
git checkout claude/lucid-johnson-14zub1
npm ci
npm run build

# 7. Basculer dist/ de façon atomique (et réversible)
mv /root/projects/auto-post-gen/dist /root/projects/auto-post-gen/dist.new
mv /root/projects/auto-post-gen/dist.current /root/projects/auto-post-gen/dist.previous
mv /root/projects/auto-post-gen/dist.new /root/projects/auto-post-gen/dist.current
ln -sfn /root/projects/auto-post-gen/dist.current /root/projects/auto-post-gen/dist

# 8. Recharger nginx (voir DEPLOYMENT.md pour la configuration attendue)
docker exec auto-post-gen-frontend nginx -t
docker exec auto-post-gen-frontend nginx -s reload

# 9. Vérifier de bout en bout, depuis l'extérieur
curl -s https://auto-post-gen.76.13.129.252.sslip.io/api/health
#    puis, dans un navigateur : créer un compte, faire l'onboarding,
#    générer un post, générer une affiche, programmer, publier.
```

Points de vigilance déjà payés une fois :

- **`index.html` ne doit jamais être mis en cache.** Sinon un navigateur garde
  l'ancien et demande des bundles supprimés : page blanche après déploiement.
- **`add_header` dans un `location` nginx remplace les en-têtes hérités** au
  lieu de s'y ajouter. Ajouter un en-tête de cache dans un `location` supprime
  donc CSP, HSTS et `X-Frame-Options` pour ces requêtes. Les directives
  `expires` n'ont pas ce défaut.
- **`APP_PUBLIC_URL` doit être l'URL publique exacte**, en `https`. Les
  affiches stockées localement sont remises au publieur sous cette base.

---

## 12. Sauvegarde avant déploiement

À faire **avant** l'étape 3 de la section 11. Les deux volumes se sauvegardent
**ensemble** : une base restaurée sans son volume média laisse des lignes
`media_assets` pointant vers des fichiers absents, et l'inverse laisse des
fichiers que plus rien ne référence.

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/var/backups/pro-social-ai/$STAMP
mkdir -p "$BACKUP"

# 1. Base — dump cohérent, format custom (restauration sélective possible).
#    Le nom de la base se lit dans DATABASE_URL ; il n'a pas pu être vérifié
#    depuis le bac à sable, d'où la variable plutôt qu'un nom en dur.
DB=pro_social_ai          # <- confirmer avec DATABASE_URL
docker exec pro-social-ai-postgres-1 \
  pg_dump -U postgres -Fc -d "$DB" > "$BACKUP/db.dump"

# 2. Volume média
docker run --rm \
  -v pro-social-ai_media:/data:ro \
  -v "$BACKUP":/backup \
  alpine tar czf /backup/media.tar.gz -C /data .

# 3. dist/ actuel du frontend, pour un retour arrière immédiat
tar czf "$BACKUP/dist.tar.gz" -C /root/projects/auto-post-gen dist.current

# 4. Le fichier de variables (contient des secrets : droits stricts)
cp /opt/pro-social-ai/.env.selfhosted "$BACKUP/env.selfhosted"
chmod 600 "$BACKUP/env.selfhosted"
chmod 700 "$BACKUP"

# 5. Vérifier que la sauvegarde est lisible — une sauvegarde non vérifiée
#    n'est pas une sauvegarde
pg_restore --list "$BACKUP/db.dump" | head
tar tzf "$BACKUP/media.tar.gz" | head
ls -l "$BACKUP"
```

Notez le SHA déployé précédemment, il sert au rollback :

```bash
git -C /opt/pro-social-ai rev-parse HEAD > "$BACKUP/previous-sha.txt"
git -C /root/projects/auto-post-gen rev-parse HEAD >> "$BACKUP/previous-sha.txt"
```

---

## 13. Rollback

### Le frontend seul (page blanche, erreur d'affichage) — quelques secondes

```bash
ln -sfn /root/projects/auto-post-gen/dist.previous /root/projects/auto-post-gen/dist
docker exec auto-post-gen-frontend nginx -s reload
```

### L'API seule (le schéma convient, le code ne va pas)

```bash
cd /opt/pro-social-ai
git checkout "$(cat /var/backups/pro-social-ai/<STAMP>/previous-sha.txt | head -1)"
docker compose build api && docker compose up -d api
docker compose logs -f api
```

Les deux migrations n'effacent ni ne renomment aucune colonne : elles créent
des tables, des index et une colonne nullable. **L'ancien code tourne donc sur
le nouveau schéma**, ce qui rend ce rollback-là sûr sans toucher à la base.

### Retour complet, base comprise — dernier recours, perte de données

À n'employer que si la base a été corrompue. Tout ce qui a été écrit depuis la
sauvegarde est perdu.

```bash
docker compose stop api
docker exec -i pro-social-ai-postgres-1 \
  pg_restore -U postgres -d "$DB" --clean --if-exists \
  < /var/backups/pro-social-ai/<STAMP>/db.dump

docker run --rm \
  -v pro-social-ai_media:/data \
  -v /var/backups/pro-social-ai/<STAMP>:/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/media.tar.gz -C /data"

cd /opt/pro-social-ai && git checkout <previous-sha>
docker compose build api && docker compose up -d api
ln -sfn /root/projects/auto-post-gen/dist.previous /root/projects/auto-post-gen/dist
docker exec auto-post-gen-frontend nginx -s reload
```

---

## 14. Limites connues et travail non terminé

### Routes délibérément non terminées

Chacune répond **503 avec un message explicite**, jamais un faux succès ni un
no-op silencieux.

| Route | Ce qui manque | Ce qu'il faut reprendre |
| --- | --- | --- |
| `POST /social/connect` | La poignée de main avec le fournisseur. | Elle exige le compte opérateur Zernio (création d'un profil par utilisateur, récupération de `provider_profile_key`). L'ancienne implémentation est dans l'historique git : `supabase/functions/zernio-connect/index.ts`. **Attention** : elle contenait un repli vers le profil par défaut de l'opérateur, qui laissait un utilisateur publier sur les comptes sociaux d'un autre. Ce repli a été supprimé et ne doit pas revenir — sans clé de profil, la publication est refusée. |
| `POST /comments/sync` | La récupération des commentaires. | `supabase/functions/sync-comments/index.ts` dans l'historique. Le passage de `profileId` y est **obligatoire** : sans lui l'API du fournisseur renvoie les commentaires de tous les profils. |
| `POST /comments/:id/draft` | La rédaction assistée. | `supabase/functions/comment-reply/index.ts`. `callClaude` de `services/text.ts` fournit déjà la chaîne. |
| `POST /comments/:id/reply` | L'envoi de la réponse. | Idem, plus l'appel d'envoi du fournisseur. |
| `POST /generations/video` | Tout. | N'a jamais existé. |

La lecture des commentaires (`GET /comments`, `PATCH /comments/:id`) fonctionne :
une boîte de réception alimentée à la main est utilisable, la synchronisation
ne l'est pas.

### Fonctionnalités retirées, à reprendre si elles sont voulues

| Fonctionnalité | État | Note |
| --- | --- | --- |
| Enrichissement par recherche web | **Retiré.** | Les générateurs citaient des faits issus de Google News RSS / Wikipedia / DuckDuckGo (`supabase/functions/_shared/research.ts`). Le prompt « recherche » interdit désormais explicitement d'inventer un chiffre, une date ou une étude, faute de source. `TAVILY_API_KEY` et `BRAVE_SEARCH_API_KEY` ont été retirées de la configuration plutôt que laissées comme des noms que rien ne lit. |
| Ayrshare, Postiz, OAuth direct (LinkedIn, Meta, X) | **Retirés.** | Quatorze Edge Functions. Zernio est le seul chemin de publication conservé. L'historique git contient les implémentations. |
| Email de rappel de validation | **Retiré.** | `send-validation-email` envoyait un lundi un rappel aux comptes ayant des posts `pending`. La colonne `validation_email_sent_at` existe toujours ; il manque le runner et le gabarit. |
| Export de configuration publique | **Retiré.** | Ne concernait que les clés publiques Supabase. |

### Limites structurelles

- **Les runners tournent dans le conteneur de l'API.** C'est volontaire pour
  un déploiement à un conteneur. Plusieurs répliques restent sûres (chaque
  post est réservé par un `UPDATE` conditionnel), mais si l'API est arrêtée,
  rien ne publie. Un hôte qui préfère son ordonnanceur peut basculer sur
  `POST /api/cron/*`.
- **La limitation par IP échoue ouvert.** Si la base refuse la requête de
  comptage, la requête utilisateur passe. Rendre le produit indisponible parce
  que le compteur est indisponible serait pire — mais c'est un choix, et il
  doit être connu.
- **Le ré-hébergement des affiches est « au mieux ».** Si la copie échoue,
  l'URL du fournisseur est conservée : moins durable, mais mieux que perdre un
  rendu déjà payé. Une affiche dont l'URL expire avant la copie est perdue.
- **Les jetons de capacité ne sont pas révoqués automatiquement.** Un jeton
  reste valide tant que la ligne existe. Le mettre à `NULL` le révoque.
- **`social_connections` stocke `access_token` et `refresh_token` en clair.**
  Aucune connexion ne les remplit aujourd'hui (la route est non terminée),
  mais la colonne existe : celui qui terminera `POST /social/connect` doit
  traiter le chiffrement au repos avant d'y écrire un vrai jeton.

### Défauts trouvés pendant la migration et corrigés

Documentés parce qu'ils étaient invisibles, et qu'un futur port pourrait les
réintroduire.

1. **L'analyse des cibles n'existait pas côté serveur.** Le dashboard appelait
   `POST /profile/audiences/detect` ; la route n'était pas implémentée.
   L'onboarding échouait à l'étape 3 pour tous les comptes.
2. **La file de publication n'avait aucun exécuteur.** Le cron Supabase avait
   disparu avec les Edge Functions et rien ne l'avait remplacé : un post
   programmé ne partait jamais.
3. **La génération hebdomadaire non plus.** `post_frequency`,
   `preferred_days`, `preferred_time` et les quotas promo/recherche étaient
   des réglages sans effet.
4. **Une affiche générée pouvait disparaître, et n'atteignait pas le
   publieur.** L'URL du moteur était stockée telle quelle alors qu'elle
   expire ; la publication ne reprenait pas une affiche encore en cours de
   rendu ; et une affiche ré-hébergée vit derrière une session que le
   fournisseur n'a pas. Les trois sont corrigés (copie locale, reprise du
   job avant publication, jeton de capacité).

5. **Deux dépendances Supabase fonctionnelles subsistaient hors de `src/`**
   — l'adresse par défaut du moteur d'affiches et l'autorisation `connect-src`
   du CSP nginx. Détail et preuves en section 5. Elles n'étaient pas visibles
   depuis le dashboard, ce qui est précisément pourquoi le contrôle CI porte
   désormais aussi sur `server/src/` et sur `nginx.vps.conf`.
6. **La version de Node exigée n'était déclarée nulle part.** La suite importe
   des modules `.ts` directement : en dessous de 22.18, l'installation
   réussissait et l'échec n'apparaissait qu'au premier test, sous une forme
   qui ressemblait à un dépôt cassé. `engines` + `engine-strict` le refusent
   maintenant à l'installation.

Deux durcissements ont également été ajoutés : les URL d'images fournies par
l'utilisateur sont validées avant d'être remises à un moteur externe (une
adresse interne y serait une sonde SSRF exécutée depuis le réseau du
fournisseur), et le jeton de capacité a reçu un index unique partiel, sans lequel deux
comptes auraient pu en partager un.

---

## 15. Vérifié / à vérifier / non vérifié

### Vérifié dans le bac à sable

Exécuté réellement, sortie constatée.

- `npm run lint` — 0 erreur, 8 avertissements préexistants.
- `npm run typecheck` — 0 erreur. `npm --prefix server run typecheck` — 0 erreur.
- `npm test` — **164 tests, 164 réussis**.
- `npm --prefix server test` — **19 tests, 19 réussis**, contre un PostgreSQL 16 réel.
- `npm run build` — réussi ; le bundle produit ne contient pas le mot « supabase ».
- Les deux migrations appliquées sur une base vierge, puis **rejouées deux
  fois de plus** intégralement, sans erreur. Et, cas qui compte vraiment pour
  votre base existante : la table de suivi vidée puis les deux migrations
  **ré-appliquées par-dessus un schéma déjà peuplé**, sans erreur, la suite
  serveur repassant à 19/19 ensuite.
- `npm ci` depuis un clone neuf, pour le dashboard et pour l'API. Le
  garde-fou Node vérifié dans les deux sens : réussite sur 22.22, échec
  `EBADENGINE` quand la plage exigée dépasse la version installée.
- `nginx -t` sur `nginx.vps.conf`, puis nginx réellement démarré : le CSP
  servi porte `connect-src 'self'`, et il survit sur `/index.html` à côté de
  `Cache-Control: no-cache` (le piège `add_header` en bloc `location`) ; un
  asset au nom haché reçoit bien `max-age=604800`.
- L'API démarrée et interrogée au curl :
  - `/api/health` → 200 ;
  - huit routes authentifiées sans cookie → **401** ;
  - `/api/cron/publish` sans secret **et** avec un mauvais secret → **404** ;
    avec le bon secret → 200 ;
  - inscription → 201 + cookie de session ;
  - `PATCH /profile` avec `{"plan":"enterprise","role":"super_admin"}` → le
    plan reste `starter`, le rôle n'est pas modifiable ; `/admin/me` → **403** ;
  - `logo_url` en `169.254.169.254` → refusé ; en `http://` → refusé ;
    en `https://` public → accepté ;
  - `scheduledFor` sans fuseau horaire → refusé ; réseau inconnu → refusé ;
  - un post d'un compte A demandé par un compte B → **404** en modification
    comme en suppression, et le post de A reste intact ;
  - la file de publication : ignore un post dans sa fenêtre de report, le
    tente une fois sortie, incrémente le compteur et le reporte à nouveau ;
  - une demande d'affiche avec `GRAPHISTE_GPT_API_KEY` renseignée mais
    `GRAPHISTE_GPT_API_URL` absente → **503** nommant la variable, **aucun
    appel sortant**, et `generation_usage` vide : le refus ne consomme pas le
    quota horaire du compte.
- Les preuves d'absence de Supabase de la section 5.

### À vérifier sur le VPS

Ne peut pas l'être ici, et doit l'être avant d'ouvrir aux utilisateurs.

- L'application des migrations sur la **vraie** base, avec ses données.
- Le démarrage de l'API dans `pro-social-ai-api-1`, avec les vrais secrets, et
  les capacités annoncées dans les logs.
- Le montage du volume `pro-social-ai_media` sur `/app/media`, et les droits
  d'écriture du processus.
- nginx : le proxy `/api`, l'absence de cache sur `index.html`, la présence
  effective de CSP/HSTS/`X-Frame-Options` sur toutes les réponses.
- Le cookie de session en `Secure` derrière le vrai TLS.
- Un parcours complet dans un navigateur : inscription, onboarding, analyse
  des cibles, génération de texte, génération d'affiche, programmation,
  publication, statistiques.
- La sauvegarde et sa **restauration effective** sur un environnement de test.

### Non vérifié

Aucune vérification n'a été faite, ni ici ni ailleurs.

- **Tout appel réel à un fournisseur** : OpenRouter, Graphiste GPT et Zernio
  n'ont jamais été appelés. Le bac à sable n'a aucune clé. Le format des
  réponses est traité d'après la documentation et l'implémentation précédente.
  La génération de texte, la génération d'affiches et la publication sont donc
  **non vérifiées de bout en bout**.
- L'envoi d'emails par Resend.
- Le comportement sous charge : dimensionnement du pool, contention des
  verrous consultatifs, débit de la file.
- La qualité éditoriale des textes produits par les prompts portés.
- Le rendu du dashboard sur le vrai domaine, derrière le vrai TLS.
- Toute mesure de performance.

**Aucun déploiement n'a été effectué et aucun test de production n'a été
passé.** Ce document décrit ce qui a été construit et vérifié en bac à sable,
et ce qu'il reste à vérifier là où cela compte.
