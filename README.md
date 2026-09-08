# Pro Social AI / Auto Post Gen

SaaS de génération, planification et publication de posts réseaux sociaux avec IA.

Le produit aide une petite entreprise à :

- configurer son activité en onboarding ;
- générer des posts en français adaptés à son métier ;
- enrichir les posts avec recherche web gratuite (Google News RSS, Wikipedia, DuckDuckGo) ;
- générer un visuel IA associé ;
- valider, programmer et publier les posts ;
- connecter les réseaux sociaux via Zernio / Postiz / Ayrshare selon les secrets configurés ;
- suivre les statistiques et les commentaires.

## Stack

- React + Vite + TypeScript
- Tailwind + shadcn-ui
- Supabase Auth / Database / Storage / Edge Functions
- OpenRouter pour la génération IA de **texte**
- Graphiste GPT pour les **affiches/images** (moteur exclusif, pas de repli)
- Zernio / Postiz / Ayrshare / OAuth direct pour la publication sociale
- Netlify pour le frontend (déployé par GitHub Actions)

## Développement local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Variables frontend nécessaires dans `.env.local` :

```bash
VITE_SUPABASE_PROJECT_ID="..."
VITE_SUPABASE_PUBLISHABLE_KEY="..."
VITE_SUPABASE_URL="https://....supabase.co"
```

Les secrets backend ne doivent jamais être mis dans `.env.local` : ils vont dans Supabase → Project Settings → Edge Functions → Secrets.

## Checks avant livraison

```bash
npm run lint       # 0 erreur (7 warnings shadcn/fast-refresh connus)
npm run typecheck  # ⚠️ npm run build NE vérifie PAS les types
npm test           # 161 tests
npm run build
```

Les 25 Edge Functions se vérifient d'un coup :

```bash
deno check supabase/functions/*/index.ts
```

La CI (`.github/workflows/ci.yml`) exécute exactement ces commandes sur chaque
PR.

## Secrets Supabase minimum pour un premier utilisateur

Obligatoires :

```bash
OPENROUTER_API_KEY=...        # texte IA
GRAPHISTE_GPT_API_KEY=...     # affiches IA — SANS elle : texte OK mais JAMAIS d'image
CRON_SECRET=...
ALLOWED_ORIGINS=https://votre-domaine.netlify.app
APP_BASE_URL=https://votre-domaine.netlify.app
APP_PUBLIC_URL=https://votre-domaine.netlify.app
APP_NAME="Pro Social AI"
```

Pour diagnostiquer la génération d'affiches de bout en bout (clé, crédits,
vraie génération) :

```bash
GRAPHISTE_GPT_API_KEY="..." node scripts/diagnose-graphiste.mjs
```

Fortement recommandé pour MVP publication sociale :

```bash
ZERNIO_API_KEY=...
ZERNIO_API_URL=https://zernio.com/api/v1
```

Optionnel :

```bash
RESEND_API_KEY=...
RESEND_FROM="Pro Social AI <no-reply@votre-domaine.com>"
TAVILY_API_KEY=...
BRAVE_SEARCH_API_KEY=...
```

La recherche web fonctionne déjà gratuitement sans Tavily/Brave grâce à Google News RSS + Wikipedia + DuckDuckGo.

## Déploiement

Frontend Netlify :

```bash
npm run build
```

Netlify publie le dossier `dist` et redirige toutes les routes React vers `index.html` via `netlify.toml`.

Edge Functions Supabase — le déploiement normal passe par la CI : tout push
sur `main` touchant `supabase/functions/**` déploie **toutes** les fonctions
(`.github/workflows/deploy-functions.yml`). En manuel si besoin :

```bash
supabase functions deploy --project-ref tktoyntaeajgsuplhntd
```

## Cron Supabase à configurer

Appeler les endpoints avec le header :

```txt
x-cron-secret: <CRON_SECRET>
```

Cadences recommandées :

- `auto-generate-weekly` : lundi 06:00 UTC
- `send-validation-email` : lundi 08:00 UTC
- `publish-post` : toutes les 15 minutes
- `sync-comments` : toutes les 15–30 minutes si commentaires activés

## État actuel vérifié (8 septembre 2026)

- `npm run lint` : OK (warnings shadcn/fast-refresh non bloquants)
- `npm run typecheck` : OK — TypeScript en mode `strict`
- `npm test` : 161/161
- `npm run build` : OK
- `deno check supabase/functions/*/index.ts` : OK sur les 25 fonctions
- Recherche web mutualisée : `supabase/functions/_shared/research.ts`
- Génération manuelle et automatique utilisent la recherche web
- Les libellés de secteur/ton/type de contenu sont traduits avant d'entrer dans
  les prompts (`supabase/functions/_shared/profileLabels.ts`) — ne jamais
  réinjecter `profile.sector` brut
- Planification dans le fuseau de l'utilisateur (`profiles.timezone`)
- Publication : retries bornés avec backoff (`due_posts_for_publishing`)

Le détail des défauts trouvés et corrigés lors du dernier audit est dans
[`docs/HANDOVER.md`](./docs/HANDOVER.md) §6 bis, y compris les trois points
laissés à votre décision.

Voir aussi :

- [`docs/HANDOVER.md`](./docs/HANDOVER.md) — **document de transmission** :
  architecture, audit sécurité, décisions, pièges, checklist de reprise.
  **Commencez par lui si vous découvrez le projet.**
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — secrets et mise en production (référence).
- [`docs/PRICING.md`](./docs/PRICING.md) — modèle économique, coûts et marges.
