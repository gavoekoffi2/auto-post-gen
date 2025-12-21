import { Navbar } from "@/components/Navbar";
import { HeroNew } from "@/components/landing/HeroNew";
import { FeaturesNew } from "@/components/landing/FeaturesNew";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { TestimonialsNew } from "@/components/landing/TestimonialsNew";
import { PricingNew } from "@/components/landing/PricingNew";
import { CTASection } from "@/components/landing/CTASection";
import { Footer } from "@/components/Footer";

const Index = () => {
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
