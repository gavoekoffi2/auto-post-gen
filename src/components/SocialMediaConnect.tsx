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
import { Check, ExternalLink, Globe, Sparkles, X, Zap } from "lucide-react";

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
  platform: string;
  provider?: string | null;
  account_username: string | null;
  account_name: string | null;
  token_expires_at: string | null;
  profile_key?: string | null;
};

type AyrshareStatus = {
  provisioned: boolean;
  platforms: string[];
  mode?: "business" | "shared";
  error?: string;
};

interface PlatformDef {
  id: PlatformId;
  label: string;
  icon: string;
  // "available": OAuth start endpoint exists and the platform's API works
  // for posting today. "unavailable": API not usable yet (TikTok content
  // posting is restricted).
  status: "available" | "unavailable";
  // Which oauth-start-* edge function to call. For Meta we cover both
  // Facebook and Instagram through the same flow.
  oauthEndpoint?: string;
  note?: string;
  helpUrl?: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: "linkedin",
    label: "LinkedIn",
    icon: "in",
    status: "available",
    oauthEndpoint: "oauth-start-linkedin",
    helpUrl:
      "https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api",
  },
  {
    id: "facebook",
    label: "Facebook",
    icon: "fb",
    status: "available",
    oauthEndpoint: "oauth-start-meta",
    note: "Connecte une ou plusieurs Pages Facebook (publication via API officielle Meta).",
    helpUrl: "https://developers.facebook.com/docs/pages-api",
  },
  {
    id: "instagram",
    label: "Instagram",
    icon: "ig",
    status: "available",
    oauthEndpoint: "oauth-start-meta",
    note: "La connexion Meta active aussi les comptes Instagram Business liés à une Page Facebook.",
    helpUrl: "https://developers.facebook.com/docs/instagram-api",
  },
  {
    id: "twitter",
    label: "Twitter (X)",
    icon: "X",
    status: "available",
    oauthEndpoint: "oauth-start-twitter",
    note: "Nécessite un compte développeur X. La publication ne supporte pas les images dans cette version.",
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

async function buildOAuthStartUrl(endpoint: string): Promise<string | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !anonKey) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  // Pass the user's JWT as ?token=... (the browser can't add custom
  // headers on a popup navigation) and the anon key as ?apikey=... so
  // Supabase's gateway lets the request through.
  const url = new URL(`${supabaseUrl}/functions/v1/${endpoint}`);
  url.searchParams.set("apikey", anonKey);
  url.searchParams.set("token", session.access_token);
  return url.toString();
}

export function SocialMediaConnect({
  isOpen,
  onOpenChange,
  userProfile,
  onUpdate,
}: SocialMediaConnectProps) {
  const [loading, setLoading] = useState(false);
  const [connections, setConnections] = useState<SocialConnectionRow[]>([]);
  const [ayrshare, setAyrshare] = useState<AyrshareStatus | null>(null);
  const [ayrLoading, setAyrLoading] = useState(false);
  const [postiz, setPostiz] = useState<{ provisioned: boolean; platforms: string[]; error?: string } | null>(null);
  const [postizLoading, setPostizLoading] = useState(false);

  const connectionsByPlatform = useMemo(() => {
    const map: Partial<Record<PlatformId, SocialConnectionRow>> = {};
    for (const c of connections) {
      if ((c.provider ?? "direct") === "direct") {
        map[c.platform as PlatformId] = c;
      }
    }
    return map;
  }, [connections]);

  const refreshConnections = async () => {
    const { data } = await supabase
      .from("social_connections")
      .select("id, platform, provider, account_username, account_name, token_expires_at, profile_key");
    setConnections((data as SocialConnectionRow[]) || []);
    onUpdate();
  };

  const refreshAyrshare = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("ayrshare-status", {});
      if (error) {
        setAyrshare({ provisioned: false, platforms: [] });
        return;
      }
      setAyrshare({
        provisioned: !!data?.provisioned,
        platforms: data?.platforms || [],
        mode: data?.mode,
        error: data?.error,
      });
    } catch (err) {
      console.error("ayrshare-status threw:", err);
      setAyrshare({ provisioned: false, platforms: [] });
    }
  };

  const refreshPostiz = async () => {
    try {
      const { data, error } = await supabase.functions.invoke("postiz-status", {});
      if (error) {
        setPostiz({ provisioned: false, platforms: [] });
        return;
      }
      setPostiz({
        provisioned: !!data?.provisioned,
        platforms: data?.platforms || [],
        error: data?.error,
      });
    } catch (err) {
      console.error("postiz-status threw:", err);
      setPostiz({ provisioned: false, platforms: [] });
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    refreshConnections();
    refreshAyrshare();
    refreshPostiz();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, userProfile?.id]);

  const handleAyrshareConnect = async () => {
    setAyrLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ayrshare-connect", {});
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.connectUrl) throw new Error("Ayrshare n'a pas retourné de lien.");

      if (data.notice) {
        toast.info(data.notice);
      }

      const popup = window.open(
        data.connectUrl,
        "ayrshare_connect",
        "width=720,height=820",
      );
      if (!popup) {
        toast.error("Le navigateur a bloqué la fenêtre. Autorisez les popups.");
        return;
      }
      toast.info("Autorisez vos comptes dans la fenêtre Ayrshare. La liste se rafraîchira automatiquement.");

      const interval = window.setInterval(() => {
        try {
          if (popup.closed) {
            window.clearInterval(interval);
            window.setTimeout(() => {
              refreshConnections();
              refreshAyrshare();
            }, 800);
          }
        } catch (_) {
          window.clearInterval(interval);
        }
      }, 500);
      window.setTimeout(() => window.clearInterval(interval), 10 * 60 * 1000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erreur Ayrshare";
      toast.error(message);
    } finally {
      setAyrLoading(false);
    }
  };

  const handleAyrshareDisconnect = async () => {
    if (!confirm("Déconnecter Ayrshare ? Vos comptes Ayrshare ne seront plus utilisés pour publier.")) {
      return;
    }
    setAyrLoading(true);
    try {
      const { error } = await supabase
        .from("social_connections")
        .delete()
        .eq("user_id", userProfile?.id || "")
        .eq("provider", "ayrshare");
      if (error) throw error;
      toast.success("Ayrshare déconnecté");
      await refreshConnections();
      setAyrshare({ provisioned: false, platforms: [] });
    } catch (err) {
      toast.error("Erreur lors de la déconnexion");
      console.error(err);
    } finally {
      setAyrLoading(false);
    }
  };

  const handlePostizConnect = async (platform: string) => {
    setPostizLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("postiz-connect", {
        body: { platform },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.connectUrl) throw new Error("Postiz n'a pas retourné de lien.");

      const popup = window.open(data.connectUrl, "postiz_connect", "width=720,height=820");
      if (!popup) {
        toast.error("Le navigateur a bloqué la fenêtre. Autorisez les popups.");
        return;
      }
      toast.info(`Autorisez ${platform} dans la fenêtre Postiz. La liste se rafraîchira automatiquement.`);

      const interval = window.setInterval(() => {
        try {
          if (popup.closed) {
            window.clearInterval(interval);
            window.setTimeout(() => refreshPostiz(), 800);
          }
        } catch (_) {
          window.clearInterval(interval);
        }
      }, 500);
      window.setTimeout(() => window.clearInterval(interval), 10 * 60 * 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur Postiz");
    } finally {
      setPostizLoading(false);
    }
  };

  const handleConnect = async (platform: PlatformDef) => {
    if (platform.status === "unavailable" || !platform.oauthEndpoint) {
      toast.error(`${platform.label}: connexion non disponible pour le moment.`);
      return;
    }

    const startUrl = await buildOAuthStartUrl(platform.oauthEndpoint);
    if (!startUrl) {
      toast.error("Vous devez être connecté pour relier un compte.");
      return;
    }

    // Open OAuth in a popup. Note: noopener prevents us from reading
    // popup.closed, so we open without it and watch for the popup
    // to close, then refresh.
    const popup = window.open(startUrl, "social_oauth", "width=600,height=720");
    if (!popup) {
      toast.error("Le navigateur a bloqué la fenêtre. Autorisez les popups pour ce site.");
      return;
    }
    toast.info(
      `Autorisez ${platform.label} dans la nouvelle fenêtre. La liste se rafraîchira automatiquement.`,
    );

    const interval = window.setInterval(() => {
      try {
        if (popup.closed) {
          window.clearInterval(interval);
          // Give Supabase a moment to propagate the upsert, then refetch.
          window.setTimeout(() => {
            refreshConnections();
          }, 600);
        }
      } catch (_) {
        window.clearInterval(interval);
      }
    }, 500);
    // Hard stop after 10 minutes in case the user abandons.
    window.setTimeout(() => window.clearInterval(interval), 10 * 60 * 1000);
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
            Deux options: connexion rapide via Ayrshare (un seul clic pour tout)
            ou OAuth officiel plateforme par plateforme.
          </DialogDescription>
        </DialogHeader>

        {/* Ayrshare quick-connect (recommended for MVP) */}
        <Card className="glass-card p-4 mt-4 border-primary/40">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-secondary">
                <Zap className="w-5 h-5 text-white" />
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">Connexion rapide (Ayrshare)</p>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                    Recommandé
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 max-w-md">
                  Un seul clic pour relier Instagram, Facebook, LinkedIn, X, TikTok,
                  YouTube, Pinterest, Threads, Bluesky en une seule fois. Ayrshare
                  gère toutes les autorisations à votre place.
                </p>
                {ayrshare?.provisioned && ayrshare.platforms.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {ayrshare.platforms.map((p) => (
                      <span
                        key={p}
                        className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 inline-flex items-center gap-1"
                      >
                        <Check className="w-3 h-3" />
                        {p}
                      </span>
                    ))}
                  </div>
                )}
                {ayrshare?.error && (
                  <p className="text-xs text-destructive mt-2">
                    Erreur Ayrshare: {ayrshare.error}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <Button
                size="sm"
                onClick={handleAyrshareConnect}
                disabled={ayrLoading}
                className="bg-gradient-to-r from-primary to-secondary"
              >
                <Sparkles className="w-4 h-4 mr-1" />
                {ayrshare?.provisioned ? "Ajouter / gérer" : "Connecter en 1 clic"}
              </Button>
              {ayrshare?.provisioned && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAyrshareDisconnect}
                  disabled={ayrLoading}
                  className="glass-card"
                >
                  Déconnecter
                </Button>
              )}
            </div>
          </div>
        </Card>

        {/* Postiz quick-connect (the platform from the reference video) */}
        <Card className="glass-card p-4 mt-3 border-secondary/40">
          <div className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-secondary to-primary shrink-0">
              <Globe className="w-5 h-5 text-white" />
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium">Connexion via Postiz</p>
                <span className="text-xs px-2 py-0.5 rounded-full bg-secondary/10 text-secondary">
                  Planification 30+ réseaux
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                Reliez vos réseaux via Postiz (publication + planification). Cliquez
                sur un réseau pour l'autoriser dans une fenêtre sécurisée.
              </p>
              {postiz?.error && (
                <p className="text-xs text-destructive mt-2">Postiz: {postiz.error}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {(["instagram", "facebook", "linkedin", "twitter", "tiktok", "youtube"] as const).map(
                  (p) => {
                    const connected = postiz?.platforms?.includes(p);
                    return (
                      <Button
                        key={p}
                        size="sm"
                        variant="outline"
                        disabled={postizLoading}
                        onClick={() => handlePostizConnect(p)}
                        className="glass-card capitalize"
                      >
                        {connected && <Check className="w-3 h-3 mr-1 text-green-500" />}
                        {p}
                      </Button>
                    );
                  },
                )}
              </div>
            </div>
          </div>
        </Card>

        <div className="my-4 flex items-center gap-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-muted-foreground">ou OAuth officiel par plateforme</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        <div className="space-y-4">
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

        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={refreshConnections}
            className="glass-card"
          >
            Rafraîchir
          </Button>
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
