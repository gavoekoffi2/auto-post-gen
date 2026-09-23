import { Navbar } from "@/components/Navbar";
import { PLATFORM_STATS } from "@/lib/testimonials";
import { Footer } from "@/components/Footer";
import { Card } from "@/components/ui/card";
import { Sparkles, Target, Users, Zap } from "lucide-react";
import { usePageMeta } from "@/lib/usePageMeta";

export default function About() {
  usePageMeta("À propos", "Notre mission : rendre la présence sociale accessible à toutes les entreprises.");

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      
      <main className="flex-1 pt-24 pb-16">
        <div className="container mx-auto max-w-5xl px-4">
          {/* Hero */}
          <div className="text-center mb-16">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              À propos de <span className="gradient-text">Pro Social AI</span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Nous automatisons la création de contenu pour permettre aux entrepreneurs 
              de se concentrer sur ce qui compte vraiment : leur business.
            </p>
          </div>

          {/* Mission */}
          <Card className="glass-card p-8 md:p-12 mb-12">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
                <Target className="w-6 h-6 text-white" />
              </div>
              <h2 className="text-2xl font-bold">Notre Mission</h2>
            </div>
            <p className="text-muted-foreground text-lg leading-relaxed">
              Créer du contenu de qualité pour les réseaux sociaux prend du temps - 
              un temps précieux que les entrepreneurs n'ont pas. Pro Social AI a été conçu 
              pour résoudre ce problème en automatisant entièrement le processus de 
              création, validation et publication de contenu.
            </p>
            <p className="text-muted-foreground text-lg leading-relaxed mt-4">
              Notre plateforme utilise l'intelligence artificielle pour générer des 
              posts personnalisés qui reflètent l'identité de votre marque, tout en 
              vous laissant le contrôle final sur ce qui est publié.
            </p>
          </Card>

          {/* Values */}
          <div className="grid md:grid-cols-3 gap-6 mb-12">
            <Card className="glass-card p-6">
              <Sparkles className="w-10 h-10 text-primary mb-4" />
              <h3 className="text-xl font-semibold mb-2">Innovation</h3>
              <p className="text-muted-foreground">
                Nous utilisons les dernières avancées en IA pour créer du contenu 
                de qualité, unique et engageant.
              </p>
            </Card>

            <Card className="glass-card p-6">
              <Users className="w-10 h-10 text-secondary mb-4" />
              <h3 className="text-xl font-semibold mb-2">Accessibilité</h3>
              <p className="text-muted-foreground">
                Notre plateforme est conçue pour être simple d'utilisation, 
                même sans compétences techniques.
              </p>
            </Card>

            <Card className="glass-card p-6">
              <Zap className="w-10 h-10 text-accent mb-4" />
              <h3 className="text-xl font-semibold mb-2">Efficacité</h3>
              <p className="text-muted-foreground">
                Gagnez des heures chaque semaine grâce à notre système 
                d'automatisation intelligent.
              </p>
            </Card>
          </div>

          {/* Figures we can evidence, from src/lib/testimonials.ts — which
              ships empty. This block used to state active users, posts
              generated and a satisfaction rate, all invented, for a product
              that had not yet had its first user. */}
          {PLATFORM_STATS.length > 0 && (
            <div className="glass-card p-8 md:p-12 rounded-2xl text-center">
              <h2 className="text-2xl font-bold mb-8">Pro Social AI en chiffres</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                {PLATFORM_STATS.map((stat) => (
                  <div key={stat.label}>
                    <p className="text-4xl font-bold gradient-text">{stat.value}</p>
                    <p className="text-muted-foreground">{stat.label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
