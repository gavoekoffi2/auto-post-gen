import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type Status = "confirm" | "loading" | "success" | "error";

export default function ValidatePost() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<Status>(token ? "confirm" : "error");
  const [message, setMessage] = useState<string>(
    token ? "" : "Lien invalide: jeton manquant.",
  );

  // Validation only runs on an explicit click — never automatically on page
  // load — so email link-scanners / prefetchers can't silently validate a post.
  const validate = async () => {
    if (!token) return;
    setStatus("loading");
    try {
      const { data, error } = await supabase.functions.invoke("validate-post", {
        body: { token },
      });
      if (error) {
        setStatus("error");
        setMessage(error.message || "Erreur de validation.");
        return;
      }
      if (data?.success) {
        setStatus("success");
        setMessage("Votre post est validé et sera publié à la date prévue.");
      } else {
        setStatus("error");
        setMessage(data?.error || "Validation refusée.");
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Erreur inattendue.");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="container max-w-md">
        <Link to="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <span className="font-bold text-2xl">Pro Social AI</span>
        </Link>

        <Card className="glass-card p-8 text-center space-y-4">
          {status === "confirm" && (
            <>
              <CheckCircle2 className="w-12 h-12 mx-auto text-primary" />
              <h1 className="text-xl font-bold">Valider ce post ?</h1>
              <p className="text-muted-foreground text-sm">
                Cliquez pour confirmer la validation. Le post sera publié à la date prévue.
              </p>
              <Button onClick={validate} className="bg-gradient-to-r from-primary to-secondary">
                Valider mon post
              </Button>
            </>
          )}
          {status === "loading" && (
            <>
              <Loader2 className="w-12 h-12 mx-auto animate-spin text-primary" />
              <h1 className="text-xl font-bold">Validation en cours…</h1>
            </>
          )}
          {status === "success" && (
            <>
              <CheckCircle2 className="w-12 h-12 mx-auto text-green-500" />
              <h1 className="text-xl font-bold">Post validé</h1>
              <p className="text-muted-foreground text-sm">{message}</p>
              <Link to="/dashboard">
                <Button className="bg-gradient-to-r from-primary to-secondary">
                  Ouvrir le tableau de bord
                </Button>
              </Link>
            </>
          )}
          {status === "error" && (
            <>
              <XCircle className="w-12 h-12 mx-auto text-destructive" />
              <h1 className="text-xl font-bold">Validation impossible</h1>
              <p className="text-muted-foreground text-sm">{message}</p>
              <Link to="/dashboard">
                <Button variant="outline" className="glass-card">
                  Retour au tableau de bord
                </Button>
              </Link>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
