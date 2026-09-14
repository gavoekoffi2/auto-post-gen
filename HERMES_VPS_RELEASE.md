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

## 1. Ce qu'il faut déployer

| | |
|---|---|
| **Branche** | `claude/legacy-status-compat-9m2x` |
| **SHA du code** | `5fa5755b29fd955d7b54489be0ad131d7c775105` |
| **SHA à déployer** | la pointe de la branche (ce document est le seul commit au-dessus du code ; `git log -1 --format=%H`) |
| **Branche précédente** | `claude/legacy-db-compat-b7k3` @ `07d8d0d2f8c13facf1fdfc9646d1e560cea96d4d` (bloquée par la répétition générale) |
| **Branche d'origine** | `claude/lucid-johnson-14zub1` @ `f3479c2428a45e696e0c48ce679df3946a94b689` |
| **`main`** | non modifié, non poussé, non fusionné |

Comparer avec la branche Claude initiale :

```bash
git fetch origin
# depuis la branche précédente (ce que corrige cette livraison)
git diff --stat origin/claude/legacy-db-compat-b7k3..origin/claude/legacy-status-compat-9m2x
git log --oneline origin/claude/legacy-db-compat-b7k3..origin/claude/legacy-status-compat-9m2x

# depuis la branche Claude initiale
git diff --stat f3479c2428a45e696e0c48ce679df3946a94b689..origin/claude/legacy-status-compat-9m2x
```

---

## 2. Les blocages traités

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

## 3. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `server/migrations/0000_legacy_production_compat.sql` | **nouveau** — migration de compatibilité (préflight, mise en forme, identité, tenancy, contraintes, sonde d'écriture, rapport) |
| `server/src/migrate.ts` | affiche les `NOTICE`/`WARNING` de PostgreSQL ; ajoute `--dry-run` (répétition générale annulée par `ROLLBACK`) |
| `server/package.json` | script `migrate:dry-run` |
| `server/scripts/inspect-legacy-schema.sql` | **nouveau** — inspection **en lecture seule** du schéma réel |
| `server/tests/fixtures/legacy_production_schema.sql` | **nouveau** — reconstruction du schéma hérité, pour les tests |
| `server/tests/legacy-migration.test.ts` | 16 cas sur de vraies bases PostgreSQL (4 ajoutés pour le vocabulaire de statuts) |
| `tests/migration-safety.test.js` | garde-fous statiques (aucun `DROP`, ordre des migrations, pile Compose, **mot de passe jamais dans une URL, aucun secret commité**) |
| `server/tests/env-database-url.test.ts` | **nouveau** — 7 cas sur l'assemblage de la chaîne de connexion |
| `server/src/lib/env.ts` | `DATABASE_URL` **ou** `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`, assemblés et encodés côté serveur |
| `deploy/docker-compose.vps.yml` | l'API et le service `migrate` reçoivent les **parties** de la connexion, plus jamais une URL contenant le mot de passe |
| `deploy/fake.env` | **nouveau** — variables factices versionnées, pour valider le Compose sans lire un secret |
| `nginx.vps.conf` | `/api` sans slash final est proxifié au lieu de servir la SPA |
| `.env.selfhosted.example` | sépare explicitement obligatoire / facultatif ; aucune valeur réelle |

Aucun fichier applicatif (`src/`, routes, services) n'a été modifié : le
comportement du produit est inchangé.

---

## 4. Validation locale (déjà exécutée, à refaire si vous voulez)

```bash
# Backend — build + 42 tests, dont 16 sur de vraies bases PostgreSQL
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
server : # tests 42  # pass 42  # fail 0     (build OK, typecheck OK)
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
git checkout claude/legacy-db-compat-b7k3
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
Applied 3 migration(s).
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
