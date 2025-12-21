import { Check, Sparkles, Zap, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const plans = [
  {
    name: "Starter",
    description: "Pour les créateurs qui débutent",
    price: "0",
    period: "/mois",
    icon: Sparkles,
    gradient: "from-gray-500 to-gray-600",
    features: [
      "3 réseaux sociaux",
      "5 posts par semaine",
      "Génération IA basique",
      "Analytics essentiels",
      "Support par email"
    ],
    cta: "Commencer gratuitement",
    popular: false
  },
  {
    name: "Pro",
    description: "Pour les professionnels exigeants",
    price: "29",
    period: "/mois",
    icon: Zap,
    gradient: "from-primary to-accent",
    features: [
      "Réseaux sociaux illimités",
      "Posts illimités",
      "Génération IA avancée",
      "Analytics détaillés",
      "Validation par email",
      "Support prioritaire",
      "Images personnalisées"
    ],
    cta: "Démarrer l'essai gratuit",
    popular: true
  },
  {
    name: "Enterprise",
    description: "Pour les équipes et agences",
    price: "99",
    period: "/mois",
    icon: Crown,
    gradient: "from-amber-500 to-orange-500",
    features: [
      "Tout de Pro, plus :",
      "Multi-utilisateurs",
      "API dédiée",
      "Manager dédié",
      "Formation personnalisée",
      "SLA garanti",
      "Intégrations custom"
    ],
    cta: "Contacter l'équipe",
    popular: false
  }
];

export const PricingNew = () => {
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
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full glass-card">
            <Crown className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-medium">Tarifs transparents</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl font-bold mb-6">
            <span className="text-foreground">Un plan pour </span>
            <span className="gradient-text">chaque ambition</span>
          </h2>
          
          <p className="text-lg text-muted-foreground">
            Choisissez le plan qui correspond à vos besoins. Évoluez à tout moment.
          </p>
        </div>
        
        {/* Pricing cards */}
        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan, index) => (
            <div
              key={index}
              className={`relative p-8 rounded-3xl transition-all duration-500 opacity-0 animate-fade-in-up ${
                plan.popular 
                  ? 'glass-card-strong border-2 border-primary/30 shadow-glow scale-105 z-10' 
                  : 'glass-card hover-lift'
              }`}
              style={{ animationDelay: `${index * 0.1}s`, animationFillMode: 'forwards' }}
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
              <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${plan.gradient} flex items-center justify-center mb-6 shadow-lg`}>
                <plan.icon className="w-8 h-8 text-white" />
              </div>
              
              {/* Plan info */}
              <h3 className="text-2xl font-bold text-foreground mb-2">{plan.name}</h3>
              <p className="text-muted-foreground mb-6">{plan.description}</p>
              
              {/* Price */}
              <div className="flex items-baseline mb-8">
                <span className="text-5xl font-bold text-foreground">{plan.price}€</span>
                <span className="text-muted-foreground ml-1">{plan.period}</span>
              </div>
              
              {/* Features */}
              <ul className="space-y-4 mb-8">
                {plan.features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <div className={`w-5 h-5 rounded-full bg-gradient-to-br ${plan.gradient} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                      <Check className="w-3 h-3 text-white" />
                    </div>
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
              
              {/* CTA */}
              <Link to="/auth">
                <Button 
                  className={`w-full h-12 font-semibold rounded-xl ${
                    plan.popular 
                      ? 'bg-gradient-to-r from-primary to-accent hover:opacity-90 shadow-glow' 
                      : 'bg-secondary hover:bg-secondary/80'
                  }`}
                >
                  {plan.cta}
                </Button>
              </Link>
            </div>
          ))}
        </div>
        
        {/* Bottom note */}
        <p className="text-center text-sm text-muted-foreground mt-12">
          Tous les prix sont en euros, hors taxes. Annulation possible à tout moment.
        </p>
      </div>
    </section>
  );
};
