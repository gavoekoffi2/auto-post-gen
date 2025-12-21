import { Zap, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

const steps = [
  {
    number: "01",
    title: "Configurez votre profil",
    description: "Décrivez votre activité, votre ton et vos plateformes. L'IA apprend à connaître votre marque.",
    color: "from-blue-500 to-cyan-500"
  },
  {
    number: "02",
    title: "L'IA génère le contenu",
    description: "Chaque semaine, recevez des propositions de posts personnalisés pour tous vos réseaux.",
    color: "from-violet-500 to-purple-500"
  },
  {
    number: "03",
    title: "Validez par email",
    description: "Un simple clic dans votre email pour approuver ou ajuster le contenu proposé.",
    color: "from-pink-500 to-rose-500"
  },
  {
    number: "04",
    title: "Publication automatique",
    description: "Le contenu validé est publié automatiquement aux meilleurs moments.",
    color: "from-amber-500 to-orange-500"
  }
];

export const HowItWorks = () => {
  return (
    <section className="py-24 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-background via-primary/5 to-background" />
      </div>
      
      <div className="container mx-auto max-w-7xl px-4 relative z-10">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-20">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full glass-card">
            <Zap className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">Comment ça marche</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl font-bold mb-6">
            <span className="text-foreground">Simple comme </span>
            <span className="gradient-text">1, 2, 3, 4</span>
          </h2>
          
          <p className="text-lg text-muted-foreground">
            De l'inscription à votre première publication automatique en moins de 5 minutes.
          </p>
        </div>
        
        {/* Steps */}
        <div className="relative max-w-5xl mx-auto">
          {/* Connection line */}
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-primary/20 via-accent/30 to-primary/20 -translate-y-1/2" />
          
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {steps.map((step, index) => (
              <div
                key={index}
                className="relative opacity-0 animate-fade-in-up"
                style={{ animationDelay: `${index * 0.15}s`, animationFillMode: 'forwards' }}
              >
                {/* Step card */}
                <div className="p-6 rounded-2xl glass-card-strong hover-lift text-center lg:text-left">
                  {/* Number badge */}
                  <div className={`inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br ${step.color} items-center justify-center mb-6 shadow-lg`}>
                    <span className="text-2xl font-bold text-white">{step.number}</span>
                  </div>
                  
                  <h3 className="text-xl font-bold text-foreground mb-3">
                    {step.title}
                  </h3>
                  
                  <p className="text-muted-foreground">
                    {step.description}
                  </p>
                </div>
                
                {/* Arrow for desktop */}
                {index < steps.length - 1 && (
                  <div className="hidden lg:flex absolute top-1/2 -right-4 transform -translate-y-1/2 z-10">
                    <div className="w-8 h-8 rounded-full bg-card flex items-center justify-center border border-border">
                      <ArrowRight className="w-4 h-4 text-primary" />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        
        {/* CTA */}
        <div className="text-center mt-16">
          <Link to="/auth" className="inline-flex items-center gap-2 text-primary font-semibold hover:underline">
            Commencer maintenant
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  );
};
