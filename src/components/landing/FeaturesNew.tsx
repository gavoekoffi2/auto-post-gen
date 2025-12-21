import { Sparkles, Calendar, Send, BarChart3, Zap, Shield, Clock, Palette } from "lucide-react";

const features = [
  {
    icon: Sparkles,
    title: "Génération IA",
    description: "L'IA crée du contenu adapté à votre marque et à chaque plateforme automatiquement.",
    gradient: "from-violet-500 to-purple-500",
    delay: "0s"
  },
  {
    icon: Calendar,
    title: "Planification intelligente",
    description: "Programmez vos posts aux meilleurs moments pour maximiser l'engagement.",
    gradient: "from-blue-500 to-cyan-500",
    delay: "0.1s"
  },
  {
    icon: Send,
    title: "Publication multi-plateforme",
    description: "Publiez simultanément sur Instagram, Facebook, LinkedIn, Twitter et plus.",
    gradient: "from-emerald-500 to-teal-500",
    delay: "0.2s"
  },
  {
    icon: BarChart3,
    title: "Analytics avancés",
    description: "Suivez vos performances et optimisez votre stratégie avec des insights détaillés.",
    gradient: "from-orange-500 to-amber-500",
    delay: "0.3s"
  },
  {
    icon: Zap,
    title: "Automatisation complète",
    description: "Validez par email, l'IA s'occupe du reste. Zéro effort, résultats maximum.",
    gradient: "from-pink-500 to-rose-500",
    delay: "0.4s"
  },
  {
    icon: Shield,
    title: "Contenu sécurisé",
    description: "Validation obligatoire avant publication. Gardez le contrôle total sur votre image.",
    gradient: "from-indigo-500 to-blue-500",
    delay: "0.5s"
  },
  {
    icon: Clock,
    title: "Gain de temps",
    description: "Économisez plus de 10 heures par semaine sur la gestion de vos réseaux sociaux.",
    gradient: "from-cyan-500 to-sky-500",
    delay: "0.6s"
  },
  {
    icon: Palette,
    title: "Personnalisation totale",
    description: "Adaptez le ton, le style et les visuels à l'identité unique de votre marque.",
    gradient: "from-fuchsia-500 to-pink-500",
    delay: "0.7s"
  }
];

export const FeaturesNew = () => {
  return (
    <section id="features" className="py-24 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 mesh-gradient opacity-50" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl" />
      
      <div className="container mx-auto max-w-7xl px-4 relative z-10">
        {/* Section header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full glass-card">
            <Zap className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">Fonctionnalités puissantes</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl font-bold mb-6">
            <span className="text-foreground">Tout ce qu'il faut pour </span>
            <span className="gradient-text">dominer les réseaux</span>
          </h2>
          
          <p className="text-lg text-muted-foreground">
            Une suite complète d'outils conçus pour automatiser, optimiser et amplifier 
            votre présence sur les réseaux sociaux.
          </p>
        </div>
        
        {/* Features grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group p-6 rounded-2xl glass-card-strong hover-lift cursor-default opacity-0 animate-fade-in-up"
              style={{ animationDelay: feature.delay, animationFillMode: 'forwards' }}
            >
              {/* Icon */}
              <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-5 shadow-lg group-hover:scale-110 transition-transform duration-300`}>
                <feature.icon className="w-7 h-7 text-white" />
              </div>
              
              {/* Content */}
              <h3 className="text-xl font-bold text-foreground mb-3 group-hover:gradient-text transition-all">
                {feature.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
              
              {/* Hover accent line */}
              <div className={`mt-5 h-1 w-0 group-hover:w-full rounded-full bg-gradient-to-r ${feature.gradient} transition-all duration-500`} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
