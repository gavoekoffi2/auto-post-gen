import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Check, Link2, RefreshCw, X } from "lucide-react";

type SocialMediaConnectProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  userProfile: {
    id?: string;
    connected_platforms?: string[] | null;
    [key: string]: unknown;
  } | null;
  onUpdate: () => void;
};

type ZernioAccount = {
  id?: string;
  platform?: string;
  username?: string | null;
  displayName?: string | null;
};

type ZernioStatus = {
  provisioned: boolean;
  platforms: string[];
  accounts?: ZernioAccount[];
  error?: string;
};

const ZERNIO_PLATFORMS = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "twitter", label: "X / Twitter" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "pinterest", label: "Pinterest" },
  { id: "threads", label: "Threads" },
  { id: "bluesky", label: "Bluesky" },
  { id: "reddit", label: "Reddit" },
  { id: "telegram", label: "Telegram" },
] as const;

function normalisePlatform(platform: string) {
  return platform.toLowerCase().trim();
}

export function SocialMediaConnect({
  isOpen,
  onOpenChange,
  userProfile,
  onUpdate,
}: SocialMediaConnectProps) {
  const [zernio, setZernio] = useState<ZernioStatus | null>(null);
  const [zernioLoading, setZernioLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshZernio = async () => {
    setRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke("zernio-status", {});
      if (error) throw error;

      setZernio({
        provisioned: !!data?.provisioned,
        platforms: (data?.platforms || []).map(normalisePlatform),
        accounts: data?.accounts || [],
        error: data?.error,
      });
      onUpdate();
    } catch (err) {
      console.error("zernio-status failed:", err);
      setZernio({
        provisioned: false,
        platforms: [],
        accounts: [],
        error: err instanceof Error ? err.message : "Erreur Zernio",
      });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    refreshZernio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, userProfile?.id]);

  const handleZernioConnect = async (platform: string) => {
    setZernioLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("zernio-connect", {
        body: { platform },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.connectUrl) throw new Error("Zernio n'a pas retourné de lien de connexion.");

      const popup = window.open(data.connectUrl, "zernio_connect", "width=720,height=820");
      if (!popup) {
        toast.error("Le navigateur a bloqué la fenêtre. Autorisez les popups pour ce site.");
        return;
      }

      toast.info(`Autorisez ${platform} dans la fenêtre Zernio. La liste se mettra à jour après fermeture.`);
      const interval = window.setInterval(() => {
        try {
          if (popup.closed) {
            window.clearInterval(interval);
            window.setTimeout(() => refreshZernio(), 1200);
          }
        } catch (_) {
          window.clearInterval(interval);
        }
      }, 500);
      window.setTimeout(() => window.clearInterval(interval), 10 * 60 * 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur de connexion Zernio");
    } finally {
      setZernioLoading(false);
    }
  };

  const handleZernioDisconnect = async () => {
    if (!userProfile?.id) return;
    if (!confirm("Déconnecter Zernio pour cet utilisateur ? Les publications automatiques ne partiront plus vers les réseaux sociaux.")) {
      return;
    }

    setZernioLoading(true);
    try {
      const { error } = await supabase
        .from("social_connections")
        .delete()
        .eq("user_id", userProfile.id)
        .eq("provider", "zernio");
      if (error) throw error;

      setZernio({ provisioned: false, platforms: [], accounts: [] });
      toast.success("Zernio déconnecté");
      onUpdate();
    } catch (err) {
      console.error(err);
      toast.error("Erreur lors de la déconnexion Zernio");
    } finally {
      setZernioLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Gérer vos réseaux sociaux</DialogTitle>
          <DialogDescription>
            Connexion unique via Zernio. Les anciennes options Lovable / Postiz / Ayrshare / OAuth direct ont été retirées pour éviter la confusion.
          </DialogDescription>
        </DialogHeader>

        <Card className="glass-card p-4 mt-4 border-primary/50">
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-secondary shrink-0">
              <Link2 className="w-5 h-5 text-white" />
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium">Connexion via Zernio</p>
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                  Actif
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                Zernio centralise l'autorisation et la publication vers les réseaux sociaux. Cliquez sur un réseau pour connecter le compte correspondant.
              </p>

              {zernio?.error && (
                <p className="text-xs text-destructive mt-2">Zernio : {zernio.error}</p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {ZERNIO_PLATFORMS.map((platform) => {
                  const connected = zernio?.platforms?.includes(platform.id);
                  return (
                    <Button
                      key={platform.id}
                      size="sm"
                      variant="outline"
                      disabled={zernioLoading}
                      onClick={() => handleZernioConnect(platform.id)}
                      className="glass-card"
                    >
                      {connected && <Check className="w-3 h-3 mr-1 text-green-500" />}
                      {platform.label}
                    </Button>
                  );
                })}
              </div>

              {zernio?.provisioned && zernio.platforms.length > 0 && (
                <div className="mt-4 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
                  <p className="text-sm font-medium text-green-600">Comptes connectés via Zernio</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {zernio.platforms.map((platform) => {
                      const account = zernio.accounts?.find((a) => normalisePlatform(a.platform || "") === platform);
                      return (
                        <span
                          key={platform}
                          className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 inline-flex items-center gap-1 capitalize"
                        >
                          <Check className="w-3 h-3" />
                          {platform}
                          {account?.username ? ` · @${account.username}` : account?.displayName ? ` · ${account.displayName}` : ""}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        <div className="mt-4 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={refreshZernio}
            disabled={refreshing}
            className="glass-card"
          >
            <RefreshCw className="w-4 h-4 mr-1" />
            Rafraîchir
          </Button>

          {zernio?.provisioned && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleZernioDisconnect}
              disabled={zernioLoading}
              className="glass-card text-destructive"
            >
              <X className="w-4 h-4 mr-1" />
              Déconnecter Zernio
            </Button>
          )}
        </div>

        <div className="mt-6 p-4 bg-muted/50 rounded-lg space-y-2">
          <p className="text-sm">
            <strong>Comment ça marche :</strong>{" "}
            l'utilisateur autorise ses comptes dans la fenêtre sécurisée Zernio. La plateforme stocke seulement une référence de profil Zernio dans Supabase, puis utilise Zernio pour publier les posts validés.
          </p>
          <p className="text-xs text-muted-foreground">
            Les anciennes connexions directes Lovable/OAuth, Postiz et Ayrshare ont été retirées de l'interface. La publication garde Zernio comme fournisseur prioritaire.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
