import { ArrowRight, Sparkles, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export const CTASection = () => {
  return (
    <section className="py-24 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-accent/5 to-primary/10" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-accent/15 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
      </div>
      
      <div className="container mx-auto max-w-4xl px-4 relative z-10">
        <div className="text-center p-12 md:p-16 rounded-[2.5rem] glass-card-strong border-glow">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-8 rounded-full bg-primary/10 border border-primary/20">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-primary">Lancez-vous maintenant</span>
          </div>
          
          {/* Heading */}
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-6">
            <span className="text-foreground">Prêt à </span>
            <span className="gradient-text">automatiser</span>
            <br />
            <span className="text-foreground">vos réseaux sociaux ?</span>
          </h2>
          
          {/* Subtitle */}
          <p className="text-lg text-muted-foreground max-w-xl mx-auto mb-10">
            Rejoignez plus de 10 000 créateurs et entreprises qui utilisent AutoPublish 
            pour dominer les réseaux sociaux sans effort.
          </p>
          
          {/* CTA buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <Link to="/auth">
              <Button 
                size="lg" 
                className="group h-14 px-10 text-base font-semibold bg-gradient-to-r from-primary via-primary to-accent hover:opacity-90 transition-all shadow-glow animate-gradient rounded-2xl"
              >
                Commencer gratuitement
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
            <Link to="/contact">
              <Button 
                size="lg" 
                variant="outline" 
                className="h-14 px-10 text-base font-semibold glass-card border-2 border-primary/20 hover:border-primary/40 hover:bg-primary/5 rounded-2xl"
              >
                Parler à un expert
              </Button>
            </Link>
          </div>
          
          {/* Trust elements */}
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
            {[
              "Essai gratuit 14 jours",
              "Sans engagement",
              "Setup en 2 minutes"
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
