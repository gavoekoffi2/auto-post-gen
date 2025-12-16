import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    question: "Comment fonctionne la génération automatique de contenu ?",
    answer:
      "Notre IA analyse votre profil d'entreprise (secteur, ton, description) et génère automatiquement des posts personnalisés chaque semaine. Vous recevez un email de validation avant publication.",
  },
  {
    question: "Sur quels réseaux sociaux puis-je publier ?",
    answer:
      "ContentAI supporte Instagram, Facebook, Twitter/X, LinkedIn et TikTok. Vous pouvez sélectionner les plateformes de votre choix dans votre profil.",
  },
  {
    question: "Puis-je modifier le contenu généré ?",
    answer:
      "Oui ! Avant chaque publication, vous recevez un email de validation. Vous pouvez approuver, modifier ou rejeter le contenu proposé.",
  },
  {
    question: "Comment fonctionne la bibliothèque d'images personnalisées ?",
    answer:
      "Vous pouvez uploader vos propres images (logos, photos produits, etc.) dans votre profil. Si l'option est activée, l'IA utilisera vos images plutôt que d'en générer de nouvelles.",
  },
  {
    question: "Quelle est la fréquence de publication ?",
    answer:
      "Vous choisissez votre fréquence : de 1 à 7 posts par semaine selon votre abonnement. Vous pouvez aussi définir vos jours de publication préférés.",
  },
  {
    question: "Le contenu est-il vraiment personnalisé ?",
    answer:
      "Absolument ! L'IA prend en compte votre secteur d'activité, votre ton préféré, la description de votre entreprise et même vos exemples de style pour créer du contenu unique et cohérent avec votre marque.",
  },
  {
    question: "Puis-je annuler mon abonnement ?",
    answer:
      "Oui, vous pouvez annuler à tout moment depuis votre espace client. Votre accès reste actif jusqu'à la fin de votre période de facturation.",
  },
  {
    question: "Les posts sont-ils publiés automatiquement ?",
    answer:
      "Par défaut, les posts nécessitent votre validation. Vous pouvez activer la publication automatique dans vos paramètres si vous préférez un fonctionnement 100% automatique.",
  },
];

export default function FAQ() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      
      <main className="flex-1 pt-24 pb-16">
        <div className="container mx-auto max-w-3xl px-4">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold mb-4">
              Questions <span className="gradient-text">fréquentes</span>
            </h1>
            <p className="text-muted-foreground">
              Tout ce que vous devez savoir sur ContentAI
            </p>
          </div>

          <Accordion type="single" collapsible className="space-y-4">
            {faqs.map((faq, index) => (
              <AccordionItem
                key={index}
                value={`item-${index}`}
                className="glass-card border border-border/50 rounded-lg px-6"
              >
                <AccordionTrigger className="text-left hover:no-underline">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>

          <div className="mt-12 text-center glass-card p-8 rounded-2xl">
            <h2 className="text-xl font-semibold mb-2">
              Vous avez d'autres questions ?
            </h2>
            <p className="text-muted-foreground mb-4">
              Notre équipe est là pour vous aider
            </p>
            <a
              href="/contact"
              className="inline-flex items-center justify-center px-6 py-3 bg-gradient-to-r from-primary to-secondary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
            >
              Contactez-nous
            </a>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
