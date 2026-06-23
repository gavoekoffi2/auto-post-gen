# Tarification — analyse de coûts & marges (marché africain / FCFA)

> Devise de facturation : **FCFA (XOF)**. L'équivalent **USD** est affiché à titre
> indicatif (taux ~575–600 FCFA/USD, juin 2026). Marché cible prioritaire :
> Afrique de l'Ouest francophone (zone FCFA), paiement par **Mobile Money** en priorité.

## 1. Coûts réels (par génération / par compte)

| Poste | Source | Coût unitaire |
|---|---|---|
| Texte d'un post | OpenRouter — `google/gemini-2.5-flash` (~$0,30/M in, ~$2,50/M out) | **~$0,003 / post** |
| Image d'un post | OpenRouter — `google/gemini-2.5-flash-image` ($0,039/image + 5,5 % frais) | **~$0,041 / image** |
| **IA par post** (texte + image) | | **~$0,044 / post** |
| Réponse auto à un commentaire | texte uniquement | ~$0,003 / réponse |
| **Publication** (driver de coût) | **Zernio — facturé par compte social connecté** : 2 gratuits, puis **$6** (comptes 1–10), **$3** (11–100), **$1** (101–2000) | **$1 à $6 / compte / mois** |
| Emails (validation) | Resend (gratuit < 3 000/mois, puis $20/mois) | ~$0 |
| Hébergement BDD/Edge | Supabase Pro | $25/mois (fixe) |

**Conclusion clé :** l'IA est quasi gratuite (~$0,04/post). Le vrai coût variable est
**Zernio, par compte social connecté**, qui chute vite avec le volume ($6 → $3 → $1).

## 2. Coût variable par utilisateur / mois

Hypothèses : Starter 13 posts/mois (2 réseaux), Pro 30 (3 réseaux), Enterprise 43
(5 réseaux) + ~150 réponses auto.

| Plan | IA | Zernio @ $3/compte (régime normal) | Total | Zernio @ $1 (à l'échelle) | Total |
|---|---|---|---|---|---|
| Starter | $0,57 | 2 × $3 = $6 | **~$6,6** | 2 × $1 = $2 | **~$2,6** |
| Pro | $1,32 | 3 × $3 = $9 | **~$10,3** | 3 × $1 = $3 | **~$4,3** |
| Enterprise | $2,34 | 5 × $3 = $15 | **~$17,3** | 5 × $1 = $5 | **~$7,3** |

## 3. Prix recommandés (appliqués)

| Plan | Mensuel FCFA | ≈ USD | Annuel (/mois) FCFA | ≈ USD | Réseaux |
|---|---|---|---|---|---|
| **Starter** | **5 000** | ~$9 | 4 200 (50 400/an) | ~$7 | 2 |
| **Pro** ⭐ | **15 000** | ~$26 | 12 500 (150 000/an) | ~$22 | 3 |
| **Enterprise** | **35 000** | ~$61 | 29 000 (348 000/an) | ~$50 | illimité (+ auto-réponse IA) |

Annuel = ~2 mois offerts (−17 %).

## 4. Marge brute

| Plan | Marge @ régime normal ($3) | Marge à l'échelle ($1) |
|---|---|---|
| Starter | 9 − 6,6 = **+$2,4 (27 %)** | **+$6,4 (71 %)** |
| Pro | 26 − 10,3 = **+$15,7 (60 %)** | **+$21,7 (83 %)** |
| Enterprise | 61 − 17,3 = **+$43,7 (72 %)** | **+$53,7 (88 %)** |

À déduire : frais d'encaissement (~1 % Wave, ~3–4 % carte) + coûts fixes
(Supabase $25, Resend) amortis sur la base d'abonnés.

## 5. Points de vigilance & leviers

- **Phase de lancement (bande Zernio à $6).** Seuls les ~8 premiers comptes connectés
  sont à $6. Sur cette toute première bande, **Starter est légèrement déficitaire**
  (coût ~$12,6 vs $9). C'est un coût d'acquisition transitoire : dès ~4–5 paires de
  comptes connectées, on passe à $3 et la marge devient positive.
- **Levier n°1 — OAuth direct.** Publier Facebook/Instagram/LinkedIn via l'OAuth direct
  (déjà dans le code) ne coûte **rien** (pas de Zernio). Si les petits plans passent par
  l'OAuth direct, le coût Starter tombe à ~$0,6 → **marge ~93 %**. Réserver Zernio aux
  réseaux non couverts en direct.
- **X/Twitter** a un coût d'API propre (refacturé par Zernio sans marge) : à surveiller,
  potentiellement à exclure du plan Starter.
- **Garde-fous coût IA déjà en place :** plafonds horaires (20 textes, 30 images/h) et
  **mensuels (200 textes, 200 images/utilisateur)** dans `generate-content` /
  `generate-image`. Pire cas IA borné à ~$8/mois/utilisateur même en cas d'abus.
- **Auto-réponse IA (Enterprise) :** plafonnée à 10 réponses/exécution dans
  `sync-comments` ; coût négligeable (~$0,003/réponse).
- **Facturation non encore branchée (beta gratuite).** Le plan est stocké dans
  `profiles.plan` et attribué manuellement
  (`UPDATE public.profiles SET plan='enterprise' WHERE id='<uuid>'`).
  Brancher un paiement Mobile Money (Wave / Orange Money via PayDunya, CinetPay ou
  Paystack) avant l'ouverture payante.

_Taux de change indicatif : 1 USD ≈ 572 FCFA (juin 2026). Les montants USD affichés sur
la page sont arrondis._
