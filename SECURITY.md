# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir d'issue publique pour une faille de sécurité.

Écrivez à l'adresse de contact du produit (formulaire `/contact` ou l'adresse
configurée dans `CONTACT_TO`) avec :

- une description de la faille et de son impact ;
- les étapes de reproduction ;
- la version / le commit concerné.

Nous accusons réception sous 72 heures et visons un correctif sous 30 jours
pour les failles critiques.

## Périmètre

Dans le périmètre :

- les fonctions edge (`supabase/functions/**`) ;
- les politiques RLS et les droits de colonne (`supabase/migrations/**`) ;
- l'application web (`src/**`) et sa configuration d'en-têtes.

Hors périmètre : le déni de service par volume, les rapports issus uniquement
d'un scanner automatique sans impact démontré, et les services tiers
(Supabase, Zernio, OpenRouter, Graphiste GPT, Resend) — signalez-les
directement à l'éditeur concerné.

## Modèle de sécurité

Points structurants à connaître avant de contribuer :

- **Le navigateur parle directement à Postgres** avec la clé anon. RLS **et**
  les droits de colonne sont les seuls contrôles protégeant les données. RLS
  filtre les *lignes*, jamais les *colonnes* : toute colonne écrite par le
  serveur doit être retirée du `GRANT UPDATE` accordé à `authenticated`
  (voir `20260817000000_poster_columns_and_rate_limit_fixes.sql`).
- **Les fonctions `verify_jwt = false` sont publiques.** Elles doivent valider
  elles-mêmes un JWT utilisateur ou un secret partagé, en échouant *fermé*
  (`_shared/secret.ts`, comparaison à temps constant).
- **Aucune URL fournie par l'utilisateur n'est appelée sans garde.** Les images
  passent par `_shared/safeFetch.ts` (HTTPS uniquement, hôtes privés et
  métadonnées bloqués, redirections revalidées à chaque saut, taille plafonnée).
  Les cibles de polling Graphiste sont épinglées à l'origine de l'API
  (`_shared/graphisteParse.ts`) car chaque appel porte la clé API.
- **Les secrets ne vivent que dans Supabase → Edge Functions → Secrets.**
  Rien de sensible dans `.env`, qui n'alimente que le frontend (`VITE_*`).
- **CORS échoue fermé** : sans `ALLOWED_ORIGINS`, aucun en-tête
  `Access-Control-Allow-Origin` n'est émis.

Les tests `tests/security-hardening.test.js`,
`tests/audit-followup-hardening.test.js` et
`tests/poster-poll-target-hardening.test.js` verrouillent ces invariants —
une régression casse la CI.
