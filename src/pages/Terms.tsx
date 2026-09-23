import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { formatLegalDate } from "@/lib/legal";
import { TRIAL_DAYS } from "@/lib/plans";

export default function Terms() {
  return (
    <div className="min-h-screen py-12 px-4">
      <div className="container mx-auto max-w-3xl">
        <Link to="/">
          <Button variant="ghost" size="sm" className="mb-8">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Retour à l'accueil
          </Button>
        </Link>

        <h1 className="text-4xl font-bold mb-8">Conditions d'utilisation</h1>

        <div className="prose prose-invert max-w-none space-y-6 text-muted-foreground">
          <p>Dernière mise à jour : {formatLegalDate()}</p>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">1. Acceptation des conditions</h2>
            <p>
              En accédant et en utilisant Pro Social AI, vous acceptez d'être lié par ces conditions d'utilisation. 
              Si vous n'acceptez pas ces conditions, veuillez ne pas utiliser notre service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">2. Description du service</h2>
            <p>
              Pro Social AI est une plateforme de génération automatique de contenu pour les réseaux sociaux 
              utilisant l'intelligence artificielle. Nous fournissons des outils pour créer, planifier 
              et publier du contenu sur différentes plateformes sociales.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">3. Compte utilisateur</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>Vous devez fournir des informations exactes lors de l'inscription</li>
              <li>Vous êtes responsable de la confidentialité de votre mot de passe</li>
              <li>Vous êtes responsable de toutes les activités sur votre compte</li>
              <li>Vous devez nous informer immédiatement de toute utilisation non autorisée</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">4. Contenu généré</h2>
            <p>
              Le contenu généré par notre IA est créé sur la base de vos paramètres et préférences. 
              Vous êtes responsable de la révision et de la validation du contenu avant publication. 
              Pro Social AI ne peut être tenu responsable du contenu publié sur vos réseaux sociaux.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">5. Propriété intellectuelle</h2>
            <p>
              Une fois généré et validé, le contenu vous appartient entièrement. Vous conservez tous 
              les droits sur le contenu publié via notre plateforme sur vos réseaux sociaux.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">6. Limitations de responsabilité</h2>
            <p>
              Pro Social AI est fourni "tel quel". Nous ne garantissons pas que le service sera 
              ininterrompu ou exempt d'erreurs. Nous ne sommes pas responsables des dommages 
              indirects résultant de l'utilisation de notre service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">7. Essai gratuit et abonnement</h2>
            <p className="mb-3">
              Chaque nouveau compte bénéficie d'un essai gratuit de {TRIAL_DAYS} jours du forfait choisi, sans
              moyen de paiement. À la fin de l'essai, la création de nouveaux contenus est suspendue jusqu'à la
              souscription d'un forfait ; les publications déjà programmées restent publiées.
            </p>
            <p className="mb-3">
              Les abonnements sont mensuels ou annuels et se règlent par Mobile Money au tarif affiché sur le
              site au moment du paiement. Le forfait est activé après vérification du paiement, pour la période
              payée. Aucun renouvellement n'est prélevé automatiquement : sans nouveau paiement à l'échéance,
              le compte revient à l'état décrit ci-dessus.
            </p>
            <p>
              Vous pouvez cesser d'utiliser le service à tout moment et supprimer votre compte depuis votre
              profil. Pour toute question relative à un paiement, contactez-nous à l'adresse ci-dessous.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">8. Résiliation</h2>
            <p>
              Nous nous réservons le droit de suspendre ou de résilier votre accès au service 
              en cas de violation de ces conditions d'utilisation.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">9. Contact</h2>
            <p>
              Pour toute question concernant ces conditions d'utilisation, contactez-nous à : 
              contact@prosocialai.com
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
