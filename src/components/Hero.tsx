import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import heroImage from "@/assets/hero-image.jpg";

export const Hero = () => {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden px-4">
      {/* Gradient glow background */}
      <div className="absolute inset-0 bg-gradient-to-b from-primary/20 via-transparent to-transparent animate-glow" />
      
      <div className="container mx-auto max-w-7xl relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left column - Text content */}
          <div className="space-y-8 animate-fade-in">
            <div className="inline-flex items-center gap-2 px-4 py-2 glass-card rounded-full">
              <Sparkles className="w-4 h-4 text-accent" />
              <span className="text-sm font-medium">Automatisation IA pour les réseaux sociaux</span>
            </div>
            
            <h1 className="text-5xl md:text-7xl font-bold leading-tight">
              Publiez du contenu
              <span className="gradient-text block mt-2">automatiquement</span>
            </h1>
            
            <p className="text-xl text-muted-foreground max-w-xl">
              L'IA génère, vous validez, nous publions. Gagnez des heures chaque semaine sur vos réseaux sociaux.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4">
              <Link to="/auth">
                <Button size="lg" className="group bg-gradient-to-r from-primary to-secondary hover:opacity-90 transition-all glow-effect">
                  Commencer gratuitement
                  <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Button>
              </Link>
              <Button size="lg" variant="outline" className="glass-card">
                Voir la démo
              </Button>
            </div>
            
            <div className="flex items-center gap-8 pt-4">
              <div>
                <div className="text-3xl font-bold gradient-text">5+</div>
                <div className="text-sm text-muted-foreground">Réseaux sociaux</div>
              </div>
              <div className="h-12 w-px bg-border" />
              <div>
                <div className="text-3xl font-bold gradient-text">100%</div>
                <div className="text-sm text-muted-foreground">Automatisé</div>
              </div>
              <div className="h-12 w-px bg-border" />
              <div>
                <div className="text-3xl font-bold gradient-text">24/7</div>
                <div className="text-sm text-muted-foreground">Publication</div>
              </div>
            </div>
          </div>
          
          {/* Right column - Hero image */}
          <div className="relative animate-slide-up">
            <div className="absolute -inset-4 bg-gradient-to-r from-primary/30 to-secondary/30 rounded-3xl blur-3xl opacity-50 animate-pulse" />
            <img
              src={heroImage}
              alt="Platform de publication automatisée"
              className="relative rounded-2xl shadow-2xl animate-float"
            />
          </div>
        </div>
      </div>
    </section>
  );
};
