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
| **Publication** (driver de coût) | **Zernio — facturé par compte social connecté** : 2 gratuits, puis **$6** (10 comptes suivants), **$3** (90 comptes suivants), **$1** (jusqu'à 2000) | **$1 à $6 / compte / mois** |
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

## 4. Quotas de base & dépassements à la carte (prix dynamique)

### 4.1 Publications par semaine incluses (quota de base)

| Plan | **Publications / semaine incluses** | Réseaux sociaux inclus |
|---|---|---|
| **Starter** | **3** | 2 |
| **Pro** ⭐ | **7** (1 par jour) | 3 |
| **Enterprise** | **10** | 8 |

C'est le socle compris dans l'abonnement, sans surcoût. Il sert de référence pour le
sélecteur de fréquence dans l'app (`Onboarding` / `Profile`).

### 4.2 Aller au-delà : facturation dynamique, à l'unité

Le client **n'est pas obligé de changer de plan** pour publier plus. Il peut **ajouter des
publications par semaine**, et **le prix augmente avec le nombre ajouté** (facturation
dynamique : on paie exactement ce qu'on ajoute, pas plus). Même principe pour les réseaux.

| Add-on (mensuel, récurrent) | Tarif | Coût réel pour nous | Marge |
|---|---|---|---|
| **+1 publication / semaine** (tous plans) | **1 500 FCFA/mois** (~$2,6) | ~$0,19–0,26/mois | **~90 %** |
| **+1 réseau social connecté** (tous plans) | **2 500 FCFA/mois** (~$4,4) | ~$3/compte (Zernio) | ~32 % |

**Exemple concret.** Un client **Pro** (7 pubs/sem. incluses) qui veut publier **10 fois par
semaine** ajoute **3 unités** → 3 × 1 500 = **+4 500 FCFA/mois**, facturés en plus de son
abonnement Pro (15 000 FCFA) → 19 500 FCFA/mois. S'il veut 12/sem., il ajoute 5 unités
(+7 500 FCFA), etc. Le montant suit **linéairement** le nombre de publications ajoutées.

**Pourquoi ces montants :**
- **Publications.** Une publication de plus ne nous coûte presque rien : le réseau est déjà
  connecté (pas de Zernio en plus), seul s'ajoute le coût IA marginal (~$0,044 Starter /
  ~$0,059 Pro-Enterprise par post, soit ~$0,19–0,26/mois pour +1/semaine). On facture donc
  un montant **bas et accessible** (1 500 FCFA), perçu comme un bon plan plutôt qu'une
  pénalité, tout en gardant ~90 % de marge. Tarif **unique tous plans** pour rester simple
  à comprendre (la différence de coût IA entre Gemini et GPT Image 2 est négligeable ici).
- **Réseaux.** Tarifé pour couvrir le coût Zernio du **régime normal** ($3/compte) avec
  marge. Même en phase de lancement ($6/compte), la perte unitaire (~$1,6) reste transitoire
  et comparable à celle déjà acceptée pour Starter (§7.3).

**Garde-fou anti-contournement.** Empiler beaucoup d'unités finit par coûter plus cher que
de monter en gamme — c'est voulu. Ex. un Starter (3/sem., 5 000 FCFA) qui ajoute 7 unités
pour atteindre 10/sem. paierait 5 000 + 10 500 = 15 500 FCFA, soit **plus** qu'un plan Pro
(15 000 FCFA) qui inclut en plus un réseau supplémentaire, la vidéo IA et les analytics
avancés. L'à‑la‑carte reste donc idéal pour un **petit dépassement**, et l'upgrade de plan
redevient le meilleur choix dès que l'usage grimpe. Prévoir un **plafond d'add-ons** côté
serveur (ex. +7 publications/sem. max en à‑la‑carte) au-delà duquel on invite à upgrader.

**Quota réseaux — Enterprise.** Passe de « réseaux illimités » à **8 réseaux inclus** (très
généreux — couvre Facebook, Instagram, LinkedIn, X, TikTok et YouTube avec marge), au-delà
desquels l'add-on réseau s'applique. « Illimité » sans plafond chiffré exposait à un risque
réel : un client connectant par exemple 50 comptes coûterait jusqu'à $300/mois en Zernio
(tarif de lancement) pour un plan
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
comme coût d'acquisition (voir §7.3). La marge Pro/Enterprise baisse par rapport à l'ancien
calcul sans GPT Image 2 ni vidéo (Pro 60 %→52 %, Enterprise 72 %→59 % en régime normal),
mais reste très saine.

À déduire : frais d'encaissement (~1 % Wave, ~3–4 % carte) + coûts fixes (Supabase $25,
Resend) amortis sur la base d'abonnés. **Cette déduction est faite en détail au §7**, avec
vérification que la marge reste positive net, pas seulement brute.

## 7. Rentabilité nette réelle — vérification

**Réponse directe : oui, le modèle gagne de l'argent net, dès une petite base de clients —
pas seulement en marge brute, et pas seulement à grande échelle.** La plateforme a été
conçue pour être rentable, pas pour distribuer le service à perte ; ce qui suit vérifie ce
point chiffres à l'appui plutôt que de l'affirmer simplement.

### 7.1 Ce que le §6 ne déduit pas encore

Le §6 ne retire que le coût variable (IA + Zernio) du prix de vente. Pour confirmer qu'on
**gagne réellement de l'argent** (pas juste une marge brute positive sur le papier), il faut
aussi déduire :
- **Frais d'encaissement** : ~1–2 % en Mobile Money, ~3,5 % en carte (CinetPay/PayDunya,
  agrégateurs courants en Afrique de l'Ouest) → modélisé ici à **3 % du revenu**, une
  estimation prudente compte tenu de la priorité Mobile Money (moins chère) du marché cible.
- **Coûts fixes mensuels** : Supabase Pro $25 + marge pour Resend/divers ≈ **$30/mois**,
  indépendants du nombre de clients — donc proportionnellement plus lourds tout au début,
  et de plus en plus négligeables ensuite.

### 7.2 Scénario réaliste à petite échelle (10 clients)

Hypothèse de répartition volontairement prudente (pas optimiste) : 4 Starter, 5 Pro,
1 Enterprise → 31 comptes sociaux connectés au total.

| | Calcul | Montant |
|---|---|---|
| Revenu | 4×$9 + 5×$26 + 1×$61 | **$227** |
| Coût IA | 4×$0,57 + 5×$3,59 + 1×$10,27 | $30,5 |
| Coût Zernio (2 gratuits + 10 comptes à $6 + 19 à $3) | | $117 |
| **Marge brute** | | **$79,5 (35 %)** |
| Frais d'encaissement (3 %) | | −$6,8 |
| Coûts fixes | | −$30 |
| **Marge nette** | | **+$42,7 (≈ 19 %)** ✅ |

À **30 clients** (même répartition ×3 : 12 Starter, 15 Pro, 3 Enterprise, 93 comptes), la
marge nette **monte à ≈ 35 %** (+$236/mois sur $681 de revenu) : les coûts fixes s'amortissent
sur plus de clients et la quasi-totalité des comptes Zernio passe au palier $3. **La
rentabilité s'améliore avec l'échelle, elle ne s'érode pas.**

### 7.3 Le pire cas : petit, borné, temporaire

Le scénario le plus défavorable plausible : les **tout premiers clients sont à 100 %
Starter** (le plan le moins cher, sans Pro/Enterprise pour compenser). Avec 5 clients
Starter (10 comptes connectés au total : 2 gratuits + 8 facturés à $6, car seuls les 10
premiers comptes payants tombent dans le palier $6) :

Revenu $45 − IA $2,85 − Zernio $48 = marge brute **−$5,85** ; − frais d'encaissement
($1,35) − coûts fixes ($30) = **marge nette ≈ −$37/mois**.

C'est le seul scénario réellement déficitaire de tout le modèle, et il est :
- **Borné.** −$37/mois, soit moins que l'abonnement d'un seul client Enterprise ($61/mois).
- **Temporaire et auto-résolutif.** Dès le 6ᵉ client (quel que soit son plan) ou dès le
  premier client Pro/Enterprise, les comptes supplémentaires basculent au palier $3 et/ou
  apportent une marge largement positive (Pro et Enterprise restent rentables même au
  palier $6, voir §6) — la perte disparaît mécaniquement, sans aucune action requise.
- **Peu probable en pratique.** Pro est mis en avant comme l'offre « la plus populaire »
  sur la page tarifs ; un mix à 100 % Starter sur les 5 premiers clients serait une
  coïncidence défavorable, pas le scénario attendu.
- **Évitable dès aujourd'hui si on veut zéro risque, même transitoire.** Prioriser
  l'**OAuth direct** (Levier n°1, §9) pour les tout premiers clients Starter ramène leur
  coût Zernio à $0 et élimine ce cas de figure entièrement, dès le premier client.

*(Accessoirement : l'essai gratuit de 7 jours a un coût borné comparable — environ $3 pour
un essai Starter et $14 pour un essai Enterprise qui ne convertirait pas, au tarif $6/compte
le plus défavorable. C'est un coût d'acquisition classique, pas un risque structurel ; à
surveiller via le taux de conversion essai→payant une fois la facturation branchée.)*

### 7.4 Résistance aux erreurs d'estimation (stress-test combiné)

Et si le coût réel de GPT Image 2 était sous-estimé de 50 % **et** celui de la vidéo IA
doublé (2×) en même temps ? Sur le scénario réaliste à 10 clients (§7.2) :

Coût IA recalculé : $52,3 (au lieu de $30,5) → marge brute $57,7 (25 %) → marge nette
**≈ $20,9/mois (≈ 9 %)**.

**Toujours positif**, même en cumulant deux hypothèses pessimistes à la fois sur les deux
principaux postes IA variables. La marge se réduit mais ne s'inverse jamais — la preuve que
le modèle a une vraie marge de sécurité, pas seulement sur le papier.

### 7.5 Conclusion

Le modèle gagne de l'argent net, dès une petite échelle (~10 clients), après frais
d'encaissement et coûts fixes, et même sous hypothèses pessimistes sur l'IA. Le seul
scénario de perte (§7.3) est petit, temporaire, peu probable, et peut être neutralisé
immédiatement via l'OAuth direct si on préfère ne prendre aucun risque, même transitoire, dès
le premier client.

## 8. Extension future de plateformes (TikTok, YouTube) — impact prix : nul

Les plans sont déjà tarifés **par nombre de comptes sociaux connectés**, pas par liste de
plateformes nommées (Starter 2, Pro 3, Enterprise 8). Zernio facture **par compte, quelle
que soit la plateforme**. Ajouter TikTok ou YouTube au sélecteur de plateformes ne change
donc rien au modèle de coût : un utilisateur Pro qui connecte 3 comptes (par ex. Facebook +
Instagram + TikTok) paie le même Zernio que 3 comptes Facebook+Instagram+LinkedIn
aujourd'hui. **Aucun ajustement de prix n'est nécessaire pour anticiper cette extension** —
c'est précisément pourquoi le modèle « nombre de réseaux » (et son extension à la carte du
§4) a été choisi plutôt qu'une liste figée. Seule vigilance : vérifier, au moment d'activer
TikTok/YouTube, qu'aucun des deux n'a un surcoût API inhabituel chez Zernio (comme c'est
déjà le cas pour X/Twitter, voir §9).

## 9. Points de vigilance & leviers

- **Phase de lancement (bande Zernio à $6).** Seuls les **10 comptes facturés suivant les
  2 gratuits** (au niveau de l'entreprise, tous clients confondus) sont à $6 — un palier
  qui ne se reproduit plus jamais une fois franchi. Sur cette toute première bande,
  **Starter est légèrement déficitaire** si les premiers clients sont surtout Starter ;
  Pro et Enterprise restent positifs même à ce palier. C'est un coût d'acquisition
  borné et transitoire, chiffré en détail au **§7.3** (pire cas ≈ −$37/mois, pas plus) :
  dès le 6ᵉ client ou le premier Pro/Enterprise, on bascule au palier $3 et la marge
  redevient positive.
- **Levier n°1 — OAuth direct.** Publier Facebook/Instagram/LinkedIn via l'OAuth direct
  (déjà dans le code) ne coûte **rien** (pas de Zernio). Si les petits plans passent par
  l'OAuth direct, le coût Starter tombe à ~$0,6 → **marge ~93 %**. Réserver Zernio aux
  réseaux non couverts en direct.
- **X/Twitter** a un coût d'API propre (refacturé par Zernio sans marge) : à surveiller,
  potentiellement à exclure du plan Starter. Vérifier le même point pour TikTok/YouTube
  avant leur activation (voir §8).
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
  d'augmenter au lancement de la fonctionnalité — le développement reste à faire. **Vérifié :**
  la page tarifs (`PricingNew.tsx`) affiche déjà un badge « 🎬 [allocation] — bientôt
  disponible » pour Pro/Enterprise (absent pour Starter, qui n'aura pas de vidéo) — la
  fonctionnalité n'est présentée nulle part comme déjà disponible.
- **Add-ons réseaux/publications (§4) : pas encore facturables.** Même limite que ci-dessous
  (facturation non branchée). À activer en même temps que le paiement Mobile Money.
  Recommandation : plafonner le nombre d'unités « +1 publication/semaine » cumulables
  (ex. +7/sem. max) pour qu'empiler de l'à‑la‑carte reste toujours moins intéressant que de
  passer au plan supérieur (voir garde-fou §4.2).
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
