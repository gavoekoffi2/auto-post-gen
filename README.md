# Pro Social AI

Plateforme d'automatisation de contenu pour les réseaux sociaux.
Elle combine **Supabase** (auth, DB, edge functions) + **Lovable AI Gateway**
(génération de texte + image) + **[Postiz](https://github.com/gitroomhq/postiz-app)**
(publication multi-plateformes).

## Fonctionnalités

- Onboarding personnalisé (secteur, ton, fréquence, jours, type d'image).
- Génération automatique de posts (texte + image) avec Gemini via Lovable AI.
- Bibliothèque d'images personnalisées (stockage Supabase).
- Calendrier de programmation.
- **Connexion aux réseaux sociaux via Postiz** (OAuth officiels — pas de mot
  de passe stocké).
- **Publication réelle** (immédiate ou programmée) sur Instagram, Facebook,
  LinkedIn, X (Twitter), TikTok, YouTube, Pinterest, Threads, Bluesky, etc.
- Cron Supabase pour publier les posts validés à leur date prévue.
- Email de validation hebdo (via Resend, optionnel).
- Page de contact enregistrée dans la DB (`contact_messages`).

## Stack

- Vite + React 18 + TypeScript
- shadcn/ui + Tailwind CSS
- Supabase (auth, Postgres + RLS, storage, edge functions Deno)
- Postiz API publique pour la publication sociale
- Resend pour les emails (optionnel)

## Démarrer en local

```bash
bun install        # ou npm install
bun run dev        # Vite sur le port 8080
```

Variables d'environnement **frontend** (`.env`) :

```env
VITE_SUPABASE_URL="https://<project>.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<anon-key>"
VITE_SUPABASE_PROJECT_ID="<project-id>"
```

## Déploiement Supabase

```bash
supabase link --project-ref <project-ref>
supabase db push                                # applique les migrations
supabase functions deploy generate-content
supabase functions deploy auto-generate-weekly
supabase functions deploy send-validation-email
supabase functions deploy postiz-integrations
supabase functions deploy postiz-publish
supabase functions deploy publish-scheduled-posts
supabase functions deploy delete-account
```

## Clés / secrets à fournir

À configurer dans **Supabase → Project Settings → Edge Functions → Secrets** :

| Nom | Obligatoire | Où l'obtenir | Rôle |
| --- | --- | --- | --- |
| `LOVABLE_API_KEY` | **Oui** | [lovable.dev](https://lovable.dev) → Settings → API | Génération de texte + image (Gemini) |
| `SUPABASE_URL` | auto | — | Défini par Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | auto | — | Défini par Supabase |
| `SUPABASE_ANON_KEY` | auto | — | Défini par Supabase |
| `RESEND_API_KEY` | Optionnel | [resend.com](https://resend.com) → API Keys | Envoi d'emails de validation |
| `RESEND_FROM_EMAIL` | Optionnel | — | Ex. `"Pro Social AI <noreply@votredomaine.com>"` |
| `APP_URL` | Optionnel | — | URL publique de l'app (pour les liens dans les emails) |
| `CRON_SECRET` | Recommandé | À générer vous-même | Protège `publish-scheduled-posts` en tant que header `x-cron-secret` |

### Clé Postiz (côté utilisateur)

La clé **Postiz API** n'est **pas globale** : chaque utilisateur la colle dans
son profil. Elle est stockée chiffrée en DB (colonne `profiles.postiz_api_key`,
protégée par RLS).

Procédure à suivre par l'utilisateur (déjà documentée dans l'UI) :

1. Créer un compte sur [platform.postiz.com](https://platform.postiz.com)
   (ou auto-héberger Postiz).
2. Connecter ses réseaux sociaux via Postiz (OAuth officiels).
3. Aller dans **Settings → Developers → Public API** et générer la clé.
4. La coller dans l'app, onglet « Réseaux sociaux » du dashboard.

## Automatisation (cron)

Depuis le SQL editor Supabase :

```sql
-- Génère les posts de la semaine chaque lundi à 8h.
SELECT cron.schedule(
  'weekly-generation',
  '0 8 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://<project>.functions.supabase.co/auto-generate-weekly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    )
  );
  $$
);

-- Publie les posts dus toutes les 5 min.
SELECT cron.schedule(
  'publish-scheduled',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://<project>.functions.supabase.co/publish-scheduled-posts',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
  );
  $$
);
```

## Schéma clé

- `profiles` : préférences + `postiz_api_key`, `postiz_base_url`,
  `postiz_integrations` (cache).
- `posts` : statut (`pending` → `validated` → `scheduled` → `publishing` →
  `published`), `postiz_post_id`, `publish_error`.
- `contact_messages` : formulaire de contact public.
- Fonction RPC `claim_due_posts(p_limit)` : verrouille les posts dus pour le
  cron.

## Limites / notes

- Postiz applique un **rate limit de 30 requêtes/heure** sur l'API publique.
- Les publications vidéo TikTok/YouTube requièrent des paramètres
  supplémentaires (ex. `privacy_level`) — voir
  [Postiz public API](https://docs.postiz.com/public-api).

## Licence

Code propriétaire — Postiz est inclus par API (AGPL-3.0 côté Postiz, non
redistribué dans ce repo).
