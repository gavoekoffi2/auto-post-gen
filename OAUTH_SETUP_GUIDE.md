# Guide de configuration OAuth — Pro Social AI

Ce guide vous explique **pas à pas** comment créer vos propres applications développeur sur **Meta (Facebook + Instagram)**, **LinkedIn** et **X (Twitter)** pour permettre à vos utilisateurs de connecter leurs comptes sociaux et publier depuis votre app — **gratuitement, à vie**.

Une fois ce setup fait (2-3h une seule fois), vos utilisateurs cliqueront "Connecter" → popup OAuth officielle → ils autorisent → c'est fini. Pas de compte Ayrshare, pas d'abonnement mensuel.

---

## Vue d'ensemble

| Plateforme | Compte gratuit ? | Délai d'approbation | Difficulté |
|------------|------------------|----------------------|------------|
| **Meta** (Facebook + Instagram) | ✅ Oui | Quelques heures à 2 jours (App Review) | ⭐⭐⭐ |
| **LinkedIn** | ✅ Oui | Immédiat pour tests, 1-5 jours pour prod | ⭐⭐ |
| **X (Twitter)** | ✅ Plan Free | Immédiat | ⭐ |
| **TikTok** | ❌ Accès restreint | Partenariat requis (mois) | Hors scope |

---

## Informations communes à garder sous la main

Avant de commencer, ouvrez un fichier texte et notez ces valeurs — vous en aurez besoin partout :

### Votre projet Supabase

```
Project Ref:     prdpzatcevbqeqnaocdl
URL Supabase:    https://prdpzatcevbqeqnaocdl.supabase.co
```

### Votre clé anonyme Supabase

1. Allez sur https://supabase.com/dashboard/project/prdpzatcevbqeqnaocdl/settings/api
2. Copiez la valeur de **"Project API keys" → "anon public"** (commence par `eyJ...`)
3. Notez-la sous le nom `ANON_KEY`

### Les 3 URLs de redirection OAuth

Remplacez `<ANON_KEY>` par la valeur que vous venez de noter :

```
LinkedIn:
https://prdpzatcevbqeqnaocdl.supabase.co/functions/v1/oauth-callback-linkedin?apikey=<ANON_KEY>

Meta (Facebook + Instagram):
https://prdpzatcevbqeqnaocdl.supabase.co/functions/v1/oauth-callback-meta?apikey=<ANON_KEY>

Twitter (X):
https://prdpzatcevbqeqnaocdl.supabase.co/functions/v1/oauth-callback-twitter?apikey=<ANON_KEY>
```

Notez-les telles quelles (avec `?apikey=...`). **C'est important** : Meta/LinkedIn/X exigent que l'URL enregistrée chez eux corresponde **exactement** à celle envoyée par le code, sinon ils refusent l'authentification.

---

## 1 — Meta (Facebook + Instagram)

Une seule app Meta couvre **Facebook ET Instagram**. Vous configurez tout en une fois.

### 1.1 Créer un compte développeur Meta

1. Allez sur https://developers.facebook.com
2. Cliquez **"Get Started"** en haut à droite
3. Connectez-vous avec un compte **Facebook personnel** (ou créez-en un)
4. Suivez le wizard : confirmation par SMS, acceptation des conditions

### 1.2 Créer l'application

1. Une fois sur https://developers.facebook.com/apps cliquez **"Create App"**
2. Choisissez **"Other"** comme cas d'usage → **"Next"**
3. Type d'app : **"Business"** → **"Next"**
4. Nom de l'app : `Pro Social AI` (ou ce que vous voulez)
5. Email de contact : votre email
6. Compte Meta Business : laissez vide (optionnel)
7. Cliquez **"Create app"** → entrez votre mot de passe pour confirmer

### 1.3 Récupérer App ID et App Secret

Vous arrivez sur le dashboard de l'app.

1. Dans le menu de gauche : **"App settings" → "Basic"**
2. Notez les deux valeurs :
   - **App ID** (visible directement) → ce sera `OAUTH_META_APP_ID`
   - **App Secret** → cliquez **"Show"**, entrez votre mot de passe Facebook → ce sera `OAUTH_META_APP_SECRET`

### 1.4 Ajouter Facebook Login

1. Menu de gauche → **"Add products"** (ou descendez sur la page dashboard)
2. Trouvez **"Facebook Login for Business"** → cliquez **"Set up"**
3. Une fois ajouté, menu de gauche → **"Facebook Login for Business" → "Settings"**
4. Dans **"Valid OAuth Redirect URIs"**, collez l'URL de callback Meta :
   ```
   https://prdpzatcevbqeqnaocdl.supabase.co/functions/v1/oauth-callback-meta?apikey=<ANON_KEY>
   ```
5. Activez aussi :
   - ✅ Client OAuth Login
   - ✅ Web OAuth Login
   - ✅ Enforce HTTPS
6. Cliquez **"Save changes"** en bas

### 1.5 Ajouter les permissions (scopes)

Toujours dans l'app Meta :

1. Menu de gauche → **"App Review" → "Permissions and Features"**
2. Demandez l'accès aux permissions suivantes (cliquez **"Request advanced access"** sur chacune) :
   - `public_profile`
   - `email`
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`

> ⚠️ **Note importante** : pour `pages_manage_posts`, `instagram_content_publish` et `business_management`, Meta demandera un **App Review** (vidéo + texte expliquant l'usage). Comptez 1 à 5 jours d'attente. En attendant, vous pouvez tester avec votre propre compte développeur en mode **"Development"**.

### 1.6 Activer Instagram

1. Menu de gauche → **"Add products"** → trouvez **"Instagram"** → **"Set up"**
2. Allez dans **"Instagram" → "API setup with Instagram login"**
3. Suivez les instructions pour lier un **compte Instagram Business** à une **Page Facebook** (obligatoire — Instagram ne permet la publication que via une Page Facebook liée)

### 1.7 Passer l'app en "Live" (production)

Tant que l'app est en mode "Development", seuls vos comptes de test peuvent l'utiliser.

1. En haut de la page de l'app, basculez l'interrupteur **"App Mode"** de **Development → Live**
2. Si Meta refuse : il manque probablement la **politique de confidentialité** (URL publique) et l'**icône de l'app** → ajoutez-les dans **"App settings" → "Basic"**

---

## 2 — LinkedIn

### 2.1 Créer l'application

1. Allez sur https://www.linkedin.com/developers/apps
2. Connectez-vous avec votre compte LinkedIn personnel
3. Cliquez **"Create app"**
4. Remplissez :
   - **App name** : `Pro Social AI`
   - **LinkedIn Page** : **OBLIGATOIRE** — vous devez avoir une Page LinkedIn entreprise (créez-en une gratuite ici si besoin : https://www.linkedin.com/company/setup/new/)
   - **Privacy policy URL** : URL d'une politique de confidentialité publique (vous pouvez utiliser https://stellular-sorbet-9eab14.netlify.app/privacy par exemple — créez la page si elle n'existe pas)
   - **App logo** : un PNG carré (min 100×100)
5. Acceptez les conditions → **"Create app"**

### 2.2 Activer les produits

Dans votre app LinkedIn :

1. Onglet **"Products"**
2. Demandez l'accès à :
   - **"Sign In with LinkedIn using OpenID Connect"** → cliquez **"Request access"** (généralement instantané)
   - **"Share on LinkedIn"** → cliquez **"Request access"** (généralement instantané)
3. Si l'option **"Community Management API"** apparaît, demandez-la aussi (utile pour publier sur des Pages d'entreprise)

### 2.3 Configurer l'URL de redirection

1. Onglet **"Auth"**
2. Dans **"Authorized redirect URLs for your app"**, ajoutez :
   ```
   https://prdpzatcevbqeqnaocdl.supabase.co/functions/v1/oauth-callback-linkedin?apikey=<ANON_KEY>
   ```
3. Cliquez **"Update"** en bas

### 2.4 Récupérer Client ID et Client Secret

Toujours dans l'onglet **"Auth"** :

- **Client ID** → ce sera `OAUTH_LINKEDIN_CLIENT_ID`
- **Primary Client Secret** → cliquez **"Show"** → ce sera `OAUTH_LINKEDIN_CLIENT_SECRET`

### 2.5 Vérifier les scopes activés

Onglet **"Auth"** → section **"OAuth 2.0 scopes"** : vous devez voir au minimum :
- `openid`
- `profile`
- `email`
- `w_member_social`

Si l'un manque, retournez dans **"Products"** et activez le produit correspondant.

---

## 3 — X (Twitter)

### 3.1 Créer un compte développeur

1. Allez sur https://developer.x.com (ou https://developer.twitter.com)
2. Cliquez **"Sign up"** (ou connectez-vous si vous avez déjà un compte X)
3. Choisissez le plan **"Free"** (0$/mois — suffisant pour démarrer, limite ~500 tweets/mois)
4. Remplissez le questionnaire :
   - Cas d'usage : **"Building tools for X users"**
   - Description : "App that lets users schedule and publish content to their own X account"
5. Acceptez les conditions

### 3.2 Créer le projet et l'app

1. Sur https://developer.x.com/en/portal/dashboard cliquez **"Add Project"**
2. Nom du projet : `Pro Social AI`
3. Cas d'usage : **"Making a bot"** ou **"Publishing content"**
4. Description : "Social media scheduling app for businesses"
5. Quand on vous demande de créer une app dans ce projet : nom de l'app : `pro-social-ai-prod`

### 3.3 Configurer User authentication settings

Une fois l'app créée :

1. Cliquez sur votre app dans la liste → onglet **"Settings"**
2. Trouvez **"User authentication settings"** → cliquez **"Set up"**
3. Configurez :
   - **App permissions** : **"Read and write"**
   - **Type of App** : **"Web App, Automated App or Bot"** (= confidential client)
   - **Callback URI / Redirect URL** :
     ```
     https://prdpzatcevbqeqnaocdl.supabase.co/functions/v1/oauth-callback-twitter?apikey=<ANON_KEY>
     ```
   - **Website URL** : `https://stellular-sorbet-9eab14.netlify.app` (ou votre URL de prod)
4. Cliquez **"Save"**

### 3.4 Récupérer Client ID et Client Secret

À l'écran qui suit, X vous montre **une seule fois** :

- **Client ID** → ce sera `OAUTH_TWITTER_CLIENT_ID`
- **Client Secret** → ce sera `OAUTH_TWITTER_CLIENT_SECRET`

> ⚠️ **CRITIQUE** : copiez le Client Secret **immédiatement** dans votre fichier de notes. X ne le réaffichera **jamais**. Si vous le perdez, il faudra le régénérer (et toutes les connexions existantes seront cassées).

### 3.5 Scopes (déjà gérés par le code)

Le code de Pro Social AI demande automatiquement ces scopes lors du flow OAuth :
- `tweet.read`
- `tweet.write`
- `users.read`
- `offline.access` (pour rafraîchir le token)

Vous n'avez rien à configurer pour ça — X les présentera à l'utilisateur lors de l'autorisation.

---

## 4 — Enregistrer les variables dans Supabase

Une fois les 3 apps créées et les credentials notés, il faut les ajouter dans Supabase pour que le backend de Pro Social AI puisse les utiliser.

### 4.1 Aller dans Edge Function Secrets

1. https://supabase.com/dashboard/project/prdpzatcevbqeqnaocdl/functions/secrets
2. Cliquez **"New secret"** pour chacune des variables ci-dessous

### 4.2 Variables à créer

| Nom de la variable | Valeur |
|--------------------|--------|
| `OAUTH_META_APP_ID` | App ID de Meta (étape 1.3) |
| `OAUTH_META_APP_SECRET` | App Secret de Meta (étape 1.3) |
| `OAUTH_LINKEDIN_CLIENT_ID` | Client ID de LinkedIn (étape 2.4) |
| `OAUTH_LINKEDIN_CLIENT_SECRET` | Client Secret de LinkedIn (étape 2.4) |
| `OAUTH_TWITTER_CLIENT_ID` | Client ID de X (étape 3.4) |
| `OAUTH_TWITTER_CLIENT_SECRET` | Client Secret de X (étape 3.4) |
| `OAUTH_STATE_SECRET` | Une chaîne aléatoire de 64 caractères. Générez-la avec `openssl rand -hex 32` ou sur https://generate-secret.vercel.app/64 |
| `APP_BASE_URL` | `https://stellular-sorbet-9eab14.netlify.app` (l'URL publique de votre app) |

> ℹ️ `SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` sont déjà configurés automatiquement par Supabase. Vous n'avez pas à les ajouter.

### 4.3 Redéployer les Edge Functions

Les secrets ne prennent effet qu'au prochain déploiement. Soit :

**Option A — via CLI Supabase** (recommandé) :
```bash
npx supabase functions deploy oauth-start-linkedin
npx supabase functions deploy oauth-callback-linkedin
npx supabase functions deploy oauth-start-meta
npx supabase functions deploy oauth-callback-meta
npx supabase functions deploy oauth-start-twitter
npx supabase functions deploy oauth-callback-twitter
```

**Option B — via Dashboard** :
- Pour chaque fonction `oauth-*` sur https://supabase.com/dashboard/project/prdpzatcevbqeqnaocdl/functions, cliquez sur la fonction puis **"Redeploy"**.

---

## 5 — Tester chaque plateforme

Une fois les secrets enregistrés et les fonctions redéployées :

1. Ouvrez https://stellular-sorbet-9eab14.netlify.app/dashboard
2. Cliquez sur **"Gérer"** dans la carte "Réseaux sociaux"
3. Pour chaque plateforme (LinkedIn, Facebook, Instagram, Twitter) :
   - Cliquez **"Connecter"**
   - Une popup s'ouvre sur le site officiel (linkedin.com, facebook.com, x.com)
   - Autorisez l'accès
   - La popup se ferme → la plateforme apparaît comme connectée avec ✅

### Si une connexion échoue

| Erreur | Cause | Solution |
|--------|-------|----------|
| "redirect_uri_mismatch" | L'URL enregistrée chez Meta/LinkedIn/X ne correspond pas exactement à celle du code | Re-copiez l'URL exacte depuis la section "Informations communes" ci-dessus, y compris `?apikey=...` |
| "Invalid client" | `OAUTH_*_CLIENT_ID` ou `OAUTH_*_CLIENT_SECRET` mal copié dans Supabase | Vérifiez les secrets, redéployez la fonction |
| "App not approved for X scope" (Meta) | App encore en mode Development OU permissions pas encore approuvées par Meta | Soit testez avec votre compte Meta de développement, soit attendez l'App Review |
| "scope is invalid" (LinkedIn) | Le produit "Share on LinkedIn" n'est pas activé | Retournez dans **Products** sur LinkedIn et activez-le |

---

## 6 — Aller en production

Pour que **n'importe quel utilisateur** (pas seulement vous) puisse se connecter :

### Meta
- L'app doit être en mode **"Live"** (étape 1.7)
- Les permissions sensibles (`pages_manage_posts`, `instagram_content_publish`) doivent avoir passé **l'App Review**

### LinkedIn
- L'app est utilisable par n'importe qui dès que les produits sont activés (pas d'App Review pour `w_member_social`)

### X
- Sur le plan **Free**, votre app est limitée à ~500 tweets/mois **partagés entre tous vos utilisateurs**
- Pour scaler, passez au plan **Basic** (100$/mois, 3000 tweets/mois) ou **Pro** (5000$/mois)

---

## 7 — Récap des liens utiles

- Meta Developers : https://developers.facebook.com/apps
- LinkedIn Developers : https://www.linkedin.com/developers/apps
- X Developer Portal : https://developer.x.com/en/portal/dashboard
- Supabase Function Secrets : https://supabase.com/dashboard/project/prdpzatcevbqeqnaocdl/functions/secrets
- Supabase Functions Dashboard : https://supabase.com/dashboard/project/prdpzatcevbqeqnaocdl/functions

---

## En cas de blocage

Si vous restez bloqué sur une étape :

1. Notez exactement à quelle étape vous êtes (ex: "1.4 — j'ai cliqué Save changes et j'ai une erreur rouge")
2. Faites une capture d'écran de l'erreur
3. Envoyez-moi le tout et je vous débloque

Bonne configuration ! Une fois fait, vous n'aurez plus jamais à toucher à ça.
