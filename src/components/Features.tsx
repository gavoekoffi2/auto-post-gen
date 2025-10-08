import { Sparkles, Calendar, CheckCircle, TrendingUp } from "lucide-react";
import aiGeneration from "@/assets/ai-generation.jpg";
import scheduling from "@/assets/scheduling.jpg";
import analytics from "@/assets/analytics.jpg";

const features = [
  {
    icon: Sparkles,
    title: "Génération IA",
    description: "L'IA crée du contenu personnalisé (texte + image) adapté à votre secteur et votre tonalité.",
    image: aiGeneration,
    gradient: "from-primary to-secondary"
  },
  {
    icon: CheckCircle,
    title: "Validation Simple",
    description: "Recevez vos contenus par email, validez ou modifiez en un clic avant publication.",
    image: scheduling,
    gradient: "from-secondary to-accent"
  },
  {
    icon: Calendar,
    title: "Publication Auto",
    description: "Programmation intelligente aux meilleurs moments sur TikTok, Instagram, LinkedIn, Facebook.",
    image: scheduling,
    gradient: "from-accent to-primary"
  },
  {
    icon: TrendingUp,
    title: "Croissance Assurée",
    description: "Présence constante sur les réseaux sociaux pour maximiser votre visibilité et engagement.",
    image: analytics,
    gradient: "from-primary to-accent"
  }
];

export const Features = () => {
  return (
    <section className="py-24 px-4 relative">
      <div className="container mx-auto max-w-7xl">
        <div className="text-center mb-16 space-y-4">
          <h2 className="text-4xl md:text-5xl font-bold">
            Comment ça <span className="gradient-text">fonctionne</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Un processus simple en 4 étapes pour automatiser complètement votre présence sociale
          </p>
        </div>
        
        <div className="grid md:grid-cols-2 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div
                key={index}
                className="group glass-card rounded-2xl p-8 hover:scale-[1.02] transition-all duration-300 hover:shadow-2xl animate-fade-in"
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <div className="relative mb-6">
                  <div className={`absolute -inset-2 bg-gradient-to-r ${feature.gradient} rounded-xl blur-xl opacity-30 group-hover:opacity-50 transition-opacity`} />
                  <div className="relative w-16 h-16 bg-gradient-to-r ${feature.gradient} rounded-xl flex items-center justify-center">
                    <Icon className="w-8 h-8 text-white" />
                  </div>
                </div>
                
                <h3 className="text-2xl font-bold mb-3">{feature.title}</h3>
                <p className="text-muted-foreground leading-relaxed mb-6">
                  {feature.description}
                </p>
                
                <div className="relative rounded-xl overflow-hidden">
                  <img
                    src={feature.image}
                    alt={feature.title}
                    className="w-full h-48 object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
