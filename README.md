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
- OpenRouter pour la génération IA
- Netlify pour le frontend

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
npm run lint
npm run build
```

Les Edge Functions peuvent être vérifiées avec Deno :

```bash
deno check \
  supabase/functions/generate-content/index.ts \
  supabase/functions/generate-image/index.ts \
  supabase/functions/auto-generate-weekly/index.ts \
  supabase/functions/publish-post/index.ts
```

## Secrets Supabase minimum pour un premier utilisateur

Obligatoires :

```bash
OPENROUTER_API_KEY=...
CRON_SECRET=...
ALLOWED_ORIGINS=https://votre-domaine.netlify.app
APP_BASE_URL=https://votre-domaine.netlify.app
APP_PUBLIC_URL=https://votre-domaine.netlify.app
APP_NAME="Pro Social AI"
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

Edge Functions Supabase :

```bash
supabase functions deploy generate-content
supabase functions deploy generate-image
supabase functions deploy auto-generate-weekly
supabase functions deploy publish-post
supabase functions deploy zernio-connect
supabase functions deploy zernio-status
supabase functions deploy send-validation-email
supabase functions deploy validate-post
supabase functions deploy sync-comments
supabase functions deploy comment-reply
supabase functions deploy send-contact
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

## État actuel vérifié

- `npm run build` : OK
- `npm run lint` : OK avec warnings shadcn/fast-refresh non bloquants
- Recherche web mutualisée : `supabase/functions/_shared/research.ts`
- Génération manuelle et automatique utilisent la recherche web
- Dashboard affiche un indicateur “Génération enrichie par recherche web”

Voir aussi : [`DEPLOYMENT.md`](./DEPLOYMENT.md)
