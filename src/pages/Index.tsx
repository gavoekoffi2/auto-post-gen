import { Navbar } from "@/components/Navbar";
import { HeroNew } from "@/components/landing/HeroNew";
import { FeaturesNew } from "@/components/landing/FeaturesNew";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { TestimonialsNew } from "@/components/landing/TestimonialsNew";
import { PricingNew } from "@/components/landing/PricingNew";
import { CTASection } from "@/components/landing/CTASection";
import { Footer } from "@/components/Footer";
import { usePageMeta } from "@/lib/usePageMeta";

const Index = () => {
  usePageMeta("Publication automatisée sur les réseaux sociaux", "Générez, planifiez et publiez vos posts réseaux sociaux avec l'IA. Essai gratuit, sans carte bancaire.");

  return (
    <div className="min-h-screen">
      <Navbar />
      <HeroNew />
      <FeaturesNew />
      <HowItWorks />
      <TestimonialsNew />
      <PricingNew />
      <CTASection />
      <Footer />
    </div>
  );
};

export default Index;
