import { useEffect, useMemo, useState } from "react";
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
import { Check, ExternalLink, X } from "lucide-react";

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

type PlatformId = "instagram" | "facebook" | "twitter" | "linkedin" | "tiktok";

type SocialConnectionRow = {
  id: string;
  platform: PlatformId;
  account_username: string | null;
  account_name: string | null;
  token_expires_at: string | null;
};

interface PlatformDef {
  id: PlatformId;
  label: string;
  icon: string;
  status: "available" | "manual" | "unavailable";
  note?: string;
  helpUrl?: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "linkedin",
    label: "LinkedIn",
    icon: "in",
    status: "available",
    helpUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api",
  },
  {
    id: "facebook",
    label: "Facebook",
    icon: "fb",
    status: "available",
    note: "Connecte une Page Facebook (Pages publiques uniquement). Nécessite un compte Meta Developers et la review de l'app.",
    helpUrl: "https://developers.facebook.com/docs/pages-api",
  },
  {
    id: "instagram",
    label: "Instagram",
    icon: "ig",
    status: "available",
    note: "Requiert un compte Instagram Business lié à une Page Facebook (Instagram Graph API).",
    helpUrl: "https://developers.facebook.com/docs/instagram-api",
  },
  {
    id: "twitter",
    label: "Twitter (X)",
    icon: "X",
    status: "manual",
    note: "L'API X est payante et son OAuth nécessite une app validée. Non activé par défaut.",
    helpUrl: "https://developer.twitter.com/en/docs/twitter-api",
  },
  {
    id: "tiktok",
    label: "TikTok",
    icon: "TT",
    status: "unavailable",
    note: "L'API de publication TikTok est en accès restreint. Demande un partenariat TikTok.",
    helpUrl: "https://developers.tiktok.com/doc/content-posting-api",
  },
];

function buildOAuthStartUrl(platform: PlatformId): string | null {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) return null;
  // OAuth start endpoints should be implemented as edge functions
  // (oauth-start-<platform>) that redirect to the platform's authorize
  // URL with the right client_id/redirect_uri. Until those edge
  // functions are deployed, we surface the absence to the user instead
  // of silently failing.
  return `${supabaseUrl}/functions/v1/oauth-start-${platform}`;
}

export function SocialMediaConnect({
  isOpen,
  onOpenChange,
  userProfile,
  onUpdate,
}: SocialMediaConnectProps) {
  const [loading, setLoading] = useState(false);
  const [connections, setConnections] = useState<SocialConnectionRow[]>([]);

  const connectionsByPlatform = useMemo(() => {
    const map: Partial<Record<PlatformId, SocialConnectionRow>> = {};
    for (const c of connections) {
      map[c.platform] = c;
    }
    return map;
  }, [connections]);

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from("social_connections")
          .select("id, platform, account_username, account_name, token_expires_at");
        if (error) throw error;
        setConnections((data as SocialConnectionRow[]) || []);
      } catch (err) {
        console.error("Failed to load social connections", err);
      }
    };
    load();
  }, [isOpen, userProfile?.id]);

  const handleConnect = async (platform: PlatformDef) => {
    if (platform.status === "unavailable") {
      toast.error(`${platform.label}: connexion non disponible pour le moment.`);
      return;
    }

    const startUrl = buildOAuthStartUrl(platform.id);
    if (!startUrl) {
      toast.error("Configuration manquante. Contactez le support.");
      return;
    }

    // We open the OAuth flow in a new tab. The callback edge function
    // is expected to upsert into social_connections and close the tab.
    window.open(startUrl, "_blank", "noopener,noreferrer");
    toast.info(
      `Une nouvelle fenêtre s'est ouverte pour autoriser ${platform.label}. Revenez ici une fois terminé.`,
    );
  };

  const handleDisconnect = async (platform: PlatformDef) => {
    const connection = connectionsByPlatform[platform.id];
    if (!connection) return;

    setLoading(true);
    try {
      const { error } = await supabase
        .from("social_connections")
        .delete()
        .eq("id", connection.id);
      if (error) throw error;

      // Also remove the legacy mirror in profiles for backward compat.
      const updates: Record<string, string | null | string[]> = {
        [`${platform.id}_username`]: null,
      };
      const currentConnected =
        (userProfile?.connected_platforms as string[] | undefined) || [];
      updates.connected_platforms = currentConnected.filter(
        (p) => p.toLowerCase() !== platform.id,
      );

      if (userProfile?.id) {
        await supabase.from("profiles").update(updates).eq("id", userProfile.id);
      }

      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
      toast.success(`${platform.label} déconnecté`);
      onUpdate();
    } catch (err) {
      console.error(err);
      toast.error("Erreur lors de la déconnexion");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Gérer vos réseaux sociaux</DialogTitle>
          <DialogDescription>
            Connectez vos comptes via OAuth officiel. La publication automatique
            n'est possible que pour les comptes effectivement reliés ici.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {PLATFORMS.map((platform) => {
            const connection = connectionsByPlatform[platform.id];
            const isConnected = !!connection;
            const isUnavailable = platform.status === "unavailable";
            return (
              <Card key={platform.id} className="glass-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-muted text-xs font-bold">
                      {platform.icon}
                    </span>
                    <div>
                      <p className="font-medium">{platform.label}</p>
                      {isConnected ? (
                        <p className="text-sm text-muted-foreground">
                          {connection.account_username
                            ? `@${connection.account_username}`
                            : connection.account_name || "Compte connecté"}
                        </p>
                      ) : (
                        platform.note && (
                          <p className="text-xs text-muted-foreground max-w-md">
                            {platform.note}
                          </p>
                        )
                      )}
                      {platform.helpUrl && (
                        <a
                          href={platform.helpUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs inline-flex items-center gap-1 text-primary hover:underline mt-1"
                        >
                          Documentation officielle
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isConnected ? (
                      <>
                        <div className="flex items-center gap-1 text-green-500">
                          <Check className="w-4 h-4" />
                          <span className="text-sm">Connecté</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDisconnect(platform)}
                          disabled={loading}
                          className="glass-card"
                        >
                          <X className="w-4 h-4 mr-1" />
                          Déconnecter
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={isUnavailable}
                        onClick={() => handleConnect(platform)}
                        className="bg-gradient-to-r from-primary to-secondary"
                      >
                        {isUnavailable ? "Indisponible" : "Connecter"}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        <div className="mt-6 p-4 bg-muted/50 rounded-lg space-y-2">
          <p className="text-sm">
            <strong>Comment ça marche :</strong>{" "}
            la connexion utilise les OAuth officiels des plateformes. Vos
            identifiants ne sont jamais demandés ni stockés ici – seuls les jetons
            d'accès délivrés par la plateforme sont conservés (chiffrés au repos
            par Supabase).
          </p>
          <p className="text-xs text-muted-foreground">
            Le déploiement de chaque OAuth nécessite la création d'une app
            développeur sur la plateforme (Meta Developers, LinkedIn Developers,
            etc.) et la configuration des variables d'environnement{" "}
            <code>OAUTH_*</code> côté Supabase. Voir DEPLOYMENT.md.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
