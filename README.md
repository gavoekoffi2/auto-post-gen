# Pro Social AI / Auto Post Gen

SaaS de génération, planification et publication de posts réseaux sociaux avec IA.

Le produit aide une petite entreprise à :

- configurer son activité en onboarding ;
- faire analyser ses cibles de communication, puis les valider à la main ;
- générer des posts en français adaptés à son métier ;
- générer une affiche IA associée ;
- valider, programmer et publier les posts ;
- connecter ses réseaux sociaux ;
- suivre les statistiques et les commentaires.

## Architecture

Tout tourne sur un seul VPS. **Il n'y a plus aucune dépendance cloud
managée** : pas de Supabase, pas de fonctions hébergées, pas de base distante.

```
navigateur
    │  (même origine, cookie HttpOnly)
    ▼
nginx  ──── /            ──▶  dist/  (SPA React)
       └─── /api/…       ──▶  conteneur API (Fastify)
                                  │
                                  ├──▶ PostgreSQL (conteneur voisin)
                                  ├──▶ volume media (affiches, logos)
                                  └──▶ OpenRouter / Graphiste GPT / Zernio
```

Le navigateur n'appelle jamais qu'un chemin relatif `/api/…`, avec
`credentials: "include"`. Il ne connaît aucune clé de fournisseur, et il
n'annonce jamais son identité : le serveur la relit du cookie de session à
chaque requête.

- **Dashboard** — React 18 + Vite + TypeScript + Tailwind + shadcn-ui.
  Un seul client d'API : [`src/lib/api.ts`](./src/lib/api.ts).
- **API** — Fastify 5 + TypeScript strict + `pg`, dans [`server/`](./server).
- **Base** — PostgreSQL 16 auto-hébergé. Migrations versionnées et
  idempotentes dans [`server/migrations/`](./server/migrations).
- **Texte IA** — OpenRouter, chaîne Claude uniquement.
- **Affiches IA** — Graphiste GPT (moteur exclusif, aucun repli local : une
  affiche absente est signalée, jamais remplacée par une image fabriquée).
- **Publication sociale** — Zernio.

## Développement local

```bash
# dashboard
npm install
npm run dev
```

Le dashboard n'a **aucune variable de build**.

```bash
# API
cd server
npm install
cp ../.env.example ../.env    # noms de variables uniquement, à la racine du dépôt
npm run migrate               # applique les migrations
PORT=8081 npm start           # 8080 est pris par le serveur de dev Vite
```

Le serveur de dev proxifie `/api` vers `http://127.0.0.1:8081`
(`VITE_DEV_API_ORIGIN` pour pointer ailleurs), donc le dashboard local parle
à l'API sur la **même origine** qu'en production — sinon le cookie de
session, étant SameSite, ne serait tout simplement pas envoyé.

## Checks avant livraison

```bash
npm run lint
npm run typecheck     # vite build n'analyse PAS les types (SWC les supprime)
npm test
npm run build

cd server
npm run typecheck
npm run migrate       # nécessite DATABASE_URL
npm test              # nécessite une vraie base PostgreSQL
```

Les tests de l'API tournent contre un vrai PostgreSQL, volontairement : ce
qu'ils couvrent (atomicité des quotas sous verrou, isolation par
`profile_id`, file de publication, unicité des jetons de média) ne peut pas
être vérifié en lisant le code, et un mock n'affirmerait que le comportement
du mock.

## Variables d'environnement

Seuls les **noms** figurent ici ; les valeurs vivent dans `.env.selfhosted`
sur le VPS et ne sont jamais commitées.

Obligatoires :

```bash
DATABASE_URL                  # postgres://… (conteneur voisin)
SESSION_COOKIE_SECRET         # secret long et aléatoire
APP_PUBLIC_URL                # https://…  — requis pour publier une image stockée localement
MEDIA_ROOT                    # /app/media (volume)
```

Recommandées :

```bash
OPENROUTER_API_KEY            # texte IA — sans elle, la génération de texte est indisponible
GRAPHISTE_GPT_API_KEY         # affiches IA — sans elle, texte OK mais jamais d'affiche
ZERNIO_API_KEY                # publication sociale
ZERNIO_API_URL
APP_NAME
CRON_SECRET                   # uniquement si la file est pilotée de l'extérieur
```

Optionnelles :

```bash
RESEND_API_KEY                # emails (réinitialisation, validation, contact)
RESEND_FROM
OPENROUTER_TEXT_MODEL         # doit rester un modèle anthropic/claude-*
PUBLISH_TICK_SECONDS          # défaut 60 ; 0 désactive le runner interne
WEEKLY_GENERATION             # "off" désactive la génération hebdomadaire
PG_POOL_MAX
```

Une capacité non configurée est annoncée au démarrage **et** par la route qui
en dépend, dans les mêmes termes : l'utilisateur ne rencontre jamais un
no-op silencieux, et un opérateur voit ce qui manque dans les logs seuls.

## Tâches planifiées

L'API les exécute elle-même — il n'y a rien à configurer côté hôte :

- **file de publication** : toutes les `PUBLISH_TICK_SECONDS` (60 par défaut) ;
- **génération hebdomadaire** : vérifiée toutes les heures, effective au plus
  une fois par jour et par compte, sans effet si la semaine est déjà pleine.

Un hôte qui préfère son propre ordonnanceur peut mettre
`PUBLISH_TICK_SECONDS=0` / `WEEKLY_GENERATION=off` et appeler :

```txt
POST /api/cron/publish    en-tête  x-cron-secret: <CRON_SECRET>
POST /api/cron/weekly     en-tête  x-cron-secret: <CRON_SECRET>
```

## Déploiement

La procédure complète — migrations, sauvegarde, bascule, rollback — est dans
[`VPS_DEPLOYMENT_HANDOFF.md`](./VPS_DEPLOYMENT_HANDOFF.md).

Voir aussi :

- [`VPS_DEPLOYMENT_HANDOFF.md`](./VPS_DEPLOYMENT_HANDOFF.md) — **document de
  reprise** : routes, schéma, migrations, déploiement, sauvegarde, rollback,
  limites connues. **Commencez par lui.**
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — référence des variables et de nginx.
- [`docs/HANDOVER.md`](./docs/HANDOVER.md) — historique du produit et des
  décisions. Décrit l'architecture Supabase **précédente** ; conservé pour le
  contexte, il n'est plus une description du système en place.
- [`docs/PRICING.md`](./docs/PRICING.md) — modèle économique, coûts et marges.
