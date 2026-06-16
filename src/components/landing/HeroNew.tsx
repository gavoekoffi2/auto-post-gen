import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Play, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { FloatingElements } from "./FloatingElements";
import { DashboardPreview } from "./DashboardPreview";
import { PlatformBadges } from "./PlatformBadges";

export const HeroNew = () => {
  return (
    <section className="relative min-h-screen pt-24 pb-16 overflow-hidden mesh-gradient">
      <FloatingElements />
      
      <div className="container mx-auto max-w-7xl relative z-10 px-4">
        {/* Hero content */}
        <div className="text-center max-w-4xl mx-auto mb-16">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-5 py-2.5 mb-8 rounded-full glass-card border-glow opacity-0 animate-fade-in-down">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground">
              Automatisation IA de nouvelle génération
            </span>
          </div>
          
          {/* Main heading */}
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold leading-[1.1] tracking-tight mb-6 opacity-0 animate-fade-in-up" style={{ animationDelay: '0.1s', animationFillMode: 'forwards' }}>
            <span className="text-foreground">Publiez sur </span>
            <span className="gradient-text">tous vos réseaux</span>
            <br />
            <span className="text-foreground">en </span>
            <span className="relative inline-block">
              <span className="gradient-text-accent">un seul clic</span>
              <svg className="absolute -bottom-2 left-0 w-full" viewBox="0 0 200 12" fill="none">
                <path d="M2 10C50 3 150 3 198 10" stroke="hsl(200 100% 50%)" strokeWidth="3" strokeLinecap="round" className="opacity-50"/>
              </svg>
            </span>
          </h1>
          
          {/* Subtitle */}
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-8 opacity-0 animate-fade-in-up" style={{ animationDelay: '0.2s', animationFillMode: 'forwards' }}>
            L'IA génère votre contenu, vous validez en un clic, nous publions automatiquement. 
            <span className="text-foreground font-medium"> Gagnez 10h par semaine</span> sur vos réseaux sociaux.
          </p>
          
          {/* CTA buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8 opacity-0 animate-fade-in-up" style={{ animationDelay: '0.3s', animationFillMode: 'forwards' }}>
            <Link to="/auth">
              <Button 
                size="lg" 
                className="group h-14 px-8 text-base font-semibold bg-gradient-to-r from-primary via-primary to-accent hover:opacity-90 transition-all shadow-glow animate-gradient rounded-2xl"
              >
                Commencer gratuitement
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              onClick={() =>
                document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className="h-14 px-8 text-base font-semibold glass-card border-2 border-primary/20 hover:border-primary/40 hover:bg-primary/5 rounded-2xl"
            >
              <Play className="mr-2 w-5 h-5 text-primary" />
              Voir la démo
            </Button>
          </div>
          
          {/* Trust badges */}
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground opacity-0 animate-fade-in-up" style={{ animationDelay: '0.4s', animationFillMode: 'forwards' }}>
            {[
              "Aucune carte requise",
              "Configuration en 2 min",
              "Annulation à tout moment"
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span>{item}</span>
              </div>
            ))}
          </div>
          
          {/* Platform badges */}
          <PlatformBadges />
        </div>
        
        {/* Dashboard preview */}
        <div id="demo" className="scroll-mt-24 opacity-0 animate-fade-in-up" style={{ animationDelay: '0.6s', animationFillMode: 'forwards' }}>
          <DashboardPreview />
        </div>
        
        {/* Social proof */}
        <div className="mt-20 text-center opacity-0 animate-fade-in-up" style={{ animationDelay: '0.8s', animationFillMode: 'forwards' }}>
          <p className="text-sm text-muted-foreground mb-6">Ils nous font déjà confiance</p>
          <div className="flex flex-wrap justify-center items-center gap-8 md:gap-12 opacity-60">
            {["TechStartup", "GrowthAgency", "MediaPro", "ContentFirst", "SocialMasters"].map((company, i) => (
              <div key={i} className="text-xl font-bold text-muted-foreground/50 font-display">
                {company}
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {/* Bottom gradient fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </section>
  );
};
