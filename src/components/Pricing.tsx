import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { Link } from "react-router-dom";

const plans = [
  {
    name: "Starter",
    price: "29",
    posts: "2",
    description: "Parfait pour commencer",
    features: [
      "2 publications par semaine",
      "Génération IA de contenu",
      "Validation par email",
      "Publication automatique",
      "Support par email"
    ],
    popular: false
  },
  {
    name: "Pro",
    price: "79",
    posts: "5",
    description: "Pour les professionnels actifs",
    features: [
      "5 publications par semaine",
      "Génération IA avancée",
      "Validation par email",
      "Publication automatique",
      "Planification intelligente",
      "Statistiques détaillées",
      "Support prioritaire"
    ],
    popular: true
  },
  {
    name: "Business",
    price: "149",
    posts: "10",
    description: "Pour les entreprises ambitieuses",
    features: [
      "10 publications par semaine",
      "IA personnalisée",
      "Validation multi-canaux",
      "Publication multiplateforme",
      "Planification optimisée",
      "Analytics avancés",
      "Support dédié 24/7",
      "API access"
    ],
    popular: false
  }
];

export const Pricing = () => {
  return (
    <section className="py-24 px-4 relative">
      <div className="container mx-auto max-w-7xl">
        <div className="text-center mb-16 space-y-4">
          <h2 className="text-4xl md:text-5xl font-bold">
            Tarifs <span className="gradient-text">simples</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Choisissez le plan adapté à vos besoins. Sans engagement.
          </p>
        </div>
        
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, index) => (
            <div
              key={index}
              className={`glass-card rounded-2xl p-8 relative ${
                plan.popular ? "ring-2 ring-primary scale-105" : ""
              } hover:scale-[1.02] transition-all duration-300 animate-fade-in`}
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="bg-gradient-to-r from-primary to-secondary text-white px-4 py-1 rounded-full text-sm font-medium">
                    Plus populaire
                  </span>
                </div>
              )}
              
              <div className="text-center mb-6">
                <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
                <p className="text-muted-foreground text-sm mb-4">{plan.description}</p>
                <div className="flex items-baseline justify-center gap-1">
                  <span className="text-5xl font-bold gradient-text">{plan.price}€</span>
                  <span className="text-muted-foreground">/mois</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  {plan.posts} posts par semaine
                </p>
              </div>
              
              <Link to="/auth">
                <Button
                  className={`w-full mb-6 ${
                    plan.popular
                      ? "bg-gradient-to-r from-primary to-secondary hover:opacity-90"
                      : ""
                  }`}
                  variant={plan.popular ? "default" : "outline"}
                >
                  Commencer
                </Button>
              </Link>
              
              <ul className="space-y-3">
                {plan.features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
