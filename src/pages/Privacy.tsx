import { ArrowLeft } from "lucide-react";
import { SUPPORT_EMAIL, formatLegalDate } from "@/lib/appConfig";
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
          <p>Dernière mise à jour : {formatLegalDate()}</p>

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

          {/* Les destinataires listés ici sont ceux que le code appelle
              réellement (voir supabase/functions/). Le RGPD (art. 13) impose
              d'informer sur les destinataires et les transferts hors UE : une
              mention générique « des prestataires de services » ne le fait
              pas, surtout pour un produit qui envoie la description de
              l'activité du client à des fournisseurs d'IA tiers. Mettez cette
              liste à jour en même temps que les intégrations, et faites-la
              relire avant le lancement commercial. */}
          <section>
            <h2 className="text-2xl font-semibold text-foreground mb-4">4. Partage des données</h2>
            <p>
              Nous ne vendons pas vos données personnelles. Nous faisons appel aux
              sous-traitants suivants, strictement pour faire fonctionner le service :
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong>Supabase</strong> — hébergement de la base de données, de
                l'authentification et des fichiers que vous téléversez (logo, images).
              </li>
              <li>
                <strong>OpenRouter</strong> (et le modèle d'IA qu'il achemine) — reçoit la
                description de votre activité, vos cibles et vos posts précédents afin de
                rédiger vos publications.
              </li>
              <li>
                <strong>Graphiste GPT</strong> — reçoit le texte du post, votre charte
                graphique et votre logo afin de générer l'affiche associée.
              </li>
              <li>
                <strong>Zernio</strong> — reçoit les posts que vous validez ainsi que
                l'autorisation d'accès à vos comptes sociaux, afin de les publier.
              </li>
              <li>
                <strong>Resend</strong> — reçoit votre adresse email pour l'envoi des
                emails de validation et des réponses du formulaire de contact.
              </li>
            </ul>
            <p className="mt-4">
              Certains de ces prestataires sont établis hors de l'Union européenne ; les
              données concernées peuvent donc y être transférées et traitées.
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
              contactez-nous à : {SUPPORT_EMAIL}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
