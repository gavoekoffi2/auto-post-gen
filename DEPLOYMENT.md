# Pro Social AI — variables, nginx et conteneurs

Ce document est la **référence de configuration** du système actuel : un seul
VPS, aucune dépendance cloud managée.

La procédure de déploiement pas-à-pas (migrations, sauvegarde, bascule,
rollback) est dans [`VPS_DEPLOYMENT_HANDOFF.md`](./VPS_DEPLOYMENT_HANDOFF.md).

> **Historique.** Les versions précédentes de ce fichier décrivaient une
> architecture Supabase (Edge Functions, Auth, Storage, RLS) et des
> intégrations sociales alternatives (Ayrshare, Postiz, OAuth direct
> LinkedIn/Meta/X). Rien de tout cela n'est déployé aujourd'hui. Ces notes
> restent consultables dans l'historique git et dans
> [`docs/HANDOVER.md`](./docs/HANDOVER.md) ; ce qu'il faudrait reprendre pour
> les rétablir est listé dans la section « travail non terminé » du handoff.

---

## 1. Variables d'environnement

Seuls les **noms** figurent ici. Les valeurs vivent dans `.env.selfhosted` sur
le VPS, ne sont jamais commitées, et ne sont jamais exposées au frontend : le
dashboard n'a aucune variable de build.

### Obligatoires

| Variable | Rôle | Conséquence si absente |
| --- | --- | --- |
| `DATABASE_URL` | Connexion PostgreSQL (conteneur voisin). | L'API ne démarre pas. |
| `SESSION_COOKIE_SECRET` | Signe le cookie de session et dérive le hachage des jetons à usage unique. Long et aléatoire. | L'API ne démarre pas. En changer **invalide toutes les sessions et tous les liens de réinitialisation en cours**. |
| `APP_PUBLIC_URL` | URL publique du site. Sert aux liens des emails **et** aux URL d'images remises au publieur. | Les emails pointent nulle part ; publier un post dont l'affiche est stockée localement échoue explicitement. |
| `MEDIA_ROOT` | Répertoire du volume média (`/app/media`). | L'API ne démarre pas. |

### Recommandées

| Variable | Rôle | Conséquence si absente |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Génération de texte (chaîne Claude). | Génération de texte et analyse des cibles indisponibles — annoncé, jamais silencieux. |
| `OPENROUTER_TEXT_MODEL` | Force un modèle. **Une valeur non `anthropic/claude-*` est ignorée**, volontairement : la rédaction reste sur Claude. | Chaîne par défaut. |
| `GRAPHISTE_GPT_API_KEY` | Génération d'affiches. Moteur exclusif, **aucun repli local par conception**. | Le texte se génère, jamais l'affiche. C'est dit à l'utilisateur ; aucune image fabriquée n'est présentée comme une génération réussie. |
| `GRAPHISTE_GPT_API_URL` | Surcharge l'endpoint du moteur d'affiches. | Endpoint v1.1 documenté par défaut. |
| `ZERNIO_API_KEY` | Publication sociale. | La publication est refusée avec un message nommant la variable. |
| `ZERNIO_API_URL` | Surcharge la base Zernio. | `https://zernio.com/api/v1`. |
| `APP_NAME` | Nom affiché dans les emails et envoyé à OpenRouter (`X-Title`). | Valeur par défaut. |
| `CRON_SECRET` | Autorise `POST /api/cron/*`. Comparé en temps constant. | Les routes cron répondent 404 — c'est voulu : une route qui répond 401 confirme son existence. |

### Optionnelles

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `RESEND_API_KEY` / `RESEND_FROM` | Emails (réinitialisation, validation, contact). | Sans elles, aucun email n'est envoyé — la réinitialisation répond quand même `ok`, pour ne pas révéler quelles adresses ont un compte. |
| `PUBLISH_TICK_SECONDS` | Cadence de la file de publication. `0` désactive le runner interne. | `60` |
| `WEEKLY_GENERATION` | `off` désactive la génération hebdomadaire interne. | activée |
| `PORT` / `HOST` | Écoute de l'API. | `8080` / `0.0.0.0` |
| `PG_POOL_MAX` | Taille du pool PostgreSQL. Un pool non borné épuise `max_connections` et emmène la base avec lui. | `10` |

Une capacité non configurée est annoncée **au démarrage** et **par la route
qui en dépend**, dans les mêmes termes : l'utilisateur ne rencontre jamais un
no-op silencieux, et un opérateur voit ce qui manque dans les logs seuls.

---

## 2. Tâches planifiées

L'API les exécute elle-même ; il n'y a rien à configurer côté hôte.

| Tâche | Cadence | Comportement |
| --- | --- | --- |
| File de publication | `PUBLISH_TICK_SECONDS` (60 s) | Débloque d'abord les publications interrompues par un crash, puis publie les posts dus et hors de leur fenêtre de report. Lot borné à 12. |
| Génération hebdomadaire | vérifiée toutes les heures | Effective au plus une fois par jour et par compte ; sans effet si les sept prochains jours sont déjà pleins. |

Les faire piloter par l'ordonnanceur de l'hôte : mettre
`PUBLISH_TICK_SECONDS=0` et/ou `WEEKLY_GENERATION=off`, puis appeler
`POST /api/cron/publish` et `POST /api/cron/weekly` avec l'en-tête
`x-cron-secret: <CRON_SECRET>`.

Faire tourner plusieurs répliques de l'API est sûr : chaque post est réservé
par un `UPDATE` conditionnel (`validated` → `publishing`), donc deux runners
en concurrence sur le même post signifient que l'un le prend et que l'autre ne
voit rien à faire.

---

## 3. nginx

nginx sert la SPA et proxifie `/api` vers le conteneur de l'API. Deux points
comptent, tous les deux déjà cassés une fois :

- **`index.html` ne doit jamais être mis en cache.** Sinon un navigateur garde
  l'ancien `index.html` après un déploiement et demande des bundles supprimés :
  page blanche. Les assets versionnés, eux, se mettent en cache longtemps.
- **`add_header` dans un `location` remplace les en-têtes hérités du serveur**,
  il ne s'y ajoute pas. Ajouter un en-tête de cache dans un `location` supprime
  donc silencieusement CSP, HSTS et `X-Frame-Options` pour ces requêtes. Les
  directives `expires` n'ont pas ce défaut, et c'est pourquoi elles sont
  utilisées ici.

```nginx
# SPA : toutes les routes retombent sur index.html
location / {
    try_files $uri $uri/ /index.html;
}

# L'index ne doit jamais être servi depuis un cache.
location = /index.html {
    expires -1;
}

# Les assets portent un hash dans leur nom : immuables.
location /assets/ {
    expires 7d;
}

# L'API, sur la même origine — c'est ce qui rend le cookie de session
# SameSite utilisable et supprime tout besoin de CORS.
location /api/ {
    proxy_pass http://api:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Les affiches et les logos transitent par ici.
    client_max_body_size 6m;
}
```

L'API lit l'IP cliente via `trustProxy` de Fastify, jamais un en-tête brut :
sans cela, n'importe quel client fixerait son propre `X-Forwarded-For` et
contournerait les limitations par IP.

---

## 4. Conteneurs et volumes

| Élément | Nom | Contenu |
| --- | --- | --- |
| Base | `pro-social-ai-postgres-1` | PostgreSQL 16 |
| API | `pro-social-ai-api-1` | Fastify, monte le volume média sur `/app/media` |
| Frontend | `auto-post-gen-frontend` | nginx, sert `dist/` |
| Volume | `pro-social-ai_pgdata` | Données PostgreSQL |
| Volume | `pro-social-ai_media` | Affiches, logos, images de la bibliothèque |

Les deux volumes sont à sauvegarder **ensemble** : une base restaurée sans son
volume média laisse des lignes `media_assets` pointant vers des fichiers
absents, et l'inverse laisse des fichiers que plus rien ne référence.
