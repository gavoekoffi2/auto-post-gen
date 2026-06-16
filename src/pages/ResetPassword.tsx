import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Sparkles, Lock, CheckCircle } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState(false);
  const [isRecovery, setIsRecovery] = useState(false);

  useEffect(() => {
    let active = true;

    // supabase-js (detectSessionInUrl + PKCE) automatically exchanges the
    // recovery link — either the legacy implicit hash (#type=recovery) or
    // the modern PKCE query (?code=...) — into a session on load. That can
    // happen before this component mounts, so the PASSWORD_RECOVERY event
    // is easy to miss. We therefore also treat an existing session on this
    // page as recovery-eligible: a normal visitor never lands here logged in.
    const detectRecovery = async () => {
      const hashType = new URLSearchParams(window.location.hash.substring(1)).get("type");
      const { data: { session } } = await supabase.auth.getSession();
      if (!active) return;
      if (session || hashType === "recovery") {
        setIsRecovery(true);
      }
    };
    detectRecovery();

    // Listen for the recovery / sign-in events too (covers the race where
    // the URL is processed just after mount).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setIsRecovery(true);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password.length < 6) {
      toast.error("Le mot de passe doit contenir au moins 6 caractères");
      return;
    }

    if (password !== confirmPassword) {
      toast.error("Les mots de passe ne correspondent pas");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });

      if (error) throw error;

      setSuccess(true);
      toast.success("Mot de passe mis à jour avec succès !");
      setTimeout(() => navigate("/auth"), 3000);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de la mise à jour du mot de passe";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-primary/20 via-transparent to-transparent" />

      <div className="container max-w-md relative z-10 animate-fade-in">
        <Link to="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <span className="font-bold text-2xl">Pro Social AI</span>
        </Link>

        <Card className="glass-card p-8">
          {success ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-secondary/20 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-secondary" />
              </div>
              <h2 className="text-xl font-bold">Mot de passe mis à jour !</h2>
              <p className="text-muted-foreground">
                Vous allez être redirigé vers la page de connexion...
              </p>
              <Link to="/auth">
                <Button variant="outline" className="mt-4">
                  Se connecter
                </Button>
              </Link>
            </div>
          ) : !isRecovery ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-destructive/20 rounded-full flex items-center justify-center mx-auto">
                <Lock className="w-8 h-8 text-destructive" />
              </div>
              <h2 className="text-xl font-bold">Lien invalide ou expiré</h2>
              <p className="text-muted-foreground">
                Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.
              </p>
              <Link to="/forgot-password">
                <Button className="mt-4 bg-gradient-to-r from-primary to-secondary">
                  Demander un nouveau lien
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="text-center mb-6">
                <h2 className="text-xl font-bold mb-2">Nouveau mot de passe</h2>
                <p className="text-muted-foreground text-sm">
                  Choisissez un nouveau mot de passe pour votre compte
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="password">Nouveau mot de passe</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    className="glass-card"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirmer le mot de passe</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
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
                  {loading ? "Mise à jour..." : "Mettre à jour le mot de passe"}
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
