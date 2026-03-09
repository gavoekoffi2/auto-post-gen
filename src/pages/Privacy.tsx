import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export default function Privacy() {
  return (
    <div className="min-h-screen py-12 px-4">
      <div className="container mx-auto max-w-3xl">
        <Link to="/">
          <Button variant="ghost" size="sm" className="mb-8">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Retour à l'accueil
          </Button>
        </Link>

        <h1 className="text-4xl font-bold mb-8">Politique de confidentialité</h1>

        <div className="prose prose-invert max-w-none space-y-6 text-muted-foreground">
          <p>Dernière mise à jour : {new Date().toLocaleDateString('fr-FR')}</p>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">1. Collecte des données</h2>
            <p>
              Nous collectons les informations que vous nous fournissez directement lors de votre inscription, 
              notamment votre adresse email, le nom de votre entreprise, et vos préférences de contenu.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">2. Utilisation des données</h2>
            <p>Vos données sont utilisées pour :</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Générer du contenu personnalisé pour vos réseaux sociaux</li>
              <li>Améliorer nos services et algorithmes d'IA</li>
              <li>Vous contacter concernant votre compte ou nos services</li>
              <li>Assurer la sécurité de notre plateforme</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">3. Protection des données</h2>
            <p>
              Nous mettons en œuvre des mesures de sécurité techniques et organisationnelles appropriées 
              pour protéger vos données personnelles contre tout accès non autorisé, modification, 
              divulgation ou destruction.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">4. Partage des données</h2>
            <p>
              Nous ne vendons pas vos données personnelles. Nous pouvons partager vos informations 
              uniquement avec des prestataires de services qui nous aident à exploiter notre plateforme, 
              sous réserve d'obligations de confidentialité strictes.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">5. Vos droits</h2>
            <p>Conformément au RGPD, vous disposez des droits suivants :</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Droit d'accès à vos données personnelles</li>
              <li>Droit de rectification de vos données</li>
              <li>Droit à l'effacement de vos données</li>
              <li>Droit à la portabilité de vos données</li>
              <li>Droit d'opposition au traitement</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">6. Contact</h2>
            <p>
              Pour toute question concernant cette politique de confidentialité ou pour exercer vos droits, 
              contactez-nous à : contact@prosocialai.com
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
