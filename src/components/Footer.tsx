import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

export const Footer = () => {
  return (
    <footer className="border-t border-border/50 bg-background/50 backdrop-blur-sm">
      <div className="container mx-auto max-w-7xl px-4 py-12">
        <div className="grid md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <span className="font-bold text-xl">Pro Social AI</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Automatisez votre création de contenu sur les réseaux sociaux avec l'intelligence artificielle.
            </p>
          </div>

          {/* Product */}
          <div>
            <h3 className="font-semibold mb-4">Produit</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="/#features" className="hover:text-primary transition-colors">Fonctionnalités</a>
              </li>
              <li>
                <a href="/#pricing" className="hover:text-primary transition-colors">Tarifs</a>
              </li>
              <li>
                <Link to="/faq" className="hover:text-primary transition-colors">FAQ</Link>
              </li>
              <li>
                <Link to="/auth" className="hover:text-primary transition-colors">Commencer</Link>
              </li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="font-semibold mb-4">Entreprise</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/about" className="hover:text-primary transition-colors">À propos</Link>
              </li>
              <li>
                <Link to="/contact" className="hover:text-primary transition-colors">Contact</Link>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-semibold mb-4">Légal</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/privacy" className="hover:text-primary transition-colors">Politique de confidentialité</Link>
              </li>
              <li>
                <Link to="/terms" className="hover:text-primary transition-colors">Conditions d'utilisation</Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border/50 mt-8 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Pro Social AI. Tous droits réservés.
          </p>
          <div className="flex gap-4">
            <a 
              href="https://twitter.com/prosocialai" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              Twitter
            </a>
            <a 
              href="https://linkedin.com/company/prosocialai" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              LinkedIn
            </a>
            <a 
              href="https://instagram.com/prosocialai" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              Instagram
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
