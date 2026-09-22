# Pro Social AI — repository guide

SaaS de génération, planification et publication de posts réseaux sociaux
avec IA. Interface et contenu produit en **français** ; commentaires de code
et messages de commit en anglais.

## Commandes

```bash
npm run dev        # http://localhost:8080
npm run lint       # DOIT rester à 0 problème (0 erreur ET 0 warning)
npm run typecheck  # `vite build` NE typecheck PAS — ce gate est indispensable
npm test           # tests Node natifs, aucun harnais
npm run build
npm run og:image   # régénère public/og-image.png depuis le SVG
```

La CI (`.github/workflows/ci.yml`) exécute exactement ces quatre vérifications.
Si ça passe en local, ça passe en CI.

## Architecture

- **Frontend** : React + Vite + TypeScript + Tailwind + shadcn-ui. Hébergé sur
  un **VPS** (Docker + Nginx derrière Traefik), voir `docker-compose.vps.yml`.
- **Backend** : Supabase managé, projet `tktoyntaeajgsuplhntd` — Postgres +
  RLS, Auth, Storage, et des Edge Functions Deno dans `supabase/functions/`.
- Le navigateur parle à Postgres avec la clé anon : **RLS et les privilèges de
  colonne sont les seuls contrôles** sur l'accès direct aux tables.

## Invariants à ne pas casser

1. **Tout ce qui est vendu est appliqué côté serveur.** Les limites de forfait
   vivent dans `supabase/functions/_shared/plans.ts` (miroir UI :
   `src/lib/plans.ts`, un test échoue si les deux divergent). Le forfait se lit
   **toujours** en base avec le rôle service, jamais depuis la requête.

2. **Graphiste GPT est le seul moteur d'affiches, sans repli.** Un repli
   silencieux produirait des visuels médiocres sans que personne ne le voie. Le
   code échoue explicitement avec un message actionnable. Des tests verrouillent
   cette politique.

3. **Les URL de statut Graphiste ne sont interrogées que sur l'origine
   configurée** (`safeGraphisteStatusUrl`). Ces requêtes portent la clé API en
   en-tête, et l'URL vient de données que l'utilisateur contrôle.

4. **Toute image distante passe par `_shared/safeFetch.ts`** (https only, hôtes
   privés bloqués, taille plafonnée). Jamais de `fetch()` nu sur une URL
   d'image.

5. **CORS fail-closed** (`_shared/cors.ts`) : sans `ALLOWED_ORIGINS`, tout est
   bloqué. C'est voulu.

6. **Les erreurs de fonction edge passent par `src/lib/functionError.ts`.**
   Sinon l'utilisateur ne voit que « Edge Function returned a non-2xx status
   code », qui ne veut rien dire.

7. **Les dates de programmation passent par `src/lib/datetime.ts`.**
   `posts.scheduled_for` est un `timestamptz` ; mélanger UTC et heure locale
   décale les publications.

8. **Aucune fonction edge déployée sans chemin produit.** Chaque fonction est
   un endpoint public. Un test vérifie que `config.toml` et les dossiers
   décrivent la même surface, et que chaque fonction est appelée par l'app ou
   par un cron.

9. **Rien de faux sur les pages publiques.** Témoignages et chiffres viennent
   de `src/lib/testimonials.ts`, livré vide ; les sections ne s'affichent que
   s'il y a du vrai à y mettre. Un test bloque le retour de valeurs inventées.

## Migrations

Ajoutez un fichier dans `supabase/migrations/` — c'est tout.
`scripts/apply-migrations.mjs` tient un registre en base, connaît la liste
explicite des migrations déjà en production, et n'exécute que les nouvelles.
Ne **jamais** ajouter un nom à `BASELINE` pour faire passer un déploiement.

Après une migration qui change le schéma, régénérer les types :
`supabase gen types typescript --project-id tktoyntaeajgsuplhntd > src/integrations/supabase/types.ts`

## Tests

Ils lisent les sources et vérifient des **invariants de politique** autant que
des comportements. C'est délibéré : rapide, sans harnais, et ça épingle les
régressions de conception. Quand vous changez une implémentation que ces tests
décrivent, mettez à jour l'assertion pour viser l'invariant — ne la supprimez
pas.

## Diagnostic

En cas de panne, ouvrir `/admin` → panneau « État de la plateforme » avant les
logs : secrets manquants, clés/crédits des fournisseurs, crons morts, posts en
retard. `health-alert` (cron horaire) envoie la même chose par email.

## Points d'entrée

- [`docs/HANDOVER.md`](./docs/HANDOVER.md) — **commencez par lui** : décisions,
  audits, pièges, checklist de reprise.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — secrets et crons (référence).
- [`docs/PRICING.md`](./docs/PRICING.md) — modèle économique, coûts, marges.
