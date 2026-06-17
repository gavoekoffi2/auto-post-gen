import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, MailCheck, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

export default function Auth() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/onboarding`,
        },
      });

      if (error) throw error;

      if (data.session) {
        // Email confirmation is disabled: the user is signed in right away.
        toast.success("Compte créé !");
        navigate("/onboarding");
      } else {
        // Email confirmation is enabled: there is no session yet, so we
        // must NOT navigate to a protected route (it would bounce back to
        // /auth). Show a real confirmation screen instead of leaving the
        // user on the same form with only a temporary toast.
        setConfirmationEmail(email);
        setPassword("");
        toast.success("Compte créé ! Confirmez votre email pour continuer.");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de l'inscription";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { data: authData, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      // Check if user has completed onboarding
      if (authData.user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('sector, description')
          .eq('id', authData.user.id)
          .maybeSingle();

        // If profile doesn't exist or is incomplete, redirect to onboarding
        if (!profile || !profile.sector) {
          toast.success("Connexion réussie ! Veuillez compléter votre profil.");
          navigate("/onboarding");
          return;
        }
      }

      toast.success("Connexion réussie !");
      navigate("/dashboard");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de la connexion";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-primary/20 via-transparent to-transparent animate-glow" />
      
      <div className="container max-w-md relative z-10 animate-fade-in">
        <Link to="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <span className="font-bold text-2xl">Pro Social AI</span>
        </Link>

        {confirmationEmail ? (
          <Card className="glass-card p-8 text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-r from-primary to-secondary">
              <MailCheck className="h-9 w-9 text-white" />
            </div>
            <h1 className="text-2xl font-bold mb-3">Confirmez votre email</h1>
            <p className="text-muted-foreground mb-4">
              Votre compte a bien été créé. Nous avons envoyé un lien de confirmation à :
            </p>
            <p className="rounded-lg border border-border/60 bg-muted/40 px-4 py-3 font-medium break-all mb-5">
              {confirmationEmail}
            </p>
            <div className="space-y-3 text-left text-sm text-muted-foreground mb-6">
              <p className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                Ouvrez votre boîte mail et cliquez sur le lien de confirmation.
              </p>
              <p className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                Après confirmation, revenez ici et connectez-vous.
              </p>
              <p className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                Pensez aussi à vérifier vos spams ou promotions.
              </p>
            </div>
            <Button
              className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90"
              onClick={() => setConfirmationEmail("")}
            >
              J’ai confirmé mon email — me connecter
            </Button>
          </Card>
        ) : (
        <Card className="glass-card p-8">
          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-8">
              <TabsTrigger value="signin">Connexion</TabsTrigger>
              <TabsTrigger value="signup">Inscription</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="votre@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="glass-card"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Mot de passe</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="glass-card"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90"
                  disabled={loading}
                >
                  {loading ? "Connexion..." : "Se connecter"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="votre@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="glass-card"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="signup-password">Mot de passe</Label>
                  <Input
                    id="signup-password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    className="glass-card"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90"
                  disabled={loading}
                >
                  {loading ? "Création..." : "Créer mon compte"}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  En créant un compte, vous acceptez nos conditions d'utilisation
                </p>
              </form>
            </TabsContent>
          </Tabs>

          <div className="mt-4 text-center">
            <Link to="/forgot-password" className="text-sm text-muted-foreground hover:text-primary transition-colors">
              Mot de passe oublié ?
            </Link>
          </div>
        </Card>
        )}

        <p className="text-center mt-8 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-primary transition-colors">
            ← Retour à l'accueil
          </Link>
        </p>
      </div>
    </div>
  );
}
