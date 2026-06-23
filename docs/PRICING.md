# Tarification — analyse de coûts & marges (marché africain / FCFA)

> Devise de facturation : **FCFA (XOF)**. L'équivalent **USD** est affiché à titre
> indicatif (taux ~575–600 FCFA/USD, juin 2026). Marché cible prioritaire :
> Afrique de l'Ouest francophone (zone FCFA), paiement par **Mobile Money** en priorité.

## 1. Coûts réels (par génération / par compte)

| Poste | Source | Coût unitaire |
|---|---|---|
| Texte d'un post | OpenRouter — `google/gemini-2.5-flash` (~$0,30/M in, ~$2,50/M out) | **~$0,003 / post** |
| Image d'un post — **Starter** | OpenRouter — `google/gemini-2.5-flash-image` ($0,039/image + 5,5 % frais) | **~$0,041 / image** |
| Image d'un post — **Pro / Enterprise** | OpenRouter — `openai/gpt-5.4-image-2` (qualité « medium », ~$0,053/image + 5,5 % frais) | **~$0,056 / image** |
| **IA par post Starter** (texte + image Gemini) | | **~$0,044 / post** |
| **IA par post Pro/Enterprise** (texte + image GPT Image 2) | | **~$0,059 / post** |
| **Vidéo IA personnalisée** (Pro/Enterprise uniquement) | OpenRouter — `google/veo-3.1-lite` (~$0,05/s, clip 8 s, audio natif) + 5,5 % frais | **~$0,42 / vidéo** |
| Réponse auto à un commentaire | texte uniquement | ~$0,003 / réponse |
| **Publication** (driver de coût) | **Zernio — facturé par compte social connecté** : 2 gratuits, puis **$6** (comptes 1–10), **$3** (11–100), **$1** (101–2000) | **$1 à $6 / compte / mois** |
| Emails (validation) | Resend (gratuit < 3 000/mois, puis $20/mois) | ~$0 |
| Hébergement BDD/Edge | Supabase Pro | $25/mois (fixe) |

**Pourquoi GPT Image 2 pour Pro/Enterprise ?** C'est un choix de **différenciation
qualité**, pas d'économie : GPT Image 2 (qualité « medium », la plus adaptée aux visuels
réseaux sociaux) coûte ~36 % plus cher que Gemini par image (~$0,056 vs ~$0,041) — confirmé
en cherchant les tarifs réels (cf. Sources). Ça reste négligeable à l'échelle d'un post,
mais permet de positionner Pro/Enterprise avec un rendu visuel supérieur.

**Nuance technique importante :** le code actuel (`supabase/functions/_shared/ai.ts`)
utilise Gemini 2.5 Flash Image en priorité pour *tous* les plans, et GPT Image 2
uniquement en repli — parce que GPT Image 2 peut dépasser le timeout des Edge Functions
Supabase (risque de 504), pas pour une question de coût. Les calculs ci-dessous
**anticipent** un futur routage par plan (Pro/Enterprise → GPT Image 2 prioritaire, repli
automatique sur Gemini en cas de timeout/erreur). **Ce routage n'est pas encore codé** :
c'est une évolution distincte à développer séparément, pas un simple ajustement de prix.
Tant qu'il n'est pas en place, le coût réel de Pro/Enterprise reste encore plus bas que
prévu ici (sur Gemini) — donc aucun risque de marge dans l'intervalle.

**Conclusion clé :** l'IA (texte + image) reste quasi gratuite (~$0,04–0,06/post). Le vrai
coût variable reste **Zernio, par compte social connecté**. La vidéo IA ajoute un coût
nouveau mais maîtrisé (~$0,42/vidéo) grâce à un quota hebdomadaire serré (voir §3).

## 2. Coût variable par utilisateur / mois

Hypothèses : Starter 13 posts/mois (2 réseaux, pas de vidéo) ; Pro 30 posts/mois
(3 réseaux) **+ 1 vidéo IA/semaine (~4,3/mois)** ; Enterprise 43 posts/mois (8 réseaux)
+ ~150 réponses auto **+ jusqu'à 4 vidéos IA/semaine (~17,3/mois)**.

| Plan | IA texte+image | Vidéo IA | Total IA | Zernio @ $3/compte (normal) | **Total** | Zernio @ $1 (à l'échelle) | **Total** |
|---|---|---|---|---|---|---|---|
| Starter | $0,57 | — | $0,57 | 2 × $3 = $6 | **~$6,6** | 2 × $1 = $2 | **~$2,6** |
| Pro | $1,77 | $1,82 | $3,59 | 3 × $3 = $9 | **~$12,6** | 3 × $1 = $3 | **~$6,6** |
| Enterprise | $2,99 | $7,28 | $10,27 | 5 × $3 = $15 | **~$25,3** | 5 × $1 = $5 | **~$15,3** |

## 3. Vidéo IA — modèle, cadence et budget

**Modèle retenu : Google Veo 3.1 Lite** (`google/veo-3.1-lite` via OpenRouter — même
fournisseur que le reste de la pile IA), à **~$0,05/seconde**, clip de 8 secondes avec
**audio natif synchronisé** (voix/son inclus, un vrai plus pour une vidéo promo business
vs un clip muet). Coût par vidéo (8 s) : 8 × $0,05 = $0,40, + 5,5 % de frais ≈
**$0,42/vidéo**.

Comparatif des modèles vidéo recherchés (tous disponibles via OpenRouter) :

| Modèle | Prix | Clip / résolution |
|---|---|---|
| **Google Veo 3.1 Lite** ✅ retenu | **~$0,05/s** | 4–8 s, 720p/1080p, audio natif |
| Vidu Q3 (Shengshu AI) | ~$0,07/s | jusqu'à 12 s, 1080p |
| MiniMax Hailuo 2.3 | ~$0,082/s | facturation par clip |
| Kling v3.0 Standard | ~$0,126/s | 3–15 s, 16:9 / 9:16 / 1:1 |

Implémentation future recommandée (non codée aujourd'hui) : reprendre le même schéma de
chaîne de repli que `getImageModels()` dans `_shared/ai.ts` — `google/veo-3.1-lite` en
priorité, puis `minimax/hailuo-2.3` en repli si le premier échoue.

**Allocation par plan**, calculée pour rester rentable même en phase de lancement :

| Plan | Vidéos / semaine | Vidéos / mois (~4,33 sem.) | Coût vidéo / mois |
|---|---|---|---|
| Starter | **0** (non disponible) | 0 | $0 |
| Pro | **1** | ~4,3 | ~$1,82 |
| Enterprise | **jusqu'à 4** (~1/jour ouvré) | ~17,3 | ~$7,28 |

Ces volumes sont délibérément prudents (« pas trop lourd pour nous ») : même au tarif
Zernio de lancement le plus cher ($6/compte), Pro et Enterprise restent **rentables**
(marge +17 % et +34 %, voir §6). Quand la fonctionnalité sera développée, plafonner aussi
en dur côté serveur (ex. Pro : 5 vidéos/mois max, Enterprise : 18/mois max) — même logique
que les plafonds mensuels déjà en place pour texte/image.

## 4. Réseaux et publications supplémentaires — tarification à la carte

Chaque plan inclut un **quota de base** (réseaux connectés + publications/semaine). Au-delà,
le prix devient **dynamique** : la personne paie des compléments mensuels plutôt que de
devoir changer de plan pour un dépassement ponctuel. Mécanique proposée :

- **Facturé en abonnement complémentaire mensuel**, pas au post à l'unité : plus simple à
  comprendre, plus prévisible pour un paiement Mobile Money (souvent quasi-prépayé — une
  facture surprise au compteur serait mal vécue dans ce marché).
- **Cumulable** : on peut ajouter plusieurs lots le même mois.
- **Toujours moins avantageux que l'upgrade de plan** en cas d'usage soutenu (l'à‑la‑carte
  est pensé pour un dépassement ponctuel, pas pour remplacer Pro/Enterprise — voir
  vigilance en §8).

| Add-on | Tarif | Coût réel (régime normal) | Marge |
|---|---|---|---|
| **+1 réseau social connecté/mois** (tous plans) | **2 500 FCFA/mois** (~$4,4) | ~$3/compte (Zernio) | ~32 % |
| **+10 publications/mois — Starter** (Gemini) | **2 500 FCFA/mois** (~$4,4) | ~$0,44 | ~91 % |
| **+10 publications/mois — Pro/Enterprise** (GPT Image 2) | **3 000 FCFA/mois** (~$5,2) | ~$0,59 | ~89 % |

Pourquoi ces montants : le réseau supplémentaire est tarifé pour couvrir le coût Zernio du
**régime normal** ($3/compte) avec marge — même en phase de lancement ($6/compte), la perte
unitaire (~$1,6) reste transitoire et comparable à celle déjà acceptée pour Starter (§8).
Les publications supplémentaires coûtent quasiment rien en plus (le réseau est déjà
connecté, seul le coût IA marginal s'applique) : leur prix reste donc volontairement *sous*
le tarif moyen au post du plan de base, pour que ça reste perçu comme un bon plan plutôt
qu'une pénalité, tout en gardant une marge confortable.

**Conséquence pour les quotas de base affichés (mise à jour) :** Enterprise passe de
« réseaux illimités » à **8 réseaux inclus** (très généreux — couvre Facebook, Instagram,
LinkedIn, X, TikTok et YouTube avec marge), au-delà desquels l'add-on ci-dessus s'applique.
« Illimité » sans plafond chiffré exposait à un risque réel : un client connectant par
exemple 50 comptes coûterait jusqu'à $300/mois en Zernio (tarif de lancement) pour un plan
facturé $61 — un chiffre concret et un add-on évitent ce scénario tout en restant generous.

## 5. Prix recommandés (appliqués) — confirmés, aucune hausse nécessaire

| Plan | Mensuel FCFA | ≈ USD | Annuel (/mois) FCFA | ≈ USD | Réseaux inclus | Publications/sem. incluses |
|---|---|---|---|---|---|---|
| **Starter** | **5 000** | ~$9 | 4 200 (50 400/an) | ~$7 | 2 | 3 |
| **Pro** ⭐ | **15 000** | ~$26 | 12 500 (150 000/an) | ~$22 | 3 | 7 (1/jour) |
| **Enterprise** | **35 000** | ~$61 | 29 000 (348 000/an) | ~$50 | 8 | jusqu'à 10 |

Annuel = ~2 mois offerts (−17 %). **Ces prix intègrent déjà** le surcoût GPT Image 2 et le
quota vidéo IA du §3 : pas besoin de les augmenter quand la vidéo sera lancée. Les add-ons
du §4 absorbent les dépassements ponctuels sans avoir à changer la grille de base.

## 6. Marge brute (3 scénarios Zernio)

| Plan | Lancement ($6/compte) | Régime normal ($3/compte) | À l'échelle ($1/compte) |
|---|---|---|---|
| Starter | 9 − 12,6 = **−$3,6 (−40 %)** ⚠️ transitoire | 9 − 6,6 = **+$2,4 (27 %)** | 9 − 2,6 = **+$6,4 (71 %)** |
| Pro | 26 − 21,6 = **+$4,4 (17 %)** | 26 − 12,6 = **+$13,4 (52 %)** | 26 − 6,6 = **+$19,4 (75 %)** |
| Enterprise | 61 − 40,3 = **+$20,7 (34 %)** | 61 − 25,3 = **+$35,7 (59 %)** | 61 − 15,3 = **+$45,7 (75 %)** |

Pro et Enterprise restent **rentables même en phase de lancement** (Zernio à $6/compte),
contrairement à Starter dont le léger déficit transitoire était déjà identifié et accepté
comme coût d'acquisition (voir §8). La marge Pro/Enterprise baisse par rapport à l'ancien
calcul sans GPT Image 2 ni vidéo (Pro 60 %→52 %, Enterprise 72 %→59 % en régime normal),
mais reste très saine.

À déduire : frais d'encaissement (~1 % Wave, ~3–4 % carte) + coûts fixes (Supabase $25,
Resend) amortis sur la base d'abonnés.

## 7. Extension future de plateformes (TikTok, YouTube) — impact prix : nul

Les plans sont déjà tarifés **par nombre de comptes sociaux connectés**, pas par liste de
plateformes nommées (Starter 2, Pro 3, Enterprise 8). Zernio facture **par compte, quelle
que soit la plateforme**. Ajouter TikTok ou YouTube au sélecteur de plateformes ne change
donc rien au modèle de coût : un utilisateur Pro qui connecte 3 comptes (par ex. Facebook +
Instagram + TikTok) paie le même Zernio que 3 comptes Facebook+Instagram+LinkedIn
aujourd'hui. **Aucun ajustement de prix n'est nécessaire pour anticiper cette extension** —
c'est précisément pourquoi le modèle « nombre de réseaux » (et son extension à la carte du
§4) a été choisi plutôt qu'une liste figée. Seule vigilance : vérifier, au moment d'activer
TikTok/YouTube, qu'aucun des deux n'a un surcoût API inhabituel chez Zernio (comme c'est
déjà le cas pour X/Twitter, voir §8).

## 8. Points de vigilance & leviers

- **Phase de lancement (bande Zernio à $6).** Seuls les ~8 premiers comptes connectés
  (au niveau de l'entreprise, tous clients confondus) sont à $6. Sur cette toute première
  bande, **Starter est légèrement déficitaire** (coût ~$12,6 vs $9) ; Pro et Enterprise
  restent positifs. C'est un coût d'acquisition transitoire : dès ~4–5 paires de comptes
  connectées, on passe à $3 et la marge Starter redevient positive.
- **Levier n°1 — OAuth direct.** Publier Facebook/Instagram/LinkedIn via l'OAuth direct
  (déjà dans le code) ne coûte **rien** (pas de Zernio). Si les petits plans passent par
  l'OAuth direct, le coût Starter tombe à ~$0,6 → **marge ~93 %**. Réserver Zernio aux
  réseaux non couverts en direct.
- **X/Twitter** a un coût d'API propre (refacturé par Zernio sans marge) : à surveiller,
  potentiellement à exclure du plan Starter. Vérifier le même point pour TikTok/YouTube
  avant leur activation (voir §7).
- **Garde-fous coût IA déjà en place :** plafonds horaires (20 textes, 30 images/h) et
  **mensuels (200 textes, 200 images/utilisateur)** dans `generate-content` /
  `generate-image`. Pire cas IA (texte+image) borné à ~$8,8/mois/utilisateur sur Gemini
  (Starter), ~$11,8/mois sur GPT Image 2 (Pro/Enterprise) — toujours négligeable face aux
  prix pratiqués. La vidéo IA, une fois codée, devra avoir le même type de plafond mensuel
  dur (voir §3).
- **Auto-réponse IA (Enterprise) :** plafonnée à 10 réponses/exécution dans
  `sync-comments` ; coût négligeable (~$0,003/réponse).
- **GPT Image 2 pour Pro/Enterprise : routage non encore implémenté.** Le calcul de coût
  l'anticipe (§1), mais le code utilise aujourd'hui Gemini pour tout le monde (GPT Image 2
  seulement en repli, pour fiabilité). Implémenter le routage par plan est une tâche de
  développement distincte.
- **Vidéo IA : fonctionnalité non encore développée.** Cette page documente le **budget et
  le modèle prévus** (Veo 3.1 Lite, quotas §3) pour que les prix actuels n'aient pas besoin
  d'augmenter au lancement de la fonctionnalité — le développement reste à faire.
- **Add-ons réseaux/publications (§4) : pas encore facturables.** Même limite que ci-dessous
  (facturation non branchée). À activer en même temps que le paiement Mobile Money.
  Recommandation : plafonner le nombre de lots « +10 publications » cumulables par mois
  (ex. 2 max) pour qu'empiler des lots Pro reste toujours moins intéressant que d'upgrader
  vers Enterprise.
- **Facturation non encore branchée (beta gratuite).** Le plan est stocké dans
  `profiles.plan` et attribué manuellement
  (`UPDATE public.profiles SET plan='enterprise' WHERE id='<uuid>'`).
  Brancher un paiement Mobile Money (Wave / Orange Money via PayDunya, CinetPay ou
  Paystack) avant l'ouverture payante — les add-ons du §4 dépendent de cette même brique.

## Sources

- [GPT-5.4 Image 2 — OpenRouter](https://openrouter.ai/openai/gpt-5.4-image-2)
- [Gemini 2.5 Flash Image — OpenRouter](https://openrouter.ai/google/gemini-2.5-flash-image)
- [GPT Image 2 Pricing in 2026 — WaveSpeed](https://wavespeed.ai/blog/posts/gpt-image-2-pricing-2026/)
- [Veo 3.1 Lite — OpenRouter](https://openrouter.ai/google/veo-3.1-lite)
- [Kling Video v3.0 Standard — OpenRouter](https://openrouter.ai/kwaivgi/kling-v3.0-std)
- [MiniMax Hailuo 2.3 — OpenRouter](https://openrouter.ai/minimax/hailuo-2.3)
- [Video Generation Models — OpenRouter collection](https://openrouter.ai/collections/video-models)

_Taux de change indicatif : 1 USD ≈ 572 FCFA (juin 2026). Les montants USD affichés sur
la page sont arrondis._
