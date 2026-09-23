import { useState } from "react";
import { Check, Sparkles, Zap, Crown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { PLAN_PRICES_FCFA, TRIAL_DAYS, type PlanId } from "@/lib/plans";

const trialCta = `Essai gratuit ${TRIAL_DAYS} jours`;

// Prices come from src/lib/plans.ts, the list the server charges from, so the
// page cannot advertise one amount and the payment screen ask for another.
const plans: {
  id: PlanId;
  name: string;
  description: string;
  monthlyUSD: number;
  annualUSD: number;
  icon: typeof Sparkles;
  gradient: string;
  comingSoonVideo: string | null;
  features: { text: string; included: boolean }[];
  popular: boolean;
}[] = [
  {
    id: "starter",
    name: "Starter",
    description: "Idéal pour démarrer sur les réseaux",
    monthlyUSD: 9,
    annualUSD: 7,
    icon: Sparkles,
    gradient: "from-blue-400 to-blue-500",
    comingSoonVideo: null,
    // Feature lists describe what the code actually enforces (see
    // server/src/shared/plans.ts). They previously claimed
    // differences that do not exist — "Analytics avancés" and "Posts
    // personnalisables" were marked absent on Starter and present on Pro,
    // while the statistics screen and the post editor are identical for every
    // plan. Someone paying more for those would have got exactly what they
    // already had.
    features: [
      { text: "3 posts par semaine", included: true },
      { text: "2 réseaux sociaux", included: true },
      { text: "Génération IA de texte", included: true },
      { text: "Génération IA d'images", included: true },
      { text: "Modification et régénération des posts", included: true },
      { text: "Planification automatique", included: true },
      { text: "Statistiques et calendrier", included: true },
      { text: "Support par email", included: true },
      { text: "Réponses auto aux commentaires (IA)", included: false },
    ],
    popular: false,
  },
  {
    id: "pro",
    name: "Pro",
    description: "Pour les professionnels ambitieux",
    monthlyUSD: 26,
    annualUSD: 22,
    icon: Zap,
    gradient: "from-primary to-accent",
    comingSoonVideo: "1 vidéo IA personnalisée par semaine",
    features: [
      { text: "1 post par jour (7/semaine)", included: true },
      { text: "3 réseaux sociaux", included: true },
      { text: "Quota IA mensuel étendu (150 textes, 150 affiches)", included: true },
      { text: "Images IA personnalisées", included: true },
      { text: "Modification et régénération des posts", included: true },
      { text: "Planification intelligente", included: true },
      { text: "Statistiques et calendrier", included: true },
      { text: "Support prioritaire", included: true },
      { text: "Réponses auto aux commentaires (IA)", included: false },
    ],
    popular: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    description: "Pour les équipes et agences",
    monthlyUSD: 61,
    annualUSD: 50,
    icon: Crown,
    gradient: "from-amber-500 to-orange-500",
    comingSoonVideo: "Jusqu'à 4 vidéos IA personnalisées par semaine",
    features: [
      { text: "Jusqu'à 10 posts/semaine", included: true },
      { text: "8 réseaux sociaux inclus", included: true },
      { text: "Quota IA mensuel maximal (300 textes, 300 affiches)", included: true },
      { text: "Images IA haute qualité", included: true },
      { text: "Fréquence et mix éditorial personnalisables", included: true },
      { text: "Statistiques et calendrier", included: true },
      { text: "Manager de compte dédié", included: true },
      { text: "Support prioritaire", included: true },
      { text: "Réponses automatiques aux commentaires (IA)", included: true },
    ],
    popular: false,
  },
];

export const PricingNew = () => {
  const [isAnnual, setIsAnnual] = useState(false);

  return (
    <section id="pricing" className="py-24 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/5 to-transparent" />
        <div className="absolute top-1/4 left-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-0 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
      </div>

      <div className="container mx-auto max-w-7xl px-4 relative z-10">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full glass-card">
            <Crown className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-medium">Tarifs transparents</span>
          </div>

          <h2 className="text-4xl sm:text-5xl font-bold mb-6">
            <span className="text-foreground">Un plan pour </span>
            <span className="gradient-text">chaque ambition</span>
          </h2>

          <p className="text-lg text-muted-foreground mb-8">
            Commencez avec {TRIAL_DAYS} jours d'essai gratuit, sans carte bancaire. Sans engagement :
            rien n'est prélevé automatiquement, vous renouvelez quand vous le décidez.
          </p>

          {/* Toggle Monthly/Annual */}
          <div className="inline-flex items-center gap-3 p-1.5 rounded-full glass-card">
            <button
              onClick={() => setIsAnnual(false)}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-all duration-300 ${
                !isAnnual
                  ? "bg-primary text-primary-foreground shadow-lg"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Mensuel
            </button>
            <button
              onClick={() => setIsAnnual(true)}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-all duration-300 flex items-center gap-2 ${
                isAnnual
                  ? "bg-primary text-primary-foreground shadow-lg"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Annuel
              <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-bold">
                ≈ 2 mois offerts
              </span>
            </button>
          </div>
        </div>

        {/* Pricing cards */}
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, index) => {
            const price = PLAN_PRICES_FCFA[plan.id];
            const fcfa = isAnnual ? price.annualPerMonth : price.monthly;
            const usd = isAnnual ? plan.annualUSD : plan.monthlyUSD;

            return (
              <div
                key={plan.id}
                className={`relative p-8 rounded-3xl transition-all duration-500 opacity-0 animate-fade-in-up ${
                  plan.popular
                    ? "glass-card-strong border-2 border-primary/30 shadow-glow scale-105 z-10"
                    : "glass-card hover-lift"
                }`}
                style={{
                  animationDelay: `${index * 0.1}s`,
                  animationFillMode: "forwards",
                }}
              >
                {/* Popular badge */}
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <div className="px-4 py-1.5 rounded-full bg-gradient-to-r from-primary to-accent text-white text-sm font-semibold shadow-lg">
                      Le plus populaire
                    </div>
                  </div>
                )}

                {/* Icon */}
                <div
                  className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${plan.gradient} flex items-center justify-center mb-5 shadow-lg`}
                >
                  <plan.icon className="w-7 h-7 text-white" />
                </div>

                {/* Plan info */}
                <h3 className="text-2xl font-bold text-foreground mb-1">
                  {plan.name}
                </h3>
                <p className="text-muted-foreground text-sm mb-5">
                  {plan.description}
                </p>

                {/* Price */}
                <div className="mb-1">
                  <div className="flex items-baseline gap-1 flex-wrap">
                    <span className="text-5xl font-bold text-foreground">
                      {fcfa.toLocaleString("fr-FR")}
                    </span>
                    <span className="text-xl font-semibold text-foreground">FCFA</span>
                    <span className="text-muted-foreground">/mois</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">≈ ${usd}/mois</p>
                  {isAnnual && (
                    <p className="text-xs text-green-400 mt-1 font-medium">
                      Facturé {(fcfa * 12).toLocaleString("fr-FR")} FCFA/an (≈ ${usd * 12}/an)
                    </p>
                  )}
                </div>

                {/* Trial badge */}
                <div className="my-4 px-3 py-2 rounded-xl bg-green-500/10 border border-green-500/20">
                  <p className="text-sm text-green-400 font-semibold text-center">
                    🎉 {TRIAL_DAYS} jours d'essai gratuit
                  </p>
                </div>

                {/* Upcoming AI video badge */}
                {plan.comingSoonVideo && (
                  <div className="my-4 px-3 py-2 rounded-xl bg-violet-500/10 border border-violet-500/20">
                    <p className="text-sm text-violet-400 font-semibold text-center">
                      🎬 {plan.comingSoonVideo} — bientôt disponible
                    </p>
                  </div>
                )}

                {/* Features */}
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      {feature.included ? (
                        <div
                          className={`w-5 h-5 rounded-full bg-gradient-to-br ${plan.gradient} flex items-center justify-center flex-shrink-0 mt-0.5`}
                        >
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-muted/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <X className="w-3 h-3 text-muted-foreground/50" />
                        </div>
                      )}
                      <span
                        className={
                          feature.included
                            ? "text-muted-foreground text-sm"
                            : "text-muted-foreground/40 text-sm line-through"
                        }
                      >
                        {feature.text}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <Link to={`/auth?plan=${plan.id}`}>
                  <Button
                    className={`w-full h-12 font-semibold rounded-xl ${
                      plan.popular
                        ? "bg-gradient-to-r from-primary to-accent hover:opacity-90 shadow-glow"
                        : "bg-secondary hover:bg-secondary/80"
                    }`}
                  >
                    {trialCta}
                  </Button>
                </Link>
              </div>
            );
          })}
        </div>

        {/* Bottom note */}
        <div className="text-center mt-12 space-y-2">
          <p className="text-sm text-muted-foreground">
            Prix en FCFA — équivalent USD indiqué à titre indicatif. Paiement par Mobile Money : Wave, Orange Money, MTN ou Moov.
          </p>
          <p className="text-xs text-muted-foreground/70">
            L'essai gratuit inclut toutes les fonctionnalités du plan choisi. Aucune carte bancaire requise.
          </p>
          <p className="text-xs text-muted-foreground/70">
            À la fin de l'essai, la création de contenu se met en pause jusqu'au choix d'un forfait ; vos posts déjà programmés sont quand même publiés.
          </p>
        </div>
      </div>
    </section>
  );
};
