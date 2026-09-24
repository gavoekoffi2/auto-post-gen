import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkles } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { profile as profileApi } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PLAN_LIMITS, TRIAL_DAYS, isPlanId } from "@/lib/plans";

export default function Auth() {
  const navigate = useNavigate();
  const { signIn, signUp } = useSession();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Pricing CTAs link here with ?plan=<id>: the free trial starts on that
  // plan. Visitors who arrive otherwise get Pro, the plan the pricing page
  // features. The server re-validates the value.
  const [searchParams] = useSearchParams();
  const requestedPlan = searchParams.get("plan");
  const trialPlan = isPlanId(requestedPlan) ? requestedPlan : "pro";
  // Where a signed-out visitor was going (a guarded page, the "renew" link of
  // a reminder email). Internal paths only.
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const returnTo =
    from?.pathname && from.pathname.startsWith("/") && !from.pathname.startsWith("//") &&
    from.pathname !== "/auth"
      ? `${from.pathname}${from.search ?? ""}`
      : null;

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // The API creates the account and sets the session cookie in the same
      // response, so a new user lands straight in onboarding. There is no
      // email-confirmation round trip to wait on.
      await signUp(email, password, trialPlan);
      toast.success("Compte créé !");
      navigate("/onboarding");
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
      const user = await signIn(email, password);

      // Send an admin to the control plane, everyone else to their dashboard —
      // and to onboarding first if their profile is not set up yet. The role
      // comes from the server's session, not from a hard-coded email as before.
      if (user.role === "admin" || user.role === "super_admin") {
        toast.success("Connexion réussie !");
        navigate(returnTo ?? "/admin");
        return;
      }

      try {
        const profile = await profileApi.get();
        if (!profile.sector) {
          toast.success("Connexion réussie ! Veuillez compléter votre profil.");
          navigate("/onboarding");
          return;
        }
      } catch {
        // Profile unreadable for now: the dashboard's own guard will sort it.
      }

      toast.success("Connexion réussie !");
      navigate(returnTo ?? "/dashboard");
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

        <Card className="glass-card p-8">
          <Tabs defaultValue={requestedPlan || searchParams.get("mode") === "signup" ? "signup" : "signin"} className="w-full">
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
                <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm">
                  <p className="font-semibold text-green-600 dark:text-green-400">
                    Essai gratuit {TRIAL_DAYS} jours — forfait {PLAN_LIMITS[trialPlan].label}
                  </p>
                  <p className="text-muted-foreground">
                    Sans carte bancaire, sans prélèvement automatique.
                  </p>
                </div>
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
                    minLength={8}
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

        <p className="text-center mt-8 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-primary transition-colors">
            ← Retour à l'accueil
          </Link>
        </p>
      </div>
    </div>
  );
}
