# HERMES_VPS_RELEASE — release runbook

> **Ce document est le plan de déploiement de CETTE livraison.**
> Il complète [`VPS_DEPLOYMENT_HANDOFF.md`](./VPS_DEPLOYMENT_HANDOFF.md) (le
> dossier complet de la migration vers l'auto-hébergement) : lisez celui-ci
> pour DÉPLOYER, celui-là pour COMPRENDRE la pile.
>
> **Aucun déploiement VPS n'a été exécuté pour préparer cette livraison.**
> Rien n'a été installé, construit ni migré sur le serveur ; aucune base
> réelle n'a été touchée ; aucun secret n'a été lu, écrit ou demandé. Tout ce
> qui suit a été validé en local, sur des bases PostgreSQL jetables.

---

## 0000. Audit de pré-production (corrections uniquement)

Branche `claude/poster-character-audit-h7n3`, créée depuis
`claude/poster-character-q2w6` @ `bfce311933fc72146c426bc6a17c06ce28481f1a`
(personnage sur les affiches, §000, inclus). Relecture complète de l'API, du
dashboard et du déploiement ; **aucune fonctionnalité nouvelle**, seulement
des défauts corrigés, chacun couvert par un test.

### Ce que le déploiement doit savoir

| | |
|---|---|
| **Migration** | `0007_publish_recovery_bounded.sql` — un seul `CREATE OR REPLACE FUNCTION recover_stuck_publishing()`. Aucune table touchée, aucune ligne réécrite par la migration. 8 migrations au total. |
| **Variables** | aucune nouvelle. `APP_PUBLIC_URL` (déjà obligatoire dans le Compose) sert désormais aussi à transmettre le logo à Graphiste. |
| **nginx / Compose / Dockerfile** | inchangés depuis §000. |
| **Retour arrière** | revenir à l'image précédente suffit ; la fonction de 0007 reste compatible avec l'ancien code. |

### Défauts corrigés

**Argent et publication**

| Défaut | Effet | Correction |
|---|---|---|
| Un post accepté par Zernio mais **mis en file** (`queued`) repassait en `validated` | **publié deux fois** sur le réseau au passage suivant | il reste « Publication en cours » avec l'identifiant Zernio enregistré ; la reprise le passe « publié » après 10 min, jamais en nouvelle tentative |
| L'identifiant du post chez Zernio n'était jamais enregistré | la reprise après crash ne pouvait pas savoir qu'un post était déjà parti | `provider_post_id` enregistré |
| « Valider » acceptait un post en cours d'envoi ou déjà publié | le remettait en file → double publication (le bouton apparaissait sur un post `publishing`, affiché « En attente ») | refus `409` hors `pending`/`validated`/`failed` ; statut « Publication en cours » affiché |
| La reprise ne passait jamais un post en échec | un post qui bloque l'envoi était relancé toutes les 15 min, **indéfiniment** | 0007 : échec au bout de 5 tentatives, comme l'API |
| Image non partageable (sans `APP_PUBLIC_URL`) : exception après la réservation du post | post bloqué en `publishing`, puis boucle ci-dessus | tentative enregistrée en échec, avec un message qui nomme la variable |
| La génération hebdomadaire et « générer la semaine » **ne décomptaient rien** | textes et affiches premium hors plafond mensuel ; supprimer la semaine puis la regénérer = rendus payants **sans limite** | chaque texte et chaque affiche automatique est compté dans le plafond du forfait ; au-delà, arrêt (`plan_limit_reached`) ; « générer la semaine » limité à 6/h |
| Analyse IA des cibles possible pour un compte expiré | contraire à l'invariant n°1 | refusée (`402`) comme toute génération |
| Texte IA : jusqu'à 3 modèles × 90 s | le navigateur et nginx abandonnent à 120 s ; l'utilisateur relance et paie deux fois | budget total de 100 s pour toute la chaîne |

**Sécurité**

| Défaut | Correction |
|---|---|
| L'URL de statut d'un rendu, lue dans la réponse du fournisseur, était interrogée **avec la clé API Graphiste**, quel que soit son hôte | uniquement sur l'origine de `GRAPHISTE_GPT_API_URL` (vérifié à l'enregistrement et avant chaque lecture, lignes anciennes comprises) |
| Récupération des affiches : redirections suivies sans contrôle, noms DNS jamais vérifiés | chaque redirection revalidée ; le résolveur du socket refuse toute adresse non publique (IPv4/IPv6, IPv4 mappée, CGNAT, métadonnées cloud), y compris un nom qui change d'adresse entre-temps |
| `asImageUrl` laissait passer `[::ffff:127.0.0.1]`, `100.64.x.x`, `fd00::`, `*.internal` | refusés |
| Réinitialisation du mot de passe : l'email était attendu avant de répondre | la durée de la réponse révélait si l'adresse a un compte ; l'email part sans être attendu |

**Comptes et exploitation**

| Défaut | Correction |
|---|---|
| Limite de connexion de 20 essais par IP | les opérateurs mobiles mettent des milliers d'abonnés derrière une IP : quelques erreurs de mot de passe bloquaient tout le monde. Désormais 10 essais par adresse email et par IP, 300 par IP |
| Deux inscriptions simultanées (double clic) → `500` | `409` « Un compte existe déjà » (inscription et création par l'admin) |
| Sessions expirées, événements de limite et jetons jamais purgés | tables en croissance infinie ; purge quotidienne |
| Deux passages de la file de publication pouvaient se chevaucher | un seul à la fois |

**Affiches et contenu**

| Défaut | Correction |
|---|---|
| Le logo était envoyé à Graphiste en chemin relatif (`/api/media/…`) | **le logo n'apparaissait sur aucune affiche** ; il part désormais en lien signé que Graphiste peut télécharger |
| Affiche renvoyée en `data:image/…;base64` | stockée comme fichier, au lieu d'enregistrer toute l'URI comme adresse de l'image |
| Secteur, ton, types de contenu envoyés en codes anglais (« Secteur : food », « Ton : casual ») | traduits en français dans toutes les consignes (texte, semaine, cibles, affiches) |
| Image personnalisée supprimée mais encore dans la liste enregistrée | la génération hebdomadaire pouvait l'attacher à un post (image cassée) ; liste enregistrée immédiatement, images disparues ignorées |
| Texte régénéré : catégorie éditoriale non mise à jour | quotas promo/recherche et affiche suivante calculés sur l'ancienne |

**Dashboard**

| Défaut | Correction |
|---|---|
| Date d'un post calculée en UTC, heure en local | en UTC+1 (Bénin, Cameroun, Nigeria…), un post à 00 h 30 s'affichait la veille, et **« Enregistrer » sans rien changer le décalait d'un jour** |
| Lecture du profil en échec (502 pendant un redéploiement) | un compte configuré était envoyé à l'onboarding, où enregistrer écrase le profil ; maintenant message + « Réessayer » |
| Session expirée au même moment | « Chargement… » infini ; maintenant retour à la connexion |
| Après connexion, toujours le tableau de bord | retour à la page demandée (ex. lien « Renouveler » d'un email vers `/abonnement`) |
| Analyse des cibles depuis le Profil : lisait le profil **enregistré** | une description modifiée mais non enregistrée était ignorée ; elle est enregistrée d'abord |
| Image d'un post en erreur puis régénérée | restait « Image indisponible » jusqu'au rechargement |
| Export des données (Firefox, Safari) | le téléchargement pouvait ne pas démarrer |
| Calendrier, statistiques, profil : messages d'erreur génériques | message réel du serveur (invariant n°6) |

---

## 000. Personnage sur les affiches + passe de corrections

Branche `claude/poster-character-q2w6`, créée depuis
`claude/selfhosted-provider-compat-r5k8` @ `1218ee09feac7d69be203e0a7da1a3bc81b7e67b`
(le correctif `provider` + référence unique, §00, est donc inclus).

### La fonctionnalité

Dans **Profil → onglet Images**, carte « Personnage sur vos affiches » :
l'utilisateur envoie la photo d'une personne (lui-même, un membre de
l'équipe…) ou d'une mascotte. Le serveur **la détoure une fois** à l'envoi et
la **pose sur chaque affiche générée**, du côté choisi (gauche/droite), debout
sur le bord bas, à côté du contenu de l'affiche.

- **La photo ne quitte jamais le serveur.** Graphiste GPT reçoit seulement
  une consigne de mise en page (garder libre le côté du personnage, déplacer
  accroche, message permanent et signature de l'autre côté). Le personnage
  est composité localement sur le rendu fini (`sharp`). Un visage généré par
  IA ne serait jamais fidèle ; le composite l'est, et ne coûte rien de plus.
- **Détourage** : modèle `silueta` (U²-Net, Apache-2.0, 44 Mo, via le projet
  rembg, MIT) exécuté par `onnxruntime-web` (WASM, compatible Alpine/musl)
  dans un *worker thread* éphémère : l'API ne se bloque pas, la mémoire est
  rendue après chaque détourage. Environ 5 s par photo, 1 à la fois (file).
  Un PNG **déjà détouré** est gardé tel quel ; une image sans sujet net est
  refusée avec une explication.
- **Droit à l'image** : l'envoi exige de cocher « Je confirme avoir le droit
  d'utiliser l'image de cette personne » ; la date est enregistrée
  (`poster_character_rights_at`). Sans la case, l'API répond `400 rights_required`.
- **Cohérence** : chaque tâche de rendu enregistre le personnage avec
  lequel elle a démarré (`generation_jobs.character_overlay`) ; un rendu
  terminé minutes plus tard est fini comme il a été commencé, même si le
  réglage a changé entre-temps. Un personnage supprimé entre-temps ne fait
  jamais perdre l'affiche payée : elle est gardée sans lui.
- Le chemin manuel (tableau de bord) et le chemin hebdomadaire passent par
  la même fonction : aucun des deux ne peut l'oublier.
- Limites : 12 Mo par photo (JPEG, PNG, WebP), 10 envois par heure et par compte.

### Ce que le déploiement doit savoir

| | |
|---|---|
| **Migration** | `0006_poster_character.sql` — additive et idempotente : 4 colonnes sur `profiles` (défauts : désactivé, `right`), 1 colonne `jsonb` nullable sur `generation_jobs`, 1 clé étrangère `ON DELETE SET NULL`, 1 `CHECK`. Aucun `DROP`, aucune réécriture de ligne existante. La contrainte des types de média n'est **pas** reconstruite (l'image est rangée en `other`) : les valeurs héritées fusionnées par 0000 ne sont pas touchées. |
| **Image Docker** | l'étape de build **télécharge** le modèle (`server/scripts/fetch-bg-model.mjs`) depuis `github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx` et vérifie son **SHA-256 épinglé** (`75da6c8d…ffeedb`) : fichier altéré = build en échec. **Le build a donc besoin d'un accès HTTPS sortant vers github.com.** Le modèle n'est pas dans git. |
| **Variable** | `BG_REMOVAL_MODEL_PATH` — optionnelle ; par défaut `/app/models/silueta.onnx` dans l'image. Sans modèle, l'API démarre quand même, l'annonce (`capability unavailable: background-removal model …`) et n'accepte que des PNG déjà détourés (503 explicite sinon). |
| **Mémoire** | pic d'environ 400 à 700 Mo pendant un détourage (quelques secondes), rendu ensuite. |
| **nginx** | nouveau bloc `location = /api/profile/poster-character` : `client_max_body_size 13m`, `proxy_read_timeout 180s`. Le bloc `/api/` garde 6 Mo. **Le fichier `nginx.vps.conf` doit être redéployé** (il est monté par le Compose). |
| **Retour arrière** | l'image précédente ignore les colonnes ajoutées par 0006 : revenir à l'image suffit, la migration n'a pas à être annulée. |
| **Routes** | `POST /api/profile/poster-character` (multipart : `rights_confirmed=true` + `file`) → `201 {profile, character}` ; `DELETE /api/profile/poster-character` → `200 {profile}` ; `PATCH /api/profile` accepte `poster_character_enabled` (booléen) et `poster_character_position` (`left`/`right`). |

### Défauts trouvés et corrigés pendant la passe

| Défaut | Effet pour l'utilisateur | Correction |
|---|---|---|
| Consigne d'affiche tronquée **à la fin** à 1 800 caractères | avec un post ou une description longs, la position de la signature et les interdictions (fausses lettres, watermark) disparaissaient en silence | seules les lignes du message source sont raccourcies (« … ») ; toutes les consignes restent entières |
| `"$&"`, `"$'"`… dans un post | recopiés comme motifs de remplacement dans la consigne envoyée | remplacement par fonction |
| Réhébergement d'affiche plafonné à 5 Mo | une affiche PNG 2K dépassait la limite : on gardait l'URL du fournisseur, qui **expire** — l'affiche disparaissait des posts programmés | plafond propre aux rendus : 25 Mo |
| Deux lectures simultanées d'un même rendu (2 onglets, ou l'onglet + la publication) | le rendu était finalisé deux fois ; une copie orpheline restait sur le disque | finalisation conditionnelle (`AND status = 'processing'`) ; le perdant supprime sa copie et renvoie celle du gagnant (test : échoue sans le correctif) |
| Aucune barrière d'erreur dans le dashboard | après un redéploiement, un onglet resté ouvert demandant un module qui n'existe plus → **page blanche** | `AppErrorBoundary` : recharge automatiquement une fois (au plus une par minute), sinon message « Une nouvelle version est disponible » + bouton ; se réinitialise au changement de page |
| Page d'erreur HTML de nginx (413, 502, 504 ; ~180 caractères) | affichée **telle quelle** (balises comprises) dans le message d'erreur | le texte brut n'est repris que s'il n'est pas du balisage ; messages français pour 502/503/504 |
| Limite de débit répondue avant la lecture d'un gros envoi | derrière nginx, la connexion est coupée : l'utilisateur voit « 502 Bad Gateway » au lieu du message | la limite est vérifiée une fois le corps lu (vérifié derrière un vrai nginx) |

---

## 00. Correctif : `generation_jobs.provider` et référence Mobile Money unique

Correctif de `claude/selfhosted-subscriptions-release-q7t4` après la
répétition de Hermes sur une **copie restaurée** de la production, qui
échouait au dry-run :

```text
Legacy compatibility: the migrated schema still rejects a normal write from the API.
null value in column "provider" of relation "generation_jobs" violates not-null constraint
(SQLSTATE 23502)
```

**La contrainte réelle.** En production :

```text
generation_jobs
- id uuid NOT NULL DEFAULT gen_random_uuid()
- profile_id uuid NOT NULL
- provider text NOT NULL          ← la contrainte en cause
- kind text NOT NULL
- status text NOT NULL DEFAULT 'queued'
- input jsonb NOT NULL DEFAULT '{}'
- output jsonb NULL
- error_message text NULL
- created_at timestamptz NOT NULL DEFAULT now()
- finished_at timestamptz NULL
```

**La cause.** La sonde d'écriture de `0000` insérait un job
`(profile_id, kind, status)` — sans `provider`. L'API, elle, n'écrit
**jamais** de job sans fournisseur : `recordJob()`
(`server/src/services/generation.ts`) écrit toujours `provider = 'graphiste'`
(Graphiste GPT est le seul moteur d'affiches). C'était donc la **sonde** qui
n'était pas fidèle, pas le schéma qui était incompatible.

**Le correctif.**

1. La sonde reproduit désormais **exactement** les écritures de l'API, chaque
   instruction citant sa source : l'`INSERT` complet d'un job avec
   `provider = 'graphiste'`, ses deux clôtures (`completed`, `failed`), le
   reflet du job sur le post, l'`INSERT` des posts avec toutes ses colonnes,
   et les deux genres de médias (`other`, `poster`).
2. **`provider` reste obligatoire.** Rien n'est relâché : la valeur correcte
   pour un job créé par l'API est `'graphiste'`. Pour que la règle soit la
   même partout, `0004_generation_job_provider.sql` la rend aussi obligatoire
   sur une base neuve (où `0001` la créait nullable) ; en production, où elle
   l'est déjà, `0004` ne fait rien (`[0004] generation_jobs.provider is
   already NOT NULL.`). Des jobs historiques sans fournisseur, s'il en
   existait ailleurs, seraient conservés tels quels (aucun fournisseur
   inventé) et une contrainte `NOT VALID` refuserait les nouveaux.
3. Tous les jobs existants sont conservés à l'identique (vérifié champ par
   champ par un test).

**Référence Mobile Money : règle définitive.**

> Une même référence Mobile Money ne sert **jamais** deux fois.

- Refusée quel que soit le statut de la première déclaration : en attente,
  validée, **refusée** ou **annulée**. Une référence n'est jamais libérée.
- Comparée sous une forme canonique : **espaces supprimés** (avant, après et
  à l'intérieur), **majuscules**. `" mp2309.01 "`, `"MP 2309.01"` et
  `"MP2309.01"` sont la même référence, stockée `MP2309.01`.
- Globale, tous moyens de paiement confondus : la même transaction ne peut
  pas être redéclarée sous un autre canal.
- Après une erreur de saisie : l'opérateur **refuse avec un motif**, puis le
  client soumet une **nouvelle** référence.
- Appliquée par la base (`0005_payment_reference_once.sql`, index unique sur
  la forme canonique) pour tout écrivain, et par l'API
  (`canonicalReference`). Si des doublons existaient déjà, `0005`
  s'arrêterait en les nommant plutôt que d'en supprimer un.

**Preuve à exécuter par Hermes sur la copie de production** (lecture seule
pour la base : le dry-run annule tout) :

```bash
cd server
npm ci --include=dev
DATABASE_URL="postgres://…/psa_rehearsal" npm run migrate:dry-run
```

Attendu :

```text
would apply  0000_legacy_production_compat.sql
  …
  [NOTICE] [0000] write probe passed.
would apply  0001_core_schema.sql
would apply  0002_media_public_token.sql
would apply  0003_trial_and_subscriptions.sql
would apply  0004_generation_job_provider.sql
  [NOTICE] [0004] generation_jobs.provider is already NOT NULL.
would apply  0005_payment_reference_once.sql

DRY RUN OK — 6 migration(s) would apply cleanly.
Rolled back: the database is unchanged.
```

Puis, sur la même copie, pour vérifier que rien n'a bougé :

```sql
SELECT to_regclass('public.schema_migrations');               -- NULL : pas même une table de registre vide
SELECT is_nullable FROM information_schema.columns
 WHERE table_name = 'generation_jobs' AND column_name = 'provider';   -- NO
SELECT count(*) FROM generation_jobs;                         -- identique à avant
```

**Et un défaut de la répétition elle-même.** `--dry-run` créait la table de
registre `schema_migrations` (vide) **hors** de la transaction annulée : une
répétition sur la copie laissait donc une table de plus derrière elle, alors
qu'elle annonçait `the database is unchanged`. Le registre est désormais créé
dans la transaction annulée : après un dry-run, le schéma est identique
colonne pour colonne (vérifié par test).

**Fichiers de ce correctif** : `server/src/migrate.ts` (dry-run sans effet de
bord), `server/migrations/0000_legacy_production_compat.sql` (sonde), `server/migrations/0003_trial_and_subscriptions.sql` (commentaire
seulement), `server/migrations/0004_generation_job_provider.sql` (nouveau),
`server/migrations/0005_payment_reference_once.sql` (nouveau),
`server/src/services/subscriptions.ts`, `src/pages/Subscription.tsx`,
`server/tests/fixtures/legacy_production_schema.sql`,
`server/tests/legacy-migration.test.ts`, `server/tests/subscriptions.test.ts`,
`tests/subscription.test.js`, `HERMES_VPS_RELEASE.md`,
`VPS_DEPLOYMENT_HANDOFF.md`.

---

## 0. Livraison précédente (incluse) : essai gratuit, abonnements, forfaits appliqués

Construite **au-dessus** de `claude/legacy-status-compat-9m2x` (tout ce qui
suit en §2–§3 reste inclus et valable). Elle intègre sur la pile
auto-hébergée les fonctionnalités de `claude/magical-thompson-mjuif9` qui
ont un sens ici — réécrites pour l'API Fastify et PostgreSQL, **sans aucune
dépendance Supabase**.

**Ce qui change pour les utilisateurs**

- **Essai gratuit de 7 jours** du forfait choisi sur la page tarifs
  (`/auth?plan=starter|pro|enterprise`, Pro par défaut), sans carte.
- **Forfaits réellement appliqués par l'API** (ils ne l'étaient pas du tout) :
  volume hebdomadaire (3 / 7 / 10), plafonds mensuels IA (60 / 150 / 300
  textes et affiches), réponses automatiques réservées à Enterprise. La
  promotion ne peut plus occuper toute la semaine.
- **À l'expiration** (essai ou période payée) : la génération s'arrête
  (402 `subscription_expired`), **les posts déjà programmés sont publiés**.
- **Paiement Mobile Money** sur `/abonnement` : le client paie (Wave, Orange
  Money, MTN, Moov) et déclare la référence ; l'opérateur est prévenu par
  email et **valide dans `/admin`** ; le client reçoit la confirmation. Le
  montant est calculé par le serveur ; une déclaration n'accorde rien.
- **Rappel par email** 2 jours avant la fin d'essai et 3 jours avant
  l'échéance (runner interne quotidien, ou `POST /api/cron/subscription-reminders`).
- **Console `/admin` réparée** : elle plantait au premier affichage (forme de
  données différente de ce que renvoyait l'API) et trois de ses boutons
  appelaient des actions inexistantes (`create_user`, `reset_password`,
  `delete_user`) — elles existent désormais, avec leurs protections.
- Pages publiques corrigées : plus de promesse de « recherche web »,
  d'« email de validation », de paiement par carte, d'options à la carte, ni
  de « 10 h gagnées » ; dates de révision réelles sur les CGU et la politique
  de confidentialité, qui décrivent maintenant l'essai et le paiement.

**Ce qui n'a PAS été porté, et pourquoi** : tout ce qui, dans
`magical-thompson`, visait des Edge Functions Supabase absentes de cette pile
(diagnostic `/admin` et alertes `health-alert`, fuite de clé Graphiste dans
une Edge Function, runner de migrations Supabase, emails de validation
hebdomadaires, changement d'email). Voir §9.

**Fichiers de cette livraison**

| Fichier | Nature |
|---|---|
| `server/migrations/0003_trial_and_subscriptions.sql` | **nouveau** — colonnes de cycle de vie sur `profiles`, rattrapage des comptes existants (actifs, sans échéance), table `subscription_requests` + index uniques. Idempotent, n'ajoute que. |
| `server/src/shared/plans.ts` · `src/lib/plans.ts` | **nouveaux**, identiques octet pour octet — limites, prix, `resolveEntitlement` |
| `server/src/services/entitlement.ts` | **nouveau** — droit lu en base, garde 402, usage mensuel |
| `server/src/services/subscriptions.ts` | **nouveau** — déclaration, validation atomique, forfait manuel, prolongation, rappels |
| `server/src/routes/billing.ts` | **nouveau** — `GET /subscription`, déclaration, annulation |
| `server/src/lib/html.ts` | **nouveau** — échappement et gabarit des emails |
| `server/src/routes/generations.ts` | garde d'abonnement + plafonds mensuels du forfait |
| `server/src/services/weekly.ts` | comptes expirés ignorés, volume borné par le forfait, promotion bornée |
| `server/src/routes/profile.ts` | réponses auto selon le droit ; colonnes d'abonnement en lecture seule |
| `server/src/routes/auth.ts` | l'inscription démarre l'essai du forfait demandé |
| `server/src/routes/misc.ts` | console admin (forme corrigée, actions manquantes, paiements), export RGPD, cron des rappels |
| `server/src/services/scheduler.ts` · `server/src/index.ts` · `server/src/lib/env.ts` | rappels quotidiens, routes, variables `PAYMENT_*` |
| `server/tests/subscriptions.test.ts` · `server/tests/admin.test.ts` | **nouveaux** — 17 cas sur les vraies routes et un vrai PostgreSQL |
| `server/tests/legacy-migration.test.ts` | +1 cas : 0003 sur le schéma hérité (dry-run puis réel, rejeu) |
| `src/pages/Subscription.tsx` · `src/components/SubscriptionBanner.tsx` · `src/lib/legal.ts` | **nouveaux** |
| `src/pages/*` , `src/components/*`, `src/lib/api.ts`, `src/lib/session.tsx` | intégration UI, textes publics |
| `tests/subscription.test.js` | **nouveau** — 18 cas (politique exécutée + invariants) |
| `deploy/docker-compose.vps.yml` · `.env.selfhosted.example` | variables `PAYMENT_*` transmises à l'API |

---

## 1. Ce qu'il faut déployer

| | |
|---|---|
| **Branche** | `claude/poster-character-audit-h7n3` |
| **SHA du code** | `__CODE_SHA__` |
| **SHA à déployer** | la pointe de la branche (ce document est le seul commit au-dessus du code ; `git log -1 --format=%H`) |
| **Base** | `claude/poster-character-q2w6` @ `bfce311933fc72146c426bc6a17c06ce28481f1a` (personnage sur les affiches, §000) |
| **Base de la base** | `claude/selfhosted-provider-compat-r5k8` @ `1218ee09feac7d69be203e0a7da1a3bc81b7e67b` (correctif `provider` + référence unique, §00) |
| **Base précédente** | `claude/selfhosted-subscriptions-release-q7t4` @ `41d70d40b77ed561fa5fd96f4175d0d05e34bcb4` (bloquée par la répétition : `generation_jobs.provider`) |
| **Base de la base** | `claude/legacy-status-compat-9m2x` @ `783938efbf206055bf6cf67d6a684ef11656fc94` |
| **Fonctionnalités intégrées depuis** | `claude/magical-thompson-mjuif9` @ `66416276127588bdb50f179b6e6566ddb50cb663` |
| **`main`** | non modifié, non poussé, non fusionné |

```bash
git fetch origin
# ce qu'apporte cette livraison (audit de pré-production)
git diff --stat origin/claude/poster-character-q2w6..origin/claude/poster-character-audit-h7n3
# tout ce qui s'ajoute à la livraison auto-hébergée précédente
git diff --stat origin/claude/legacy-status-compat-9m2x..origin/claude/poster-character-audit-h7n3
```

---

## 2. Les blocages traités (livraison précédente, inclus)

Sur une **copie isolée** de la base de production, la migration échouait :

```
FAILED 0001_core_schema.sql: column "email" does not exist
```

**Cause.** `0001_core_schema.sql` est idempotent pour les objets qu'il crée,
mais `CREATE TABLE IF NOT EXISTS` est tout-ou-rien **au niveau de la table** :
la table `profiles` existe déjà en production avec un schéma ANCIEN (les
comptes vivent dans une table `users` séparée). Le `CREATE` est donc ignoré,
personne n'ajoute les colonnes manquantes, et l'instruction suivante —
l'index unique sur `profiles(email)` — s'arrête net.

Un correctif numéroté APRÈS 0001 n'aurait jamais pu s'exécuter, puisque 0001
échoue avant. D'où `0000_legacy_production_compat.sql`, qui passe en premier.

**Troisième blocage — trouvé par VOTRE répétition générale sur copie réelle.**
La vraie base porte sa propre contrainte :

```sql
posts_status_check CHECK (status IN ('draft', 'scheduled', 'published', 'failed'))
```

Le nouveau moteur écrit `pending` (post créé), `validated` (approuvé par
l'utilisateur ou par le lien email), `publishing` (pris par la file),
`published`, `failed`. Trois de ces cinq valeurs sont absentes de la liste
héritée, donc le premier post créé par l'API était rejeté :

```text
new row for relation "posts" violates check constraint "posts_status_check"
(SQLSTATE 23514)
```

**Correctif : une UNION, jamais une suppression.** La contrainte est reconstruite
sous le même nom avec `valeurs héritées ∪ valeurs présentes dans les données ∪
valeurs écrites par ce build`, à l'intérieur de la transaction unique de la
migration — aucune session ne voit jamais la table sans contrainte. Après
migration :

```sql
posts_status_check CHECK (status IS NULL OR status = ANY
  ('{pending,validated,publishing,published,failed,draft,scheduled}'))
```

Aucune ligne existante n'est invalidée, aucun statut n'est réécrit, et la colonne
reste strictement validée : `UPDATE posts SET status='n-importe-quoi'` est
toujours refusé. Le traitement est **générique** (toutes les colonnes de type
énumération : `posts.content_category`, `posts.image_status`, `profiles.role`,
`media_assets.kind`, `generation_jobs.kind/status`), parce que le même écart
peut exister ailleurs et qu'il ne s'agit pas de rustiner une erreur.

**Et une conséquence que la sonde ne voyait pas encore.** 0001 ajoute ses
propres contraintes (`posts_content_len`, `posts_platforms_known`, …) en les
validant sur les lignes existantes : un vieux post de plus de 10 000 caractères
ou une plateforme inconnue aurait fait échouer 0001 **après** que 0000 ait
réussi. Ces contraintes sont donc créées par 0000, en amont : validées si les
données s'y conforment, sinon `NOT VALID` — **les lignes historiques sont
conservées** et la règle s'applique à partir de maintenant. Le rapport le dit
ligne par ligne.

**Second blocage, trouvé en testant (il n'était pas encore apparu).** Une fois
le schéma migré, l'API ne pouvait toujours pas créer un compte : la colonne
héritée `profiles.user_id` est `NOT NULL` et le nouveau code ne l'écrit jamais
→ `null value in column "user_id" violates not-null constraint` à la première
inscription. La migration relâche donc ces contraintes héritées (**la colonne
et ses données sont conservées**) et vérifie le résultat par une sonde
d'écriture.

---

## 3. Fichiers modifiés par la livraison précédente (inclus)

| Fichier | Nature |
|---|---|
| `server/migrations/0000_legacy_production_compat.sql` | **nouveau** — migration de compatibilité (préflight, mise en forme, identité, tenancy, contraintes, sonde d'écriture, rapport) |
| `server/src/migrate.ts` | affiche les `NOTICE`/`WARNING` de PostgreSQL (la comptabilité `IF EXISTS` est masquée et comptée, jamais un WARNING) ; ajoute `--dry-run` (répétition générale annulée par `ROLLBACK`) |
| `server/package.json` | script `migrate:dry-run` |
| `server/scripts/inspect-legacy-schema.sql` | **nouveau** — inspection **en lecture seule** du schéma réel |
| `server/tests/fixtures/legacy_production_schema.sql` | **nouveau** — reconstruction du schéma hérité, pour les tests |
| `server/tests/legacy-migration.test.ts` | 17 cas sur de vraies bases PostgreSQL (4 pour le vocabulaire de statuts, 1 pour la lisibilité de la sortie) |
| `tests/migration-safety.test.js` | garde-fous statiques (aucun `DROP`, ordre des migrations, pile Compose, **mot de passe jamais dans une URL, aucun secret commité**) |
| `server/tests/env-database-url.test.ts` | **nouveau** — 7 cas sur l'assemblage de la chaîne de connexion |
| `server/src/lib/env.ts` | `DATABASE_URL` **ou** `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`, assemblés et encodés côté serveur |
| `deploy/docker-compose.vps.yml` | l'API et le service `migrate` reçoivent les **parties** de la connexion, plus jamais une URL contenant le mot de passe |
| `deploy/fake.env` | **nouveau** — variables factices versionnées, pour valider le Compose sans lire un secret |
| `nginx.vps.conf` | `/api` sans slash final est proxifié au lieu de servir la SPA |
| `.env.selfhosted.example` | sépare explicitement obligatoire / facultatif ; aucune valeur réelle |

Cette livraison-là ne modifiait aucun fichier applicatif ; la présente, si
(voir §0).

---

## 4. Validation locale (déjà exécutée, à refaire si vous voulez)

```bash
# Backend — build + 43 tests, dont 17 sur de vraies bases PostgreSQL
cd server
npm ci --include=dev
npm run build
DATABASE_URL="postgres://<user>@<host>:<port>/<db_de_test>" npm test

# Frontend / dépôt — 170 tests, lint, typecheck, build
cd ..
npm ci --include=dev
npm test
npm run lint
npm run typecheck
npm run build
```

Les tests de migration créent et suppriment leurs propres bases
(`psa_legacy_test_*`). Ils **ne touchent jamais** la base pointée par
`DATABASE_URL` : celle-ci ne sert qu'à se connecter et à créer les bases
jetables. Le rôle utilisé doit avoir `CREATEDB` ; sinon le test s'arrête avec
le message qui le dit. **Ne visez jamais la base de production.**

Résultats obtenus ici :

```
server : # tests 43  # pass 43  # fail 0     (build OK, typecheck OK)
dépôt  : # tests 172 # pass 172 # fail 0     (build OK, typecheck OK,
                                              lint 0 erreur / 8 warnings
                                              shadcn préexistants)
docker compose config avec un fichier de variables FACTICE : OK
```

Vérifié aussi à la main, contre une base héritée migrée **portant la contrainte
`posts_status_check` réelle** :

| Vérification | Résultat |
|---|---|
| `npm run migrate:dry-run` sur le schéma hérité complet | `DRY RUN OK — 3 migration(s) would apply cleanly` puis `Rolled back` |
| `POST /api/auth/register` | 201 |
| `POST /api/posts` (statut `pending`) | 201 |
| `POST /api/posts/:id/validate` (statut `validated`) | 200 |
| Compte hérité, après mise d'un mot de passe : `POST /api/auth/login` | 200 |
| Ses anciens posts (`published`, `draft`) listés par `GET /api/posts` | visibles, statuts d'origine |
| API démarrée **sans `DATABASE_URL`**, avec seulement `PGHOST/PGUSER/PGDATABASE` | `/api/health` 200, `/api/posts` 200 |
| Mot de passe contenant `@ : / # ? & = +` | assemblé, encodé, relu identique par le parseur de `pg` |

---

### 4 quater. Résultats de CETTE livraison (audit de pré-production)

Bac à sable, PostgreSQL 16 local, bases jetables `psa_*` uniquement, Node 22 :

| Vérification | Résultat |
|---|---|
| `server`: `npm ci` · `npm run build` · `npm run typecheck` · `npm run fetch-model` | OK · OK · OK · modèle présent et vérifié |
| `server`: `npm test` (base neuve migrée) | `# tests 91  # pass 91  # fail 0` (76 → 91 : +15 dans `tests/audit-fixes.test.ts`) |
| Contre-épreuve | code d'origine remis temporairement : les tests des corrections échouent (statut Graphiste, logo, double publication, blocage `publishing`, inscription simultanée, limite de connexion, quota hebdomadaire, purge, URL internes) |
| dépôt : `npm ci` · `npm test` | OK · `# tests 209  # pass 209  # fail 0` (202 → 209) |
| dépôt : `npm run lint` | `0 errors, 8 warnings` — les 8 warnings préexistants, aucun nouveau |
| dépôt : `npm run typecheck` · `npm run build` | OK · OK |
| Garde CI anti-Supabase (4 `grep`) | 0 occurrence |
| `docker compose … --env-file deploy/fake.env config` | OK |
| `nginx -t` sur `nginx.vps.conf` | OK |
| **Migration vierge** | `Applied 8 migration(s).` ; 2 rejeux complets (`psql -f`) sans erreur ; relance : `Schema already up to date.` |
| **Migration legacy** (fixture du schéma réel) | `Applied 8 migration(s).` puis `Schema already up to date.` |
| **Dry-run** (même fixture) | `DRY RUN OK — 8 migration(s) would apply cleanly.` · `Rolled back: the database is unchanged.` · schéma identique colonne pour colonne · aucune table `schema_migrations` laissée |
| Navigateur réel (Chromium, fuseau `Africa/Lagos`) | post à 00 h 30 affiché le bon jour, « Enregistrer » sans changement → date inchangée en base ; « Publication en cours » sans bouton « Valider » ; API coupée → message + « Réessayer » (pas d'onboarding), puis reprise ; analyse des cibles → description enregistrée d'abord ; `/abonnement` → connexion → retour sur `/abonnement` |

Non exécuté ici : `docker build` (pas de démon Docker), la répétition sur la
**copie réelle** (§6.0).

### 4 ter. Résultats de la livraison précédente (personnage + corrections)

Bac à sable, PostgreSQL 16 local, bases jetables `psa_*` uniquement, Node 22 :

| Vérification | Résultat |
|---|---|
| `server`: `npm ci` · `npm run typecheck` · `npm run fetch-model` | OK · OK · `model present and verified` (SHA-256 épinglé) |
| `server`: `npm test` (base neuve migrée) | `# tests 76  # pass 76  # fail 0` (65 → 76 : +11 sur le personnage, contre le vrai modèle et un vrai PostgreSQL) |
| dépôt : `npm ci` · `npm test` | OK · `# tests 202  # pass 202  # fail 0` (193 → 202) |
| dépôt : `npm run lint` | `0 errors, 8 warnings` — les 8 warnings préexistants (vérifié sur la base), aucun nouveau |
| dépôt : `npm run typecheck` · `npm run build` | OK · OK |
| Garde CI anti-Supabase (4 `grep`) | 0 occurrence |
| `docker compose … --env-file deploy/fake.env config` | OK |
| **Migration vierge** | `Applied 7 migration(s).` ; 2 rejeux complets (`psql -f`) sans erreur ; relance : `Schema already up to date.` |
| **Migration legacy** (fixture du schéma réel) | `Applied 7 migration(s).` puis `Schema already up to date.` |
| **Dry-run** (même fixture) | `DRY RUN OK — 7 migration(s) would apply cleanly.` · `Rolled back: the database is unchanged.` · aucune table `schema_migrations` laissée |
| `nginx -t` sur `nginx.vps.conf` (nginx 1.24) | syntaxe OK ; derrière ce nginx : photo réelle de 10,3 Mo → `201` en 7,8 s ; 9 Mo sur `/api/media` → `413` (inchangé) ; limite dépassée → `429` + message français (et non `502`) |
| Navigateur réel (Chromium) | carte affichée, envoi bloqué sans la case, « Détourage en cours… », aperçu détouré, bascule gauche/droite enregistrée ; module de page bloqué → rechargement unique puis message + bouton, qui rétablit la page |

Non exécuté ici : `docker build` (pas de démon Docker) — il télécharge le
modèle depuis github.com ; la répétition sur la **copie réelle** (§6.0).

### 4 bis. Résultats de la livraison précédente (correctif `provider` + référence unique)

Exécutés dans le bac à sable, PostgreSQL 16 local, bases jetables `psa_*`
uniquement, Node 22.22 — exactement les commandes demandées :

| Vérification | Résultat |
|---|---|
| `server`: `npm ci --include=dev` · `npm run build` · `typecheck` | OK · OK · OK |
| `server`: `npm test` (base de test migrée) | `# tests 65  # pass 65  # fail 0` (61 → 65) |
| dépôt : `npm ci --include=dev` | OK |
| dépôt : `npm test` | `# tests 193  # pass 193  # fail 0` (190 → 193) |
| dépôt : `npm run lint` | `0 errors, 8 warnings` — les 8 warnings préexistants, aucun nouveau |
| dépôt : `npm run typecheck` · `npm run build` | OK · OK |
| Garde CI anti-Supabase (4 `grep`) | 0 occurrence |
| `docker compose -f deploy/docker-compose.vps.yml --env-file deploy/fake.env config` | OK (volumes internes et externes) |
| **Migration vierge** | `Applied 6 migration(s).` ; `[0004] generation_jobs.provider is now NOT NULL.` ; 2 rejeux complets sans erreur ; relance : `Schema already up to date.` |
| **Migration legacy** (fixture avec le `generation_jobs` RÉEL, `provider text NOT NULL`) | `write probe passed` ; `Applied 6 migration(s).` ; `[0004] … already NOT NULL` ; les 2 jobs historiques identiques champ par champ ; `provider` toujours `NOT NULL` ; comptes `active=2` ; posts `draft/failed/published/scheduled` intacts ; l'écriture réelle de l'API est acceptée (`provider = graphiste`) ; un job sans provider est refusé ; relance : `Schema already up to date.` |
| **Dry-run** (même fixture) | `write probe passed` puis `DRY RUN OK — 6 migration(s) would apply cleanly.` et `Rolled back: the database is unchanged.` ; schéma identique colonne pour colonne avant/après ; aucune table `schema_migrations` créée |
| Référence Mobile Money | refusée en double pour les statuts `pending`, `approved`, `rejected`, `cancelled` ; variantes de casse, d'espaces (avant, après, intérieur) et de canal refusées ; une référence différente est acceptée et stockée sous forme canonique ; l'index refuse aussi un `INSERT` SQL direct |

Non exécuté ici : `docker build` (pas de démon Docker), la répétition sur la
**copie réelle** de production (§00, à faire par Hermes).

---

## 5. Build Docker (à exécuter par Hermes)

L'image **n'a pas pu être construite ici** : ce bac à sable a le client Docker
mais pas de démon. Le `Dockerfile` a été relu (multi-stage, `npm ci`, Node
22.18-alpine, `--omit=dev` pour le runtime, `USER node`, aucun secret dans une
couche, healthcheck sur `/api/health`) et le Compose a été **validé**
(`docker compose config`, en mode volumes internes et externes). Le
`docker build` reste donc à faire sur le VPS.

```bash
# Build de l'image API
docker build -t pro-social-ai-api:$(git rev-parse --short HEAD) server/

# Vérifier le Compose AVANT de démarrer quoi que ce soit
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted config

# Le même contrôle SANS toucher à un secret (valeurs factices) :
docker compose -f deploy/docker-compose.vps.yml --env-file deploy/fake.env config
```

Build du frontend sur l'hôte (nginx sert `dist/` en lecture seule) :

```bash
npm ci --include=dev && npm run build
```

---

## 5b. `DATABASE_URL` et le `***` observé

Vous avez vu, dans la sortie de la configuration résolue :

```yaml
DATABASE_URL: postgres://${POSTGRES_USER}:***@postgres:5432/...
```

**Le fichier versionné n'a jamais contenu de `***`** : il portait
`${POSTGRES_PASSWORD}`, une substitution Compose. Les `***` viennent du masquage
appliqué à la sortie de `docker compose config` par les versions récentes de
Compose (ou par le journal qui l'a transportée). Un masque dans cette sortie est
malheureusement **indiscernable** d'un mot de passe littéral `***` dans le
fichier : impossible de conclure sans rouvrir le fichier — ce qui est exactement
le temps perdu que cette livraison supprime.

**Ce qui a changé.** Le mot de passe ne voyage plus dans une URL. Compose passe
les **parties** à l'API et au service `migrate` :

```yaml
PGHOST: postgres
PGPORT: 5432
PGUSER: ${POSTGRES_USER}
PGPASSWORD: ${POSTGRES_PASSWORD}
PGDATABASE: ${POSTGRES_DB:-pro_social_ai}
```

et le serveur assemble la chaîne lui-même (`server/src/lib/env.ts`), en
encodant chaque partie. Deux bénéfices, dont un qui vous aurait coûté cher :

1. **Plus aucune URL contenant un mot de passe** dans la configuration résolue :
   il n'y a plus rien à masquer, donc plus d'ambiguïté possible.
2. **Un mot de passe contenant `@ : / ? # & = +` fonctionne enfin.** L'URL
   construite par interpolation YAML était silencieusement fausse pour ces
   caractères : le mot de passe était interprété comme un hôte ou un chemin et
   l'API échouait à s'authentifier, avec un message pointant à côté de la cause.
   Si vous générez le mot de passe avec `openssl rand -base64 32`, le cas est
   courant (`+` et `/` y sont fréquents).

`DATABASE_URL` reste prioritaire si elle est définie : rien ne change pour un
usage hors Compose.

**Vérifier la configuration sans exposer un secret :**

```bash
# Valeurs factices versionnées : vérifie la syntaxe, le routage, les volumes.
docker compose -f deploy/docker-compose.vps.yml --env-file deploy/fake.env config

# Vérifier que les VRAIES variables sont bien lues, sans afficher leur valeur :
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted config \
  | grep -E "PG(HOST|PORT|USER|DATABASE):"
# puis, une fois la pile démarrée, que l'API est bien connectée :
curl -fsS https://<domaine>/api/health     # {"ok":true} ⇒ la connexion fonctionne
```

---

## 6. Ordre de déploiement

> Chaque étape a un résultat observable. **Si une étape ne donne pas ce
> résultat, arrêtez-vous** : la section 10 dit quand il est interdit de
> continuer.

### 6.0 — Répétition générale sur une COPIE (fortement recommandé)

C'est l'étape qui transforme une migration en non-événement.

```bash
# 1. Restaurer le dump du jour dans une base de travail
createdb psa_rehearsal
psql psa_rehearsal < /chemin/backup-du-jour.sql

# 2. Regarder le schéma réel (lecture seule)
psql "postgres://…/psa_rehearsal" -f server/scripts/inspect-legacy-schema.sql

# 3. Répétition : applique tout, puis annule tout
cd server
DATABASE_URL="postgres://…/psa_rehearsal" npm run migrate:dry-run
```

Attendu : `DRY RUN OK — N migration(s) would apply cleanly.` puis
`Rolled back: the database is unchanged.` Lisez les lignes `[WARNING]` : elles
annoncent exactement ce que la vraie migration fera (comptes sans adresse,
mots de passe à réinitialiser, lignes non rattachées).

Si la répétition échoue, le message nomme le problème et la conduite à tenir.
**Ne déployez pas** ; envoyez le message.

### 6.1 — Sauvegarde de la base

```bash
mkdir -p /opt/backups/$(date +%F)
docker exec <conteneur_postgres> pg_dump -U <user> -d <db> -Fc \
  > /opt/backups/$(date +%F)/db-avant-migration.dump
ls -lh /opt/backups/$(date +%F)/db-avant-migration.dump   # doit être > 0
```

### 6.2 — Sauvegarde des médias

```bash
docker run --rm -v pro-social-ai_media:/data -v /opt/backups/$(date +%F):/backup \
  alpine tar czf /backup/media.tar.gz -C /data .
tar tzf /opt/backups/$(date +%F)/media.tar.gz | head   # doit lister des fichiers
```

### 6.3 — Espace disque

```bash
df -h /            # garder au moins 20 % libres, et > 2× la taille du dump
docker system df   # voir ce que récupérerait un `docker image prune`
```

### 6.4 — Mise à jour des sources

```bash
cd /opt/pro-social-ai   # ou le chemin réel du dépôt sur le VPS
git fetch origin
git checkout claude/selfhosted-provider-compat-r5k8
git rev-parse HEAD      # doit correspondre à la section 1
```

### 6.5 — Construire l'image et le frontend

```bash
docker build -t pro-social-ai-api:$(git rev-parse --short HEAD) server/
npm ci --include=dev && npm run build     # produit dist/, monté en lecture seule
```

Mettez `API_IMAGE` dans `.env.selfhosted` sur le tag que vous venez de
construire (ou laissez Compose builder lui-même).

### 6.6 — Démarrer PostgreSQL seul

```bash
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted up -d postgres
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted ps
```

Attendu : `postgres` en `healthy`. **Vérifiez d'abord `docker volume ls`** :
si les volumes existent déjà, mettez `VOLUMES_ARE_EXTERNAL=true`, sinon
Compose en crée des vides et la base paraît perdue (elle ne l'est pas, mais le
service tourne à côté de vos données).

### 6.7 — Migrations

```bash
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted \
  --profile migrate run --rm migrate
```

Attendu, sur une base déjà peuplée :

```
applied  0000_legacy_production_compat.sql
  [NOTICE] [0000] identity strategy: profiles_user_id
  [NOTICE] [0000] preflight passed.
  [WARNING] [0000] N account(s) use an incompatible password format …
  [NOTICE] [0000] write probe passed.
applied  0001_core_schema.sql
applied  0002_media_public_token.sql
applied  0003_trial_and_subscriptions.sql
  [NOTICE] [0004] generation_jobs.provider is already NOT NULL.
applied  0004_generation_job_provider.sql
applied  0005_payment_reference_once.sql
Applied 6 migration(s).
```

(Aucune migration n'est encore appliquée en production : les six passent,
dans cet ordre, en une exécution. Sur une base où certaines le sont déjà,
le registre les saute et seules les suivantes s'appliquent.)

Contrôle immédiat de 0003 — **aucun compte existant ne doit être en essai** :

```sql
SELECT subscription_status, count(*) FROM profiles GROUP BY 1;
-- attendu : uniquement 'active' (les comptes existants), aucun 'trialing'
SELECT count(*) FROM profiles WHERE subscription_status = 'trialing' AND trial_ends_at IS NULL;
-- attendu : 0
```

Puis, tout de suite :

```bash
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted \
  exec postgres psql -U <user> -d <db> -c \
  "SELECT step, detail, row_count FROM legacy_compat_report ORDER BY id;"
```

C'est le compte rendu de ce qui a été fait. Gardez-le.

### 6.8 — Démarrer l'API

```bash
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted up -d api
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted logs -f api
```

Attendu : le serveur écoute, et les éventuelles lignes
`capability unavailable: …` nomment les clés absentes (chacune ne désactive
qu'une fonctionnalité).

### 6.9 — Démarrer le frontend

```bash
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted up -d frontend
```

### 6.10 — Vérification API

```bash
curl -fsS https://auto-post-gen.76.13.129.252.sslip.io/api/health   # {"ok":true}
```

### 6.11 — Vérification navigateur

Ouvrir `https://auto-post-gen.76.13.129.252.sslip.io/` : la page charge, la
console ne montre ni erreur CSP ni 404 d'asset, et le réseau montre les appels
vers `/api/...` **sur la même origine** (jamais vers un domaine cloud).

### 6.12 — Routes SPA

Ouvrir directement, puis **rafraîchir (F5)** sur chacune :
`/login`, `/dashboard`, `/profile`, `/calendar`. Chacune doit répondre 200 et
afficher l'application (et non un 404 nginx) — c'est le `try_files … /index.html`.

### 6.13 — Contrôle disque final

```bash
df -h / && docker system df
```

---

## 7. Rollback

Les trois morceaux se restaurent indépendamment. **La base d'abord** si la
migration est en cause.

```bash
# 1. Revenir à l'image précédente
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted stop api frontend
# remettre API_IMAGE=<tag précédent> dans .env.selfhosted
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted up -d api frontend

# 2. Restaurer la base (arrêter l'API d'abord, sinon elle écrit pendant la restauration)
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted stop api
docker exec -i <conteneur_postgres> pg_restore -U <user> -d <db> --clean --if-exists \
  < /opt/backups/<date>/db-avant-migration.dump
docker compose -f deploy/docker-compose.vps.yml --env-file .env.selfhosted up -d api

# 3. Restaurer les médias
docker run --rm -v pro-social-ai_media:/data -v /opt/backups/<date>:/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/media.tar.gz -C /data"
```

**Spécifique à 0003.** Elle n'ajoute que des colonnes, une table et des
index : l'image précédente les ignore et fonctionne telle quelle, sans
restauration. Revenir à l'image précédente suffit donc pour annuler la
fonctionnalité (les forfaits cessent d'être appliqués, l'essai n'est plus
affiché). Si vous voulez aussi retirer les objets de 0003 — **jamais
nécessaire** — faites-le à la main après sauvegarde : la règle du dépôt est
qu'aucune migration ne supprime de données.

Deux propriétés rendent le retour arrière possible **sans restaurer la base**
dans la plupart des cas : la migration n'a rien supprimé ni renommé (les
colonnes héritées `user_id`, la table `users` et leurs données sont intactes),
et elle n'a fait qu'ajouter. L'ancienne image retrouve donc ses données telles
quelles. La restauration de la base reste la voie sûre si un doute subsiste.

---

## 8. Vérifications de production après déploiement

| # | Vérification | Attendu |
|---|---|---|
| 1 | `curl -fsS https://<domaine>/api/health` | `{"ok":true}` |
| 2 | `SELECT * FROM legacy_compat_report ORDER BY id;` | le compte rendu de la migration, sans surprise |
| 3 | `SELECT count(*) FROM profiles WHERE email IS NULL;` | 0, ou un nombre que vous acceptez (ces comptes ne peuvent pas se connecter tant qu'une adresse n'est pas renseignée) |
| 4 | `SELECT count(*) FROM posts WHERE profile_id IS NULL;` | 0 |
| 4b | `SELECT status, count(*) FROM posts GROUP BY status;` | les statuts historiques (`draft`, `scheduled`, `published`, `failed`) intacts, avec les mêmes effectifs qu'avant migration |
| 4c | `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='posts_status_check';` | la liste contient les 7 valeurs (héritées + nouvelles) |
| 4d | `SELECT conname FROM pg_constraint WHERE conrelid='posts'::regclass AND NOT convalidated;` | soit vide, soit des contraintes que le rapport explique (lignes historiques conservées) |
| 5 | Inscription d'un compte de test depuis l'interface | 201 puis session ouverte |
| 6 | Connexion d'un compte **hérité** | soit elle fonctionne (mot de passe au format scrypt), soit « mot de passe oublié » envoie un lien — voir le rapport, ligne `identity.password` |
| 7 | Un post existant est visible dans le tableau de bord de son propriétaire | oui |
| 8 | Une image existante s'affiche | oui (volume média monté) |
| 9 | `/login` puis F5 | l'application, pas un 404 |
| 10 | `docker compose … ps` | `postgres`, `api`, `frontend` en `healthy` |
| 11 | `docker exec <postgres> psql -c "\d profiles"` depuis l'hôte uniquement | PostgreSQL n'est **pas** joignable depuis l'extérieur |
| 12 | `SELECT subscription_status, count(*) FROM profiles GROUP BY 1;` | aucun compte existant en `trialing` (tous `active`) |
| 13 | Inscription depuis « Essai gratuit » du forfait Starter | le tableau de bord affiche « Essai gratuit Starter — encore 7 jours » |
| 14 | `/abonnement` | les moyens de paiement configurés (`PAYMENT_*`) s'affichent avec le bon montant |
| 15 | Déclarer un paiement de test, puis `/admin` → « Paiements à vérifier » → **Valider** | le compte passe `active` ; email de confirmation reçu si Resend est configuré |
| 16 | `curl -fsS -X POST -H "x-cron-secret: …" https://<domaine>/api/cron/subscription-reminders` | `{"sent":…,"failed":…}` (facultatif : le runner interne le fait chaque jour) |

---

## 9. Limites connues et points à configurer à la main

1. **Le schéma réel de production n'a jamais été vu depuis ce dépôt.** La
   fixture `server/tests/fixtures/legacy_production_schema.sql` est une
   **reconstruction** à partir des faits rapportés (7 tables, `profiles` sans
   `email`, comptes dans `users`). La migration découvre le schéma au lieu de
   le supposer, et **refuse** ce qu'elle ne peut pas déterminer — mais la
   répétition générale (§6.0) sur une copie reste la seule preuve réelle.
   Faites-la.
2. **Mots de passe hérités.** Seul le format scrypt de ce build est repris.
   Un hash bcrypt/argon n'est pas copié : les comptes concernés doivent passer
   par « mot de passe oublié ». Le nombre exact est dans
   `legacy_compat_report` (`identity.password`). **Cela suppose que l'email
   sortant fonctionne** : sans `RESEND_API_KEY` + `RESEND_FROM`, ces comptes
   n'ont aucun moyen de revenir. Configurez-les **avant** la migration si des
   comptes sont concernés.
3. **Sessions.** La table `sessions` est nouvelle : tout le monde est
   déconnecté après le déploiement. Normal, à annoncer.
3b. **Anciens statuts dans l'interface.** Le tableau de bord ne connaît que
   `pending / validated / published / failed` ; il affiche donc un post
   `draft` ou `scheduled` comme « à valider ». Vérifié : l'utilisateur peut le
   valider normalement, et il part ensuite en publication. Rien n'est perdu ni
   bloqué, et **la migration ne réécrit aucun statut**. Si vous préférez que
   les anciens posts `scheduled` repartent tout seuls, c'est une décision
   d'exploitation, à faire à la main et réversible :

   ```sql
   -- OPTIONNEL. Noter les ids avant, pour pouvoir revenir en arrière.
   SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_for > now();
   UPDATE posts SET status = 'validated'
    WHERE status = 'scheduled' AND scheduled_for > now();
   ```
4. **Comptes sans adresse.** Un profil hérité dont l'utilisateur n'avait pas
   d'email garde toutes ses données mais ne peut pas se connecter tant qu'une
   adresse n'est pas renseignée (`UPDATE profiles SET email = … WHERE id = …`).
5. **Contraintes héritées relâchées.** Les colonnes `user_id` restent, avec
   leurs valeurs, mais ne sont plus `NOT NULL` : les nouvelles lignes écrites
   par la nouvelle API les laissent vides. C'est voulu — sans cela, aucune
   inscription n'est possible.
6. **`API_IMAGE`, volumes, noms de conteneurs** : à aligner sur ce que le VPS
   utilise déjà (`docker ps`, `docker volume ls`) via `.env.selfhosted`.
   `VOLUMES_ARE_EXTERNAL=true` si les volumes existent déjà.
7. **Secrets** : aucun n'est dans le dépôt. `.env.selfhosted` est à créer sur
   le VPS uniquement (voir `.env.selfhosted.example` pour la liste
   obligatoire / facultative).
8. **Image Docker non construite ici** (pas de démon Docker) : le premier
   `docker build` réel se fera sur le VPS.
9. **Recherche web** : non implémentée sur cette pile (voir
   `VPS_DEPLOYMENT_HANDOFF.md`) ; `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY`
   n'existent plus.

---

### Propres à cette livraison

10. **La connexion des réseaux sociaux n'est toujours pas terminée**
    (`POST /social/connect` → 503, livraison précédente). Tant qu'elle ne
    l'est pas, **aucun post ne peut être publié** : un client peut essayer puis
    payer un produit qui ne publie pas. C'est le premier chantier produit. Le
    contrat à respecter (plafond `limits.socialAccounts`, refus d'un compte
    expiré) est écrit dans le code de la route.
11. **Vérification des paiements à la main.** Chaque déclaration doit être
    contrôlée dans l'application Mobile Money avant « Valider ». Sans
    `RESEND_API_KEY`/`RESEND_FROM`, rien ne prévient l'opérateur : consultez
    `/admin` chaque jour.
12. **Politique de remboursement non décidée.** Les CGU décrivent le mécanisme
    sans promettre ni exclure de remboursement : décision du propriétaire.
13. **Supprimer un compte supprime son historique de paiements**
    (`ON DELETE CASCADE`). Si la comptabilité doit le conserver, exportez-le
    avant (`GET /api/account/export` le contient).
14. **Non porté depuis `magical-thompson`** (propre à Supabase) : diagnostic
    « État de la plateforme » et alertes `health-alert`, emails de validation
    hebdomadaires, changement d'email par l'utilisateur. À reconstruire sur
    cette pile si besoin.

---

## 10. Interdiction de déployer

**Ne déployez pas** si l'une de ces conditions est vraie :

- [ ] `npm test` échoue (dépôt ou `server/`) ;
- [ ] `npm run build` échoue (dépôt ou `server/`), ou `docker build` échoue ;
- [ ] la migration de compatibilité échoue sur la fixture héritée
      (`server/tests/legacy-migration.test.ts`) ;
- [ ] `npm run migrate:dry-run` échoue sur la **copie restaurée** de la
      production (§6.0) ;
- [ ] l'espace disque du VPS est insuffisant (moins de 20 % libres, ou moins
      de deux fois la taille du dump) ;
- [ ] la sauvegarde de la base ou celle des médias est absente, vide ou
      illisible.

Dans tous ces cas, le message d'erreur nomme ce qui ne va pas. Rien n'a été
écrit dans la base : la migration est transactionnelle et s'annule
entièrement.
