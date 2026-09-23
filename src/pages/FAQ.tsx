import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { PLAN_LIMITS, PLAN_PRICES_FCFA, TRIAL_DAYS } from "@/lib/plans";

// Every answer describes what this build actually does. The previous copy
// promised validation emails (this API sends none), TikTok (not publishable),
// "1 à 7 posts selon l'abonnement" (the plans are 3 / 7 / 10) and an
// "espace client" to cancel from that did not exist.
const faqs = [
  {
    question: "Comment fonctionne l'essai gratuit ?",
    answer: `Vous profitez pendant ${TRIAL_DAYS} jours de toutes les fonctionnalités du forfait choisi, sans carte bancaire. Un email vous prévient avant la fin. Si vous ne choisissez pas de forfait, la création de nouveaux contenus se met simplement en pause : rien n'est facturé et vos posts déjà programmés sont quand même publiés.`,
  },
  {
    question: "Comment payer mon abonnement ?",
    answer: `Par Mobile Money (Wave, Orange Money, MTN ou Moov), depuis la page Abonnement de votre compte : vous choisissez votre forfait, payez le montant indiqué (à partir de ${PLAN_PRICES_FCFA.starter.monthly.toLocaleString("fr-FR")} FCFA/mois pour ${PLAN_LIMITS.starter.label}) puis saisissez la référence de la transaction reçue par SMS. Votre forfait est activé après vérification, généralement sous 24 h ouvrées, et vous êtes prévenu par email.`,
  },
  {
    question: "Puis-je arrêter quand je veux ?",
    answer:
      "Oui. Il n'y a aucun prélèvement automatique : chaque mois (ou chaque année), vous décidez de renouveler ou non. Un rappel vous est envoyé quelques jours avant l'échéance. Sans renouvellement, vos contenus restent accessibles et vos posts déjà programmés sont publiés.",
  },
  {
    question: "Comment fonctionne la génération automatique de contenu ?",
    answer:
      "L'IA part de votre profil d'entreprise (secteur, ton, description, cibles) et prépare chaque semaine le nombre de posts que vous avez choisi, selon le mix conseil / information / promotion que vous avez fixé. Ils apparaissent dans votre tableau de bord, où vous les relisez avant publication.",
  },
  {
    question: "Sur quels réseaux sociaux puis-je publier ?",
    answer:
      "LinkedIn, Facebook, Instagram et X (Twitter). Le nombre de comptes que vous pouvez connecter dépend de votre forfait.",
  },
  {
    question: "Puis-je modifier le contenu généré ?",
    answer:
      "Oui. Avant publication, vous pouvez modifier le texte, régénérer le texte ou l'affiche, changer la date, ou supprimer le post.",
  },
  {
    question: "Comment fonctionne la bibliothèque d'images personnalisées ?",
    answer:
      "Vous pouvez envoyer vos propres images (logos, photos produits, etc.) depuis votre profil. Si l'option est activée, elles sont utilisées pour vos posts plutôt que des visuels générés.",
  },
  {
    question: "Quelle est la fréquence de publication ?",
    answer: `Vous choisissez votre fréquence, jusqu'à la limite de votre forfait : ${PLAN_LIMITS.starter.postsPerWeek} posts par semaine en ${PLAN_LIMITS.starter.label}, ${PLAN_LIMITS.pro.postsPerWeek} en ${PLAN_LIMITS.pro.label} et ${PLAN_LIMITS.enterprise.postsPerWeek} en ${PLAN_LIMITS.enterprise.label}. Vous définissez aussi vos jours et votre heure de publication préférés.`,
  },
  {
    question: "Le contenu est-il vraiment personnalisé ?",
    answer:
      "Oui. L'IA prend en compte votre secteur d'activité, votre ton, la description de votre entreprise, vos cibles et vos exemples de style.",
  },
  {
    question: "Les posts sont-ils publiés automatiquement ?",
    answer:
      "Par défaut, les posts attendent votre validation. Vous pouvez activer la publication automatique dans vos paramètres si vous préférez un fonctionnement entièrement automatique.",
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
              Tout ce que vous devez savoir sur Pro Social AI
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
