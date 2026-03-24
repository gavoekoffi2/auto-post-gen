import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, Sparkles, Loader2 } from "lucide-react";

type ValidationStatus = "loading" | "success" | "already_validated" | "error" | "invalid";

export default function ValidatePost() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<ValidationStatus>("loading");
  const [postTitle, setPostTitle] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    validateToken(token);
  }, [token]);

  const validateToken = async (tok: string) => {
    try {
      // Find the post with this token
      const { data: post, error } = await supabase
        .from("posts")
        .select("id, title, status")
        .eq("validation_token", tok)
        .maybeSingle();

      if (error || !post) {
        setStatus("invalid");
        return;
      }

      if (post.status === "validated") {
        setPostTitle(post.title);
        setStatus("already_validated");
        return;
      }

      // Validate the post
      const { error: updateError } = await supabase
        .from("posts")
        .update({ status: "validated", validation_token: null })
        .eq("id", post.id);

      if (updateError) {
        setStatus("error");
        return;
      }

      setPostTitle(post.title);
      setStatus("success");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-primary/20 via-transparent to-transparent" />

      <div className="container max-w-md relative z-10 animate-fade-in">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <span className="font-bold text-2xl">Pro Social AI</span>
        </div>

        <Card className="glass-card p-8 text-center">
          {status === "loading" && (
            <div className="space-y-4">
              <Loader2 className="w-16 h-16 mx-auto text-primary animate-spin" />
              <h2 className="text-xl font-semibold">Validation en cours…</h2>
              <p className="text-muted-foreground text-sm">Veuillez patienter</p>
            </div>
          )}

          {status === "success" && (
            <div className="space-y-4">
              <CheckCircle className="w-16 h-16 mx-auto text-green-500" />
              <h2 className="text-2xl font-bold">Post validé !</h2>
              {postTitle && (
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">«{postTitle}»</span> est maintenant approuvé et sera publié à la date prévue.
                </p>
              )}
              <Button
                className="w-full bg-gradient-to-r from-primary to-secondary mt-4"
                onClick={() => navigate("/dashboard")}
              >
                Aller au tableau de bord
              </Button>
            </div>
          )}

          {status === "already_validated" && (
            <div className="space-y-4">
              <CheckCircle className="w-16 h-16 mx-auto text-secondary" />
              <h2 className="text-2xl font-bold">Déjà validé</h2>
              <p className="text-muted-foreground">
                Ce post a déjà été validé précédemment.
              </p>
              <Button
                variant="outline"
                className="w-full glass-card mt-4"
                onClick={() => navigate("/dashboard")}
              >
                Retour au tableau de bord
              </Button>
            </div>
          )}

          {status === "invalid" && (
            <div className="space-y-4">
              <XCircle className="w-16 h-16 mx-auto text-destructive" />
              <h2 className="text-2xl font-bold">Lien invalide</h2>
              <p className="text-muted-foreground">
                Ce lien de validation est incorrect ou a expiré.
              </p>
              <Button
                variant="outline"
                className="w-full glass-card mt-4"
                onClick={() => navigate("/")}
              >
                Retour à l'accueil
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="space-y-4">
              <XCircle className="w-16 h-16 mx-auto text-destructive" />
              <h2 className="text-2xl font-bold">Erreur</h2>
              <p className="text-muted-foreground">
                Une erreur est survenue lors de la validation. Veuillez réessayer ou contacter le support.
              </p>
              <Button
                className="w-full bg-gradient-to-r from-primary to-secondary mt-4"
                onClick={() => token && validateToken(token)}
              >
                Réessayer
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
