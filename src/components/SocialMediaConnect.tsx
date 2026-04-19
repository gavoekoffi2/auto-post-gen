import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Check, RefreshCw, ExternalLink, Info, KeyRound } from "lucide-react";

type SocialMediaConnectProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  userProfile: any;
  onUpdate: () => void;
};

type PostizIntegration = {
  id: string;
  name?: string;
  identifier?: string;
  picture?: string;
  providerIdentifier?: string;
  disabled?: boolean;
};

// Platforms we advertise in the UI + the Postiz provider keys they map to.
const PLATFORMS = [
  { label: "Instagram", icon: "📷", providers: ["instagram", "instagram-standalone"] },
  { label: "Facebook", icon: "👤", providers: ["facebook"] },
  { label: "Twitter (X)", icon: "🐦", providers: ["x", "twitter"] },
  { label: "LinkedIn", icon: "💼", providers: ["linkedin", "linkedin-page"] },
  { label: "TikTok", icon: "🎵", providers: ["tiktok"] },
  { label: "YouTube", icon: "▶️", providers: ["youtube"] },
  { label: "Pinterest", icon: "📌", providers: ["pinterest"] },
  { label: "Threads", icon: "🧵", providers: ["threads"] },
  { label: "Bluesky", icon: "🦋", providers: ["bluesky"] },
];

export function SocialMediaConnect({
  isOpen,
  onOpenChange,
  userProfile,
  onUpdate,
}: SocialMediaConnectProps) {
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.postiz.com/public/v1");
  const [integrations, setIntegrations] = useState<PostizIntegration[]>([]);
  const [showKeyField, setShowKeyField] = useState(false);

  useEffect(() => {
    if (userProfile) {
      setApiKey(userProfile.postiz_api_key || "");
      setBaseUrl(
        userProfile.postiz_base_url || "https://api.postiz.com/public/v1",
      );
      setIntegrations(
        Array.isArray(userProfile.postiz_integrations)
          ? (userProfile.postiz_integrations as PostizIntegration[])
          : [],
      );
      setShowKeyField(!userProfile.postiz_api_key);
    }
  }, [userProfile]);

  const refreshIntegrations = useCallback(async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "postiz-integrations",
        { body: {} },
      );
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      const list: PostizIntegration[] = (data as any)?.integrations ?? [];
      setIntegrations(list);
      if ((data as any)?.configured) {
        toast.success(`${list.length} compte(s) Postiz détecté(s)`);
      } else {
        toast.message("Aucune clé Postiz enregistrée.");
      }
      onUpdate();
    } catch (err: any) {
      console.error("Postiz sync error:", err);
      toast.error(err.message || "Erreur lors de la synchronisation Postiz");
    } finally {
      setSyncing(false);
    }
  }, [onUpdate]);

  // Auto-sync once on open if an API key is already stored.
  useEffect(() => {
    if (isOpen && userProfile?.postiz_api_key && integrations.length === 0) {
      refreshIntegrations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleSaveKey = async () => {
    if (!apiKey.trim()) {
      toast.error("Entrez votre clé API Postiz");
      return;
    }
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const { error } = await supabase
        .from("profiles")
        .update({
          postiz_api_key: apiKey.trim(),
          postiz_base_url: baseUrl.trim() || "https://api.postiz.com/public/v1",
        } as any)
        .eq("id", session.user.id);
      if (error) throw error;

      toast.success("Clé Postiz enregistrée");
      setShowKeyField(false);
      await refreshIntegrations();
    } catch (err: any) {
      toast.error(err.message || "Erreur lors de l'enregistrement");
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveKey = async () => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const { error } = await supabase
        .from("profiles")
        .update({
          postiz_api_key: null,
          postiz_integrations: [],
        } as any)
        .eq("id", session.user.id);
      if (error) throw error;

      setApiKey("");
      setIntegrations([]);
      setShowKeyField(true);
      toast.success("Clé Postiz supprimée");
      onUpdate();
    } catch (err: any) {
      toast.error(err.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  const platformConnected = (platform: (typeof PLATFORMS)[number]) =>
    integrations.some(
      (it) =>
        !it.disabled &&
        it.providerIdentifier &&
        platform.providers.includes(it.providerIdentifier.toLowerCase()),
    );

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connexion des réseaux sociaux (Postiz)</DialogTitle>
          <DialogDescription>
            Nous publions vos posts via{" "}
            <a
              href="https://postiz.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-primary"
            >
              Postiz
            </a>
            . Connectez vos comptes directement sur Postiz, puis collez votre
            clé API publique ci-dessous.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {/* Step 1: how to get your key */}
          <Card className="glass-card p-4">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div className="space-y-2 text-sm">
                <p className="font-medium">Comment obtenir votre clé ?</p>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                  <li>
                    Créez un compte sur{" "}
                    <a
                      href="https://platform.postiz.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-primary"
                    >
                      platform.postiz.com
                    </a>{" "}
                    (ou hébergez Postiz vous-même).
                  </li>
                  <li>
                    Connectez vos réseaux sociaux depuis l'interface Postiz
                    (Instagram, Facebook, LinkedIn, TikTok…).
                  </li>
                  <li>
                    Allez dans <strong>Settings → Developers → Public API</strong> et
                    générez votre clé.
                  </li>
                  <li>Collez-la ci-dessous.</li>
                </ol>
              </div>
            </div>
          </Card>

          {/* Step 2: API key */}
          <Card className="glass-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-primary" />
                <span className="font-medium">Clé API Postiz</span>
              </div>
              {userProfile?.postiz_api_key && !showKeyField && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-green-500 flex items-center gap-1">
                    <Check className="w-4 h-4" /> Configurée
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="glass-card"
                    onClick={() => setShowKeyField(true)}
                  >
                    Modifier
                  </Button>
                </div>
              )}
            </div>

            {showKeyField ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="postiz-key">Clé API</Label>
                  <Input
                    id="postiz-key"
                    type="password"
                    placeholder="pos_xxxxxxxxxxxx…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="glass-card"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postiz-url">
                    URL de l'API (avancé, pour les instances auto-hébergées)
                  </Label>
                  <Input
                    id="postiz-url"
                    placeholder="https://api.postiz.com/public/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="glass-card"
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  {userProfile?.postiz_api_key && (
                    <Button
                      variant="outline"
                      className="glass-card"
                      onClick={() => {
                        setShowKeyField(false);
                        setApiKey(userProfile.postiz_api_key || "");
                      }}
                      disabled={loading}
                    >
                      Annuler
                    </Button>
                  )}
                  <Button
                    onClick={handleSaveKey}
                    disabled={loading || !apiKey.trim()}
                    className="bg-gradient-to-r from-primary to-secondary flex-1"
                  >
                    {loading ? "Enregistrement…" : "Enregistrer et synchroniser"}
                  </Button>
                </div>
              </>
            ) : null}
          </Card>

          {/* Step 3: integrations list */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Comptes connectés</h3>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="glass-card"
                  onClick={refreshIntegrations}
                  disabled={syncing || !userProfile?.postiz_api_key}
                >
                  <RefreshCw
                    className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`}
                  />
                  Synchroniser
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="glass-card"
                  onClick={() =>
                    window.open(
                      "https://platform.postiz.com/launches",
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <ExternalLink className="w-4 h-4 mr-1" />
                  Ouvrir Postiz
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {PLATFORMS.map((platform) => {
                const connected = platformConnected(platform);
                const integration = integrations.find(
                  (it) =>
                    !it.disabled &&
                    it.providerIdentifier &&
                    platform.providers.includes(
                      it.providerIdentifier.toLowerCase(),
                    ),
                );
                return (
                  <Card key={platform.label} className="glass-card p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-xl">{platform.icon}</span>
                        <div>
                          <p className="font-medium text-sm">{platform.label}</p>
                          {connected && integration && (
                            <p className="text-xs text-muted-foreground">
                              {integration.name ||
                                integration.identifier ||
                                "Connecté"}
                            </p>
                          )}
                        </div>
                      </div>
                      {connected ? (
                        <span className="flex items-center gap-1 text-green-500 text-sm">
                          <Check className="w-4 h-4" />
                          Connecté
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Non connecté
                        </span>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>

            {userProfile?.postiz_api_key && (
              <div className="flex justify-end mt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={handleRemoveKey}
                  disabled={loading}
                >
                  Supprimer ma clé Postiz
                </Button>
              </div>
            )}
          </div>

          <div className="p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            ⓘ La connexion à chaque réseau (Instagram, LinkedIn…) se fait
            directement sur Postiz via OAuth officiel. Aucun mot de passe n'est
            stocké ici.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
