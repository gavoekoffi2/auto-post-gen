import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Check, ExternalLink, Link2, Loader2, RefreshCw } from "lucide-react";
import type { Database } from "@/integrations/supabase/types";

type UserProfile = Database['public']['Tables']['profiles']['Row'];

type SocialMediaConnectProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  userProfile: UserProfile | null;
  onUpdate: () => void;
};

const PLATFORMS = [
  { id: 'instagram', label: 'Instagram', icon: '📷', color: 'from-pink-500 to-purple-600' },
  { id: 'facebook', label: 'Facebook', icon: '👤', color: 'from-blue-600 to-blue-700' },
  { id: 'twitter', label: 'Twitter (X)', icon: '🐦', color: 'from-sky-400 to-sky-600' },
  { id: 'linkedin', label: 'LinkedIn', icon: '💼', color: 'from-blue-500 to-blue-800' },
  { id: 'tiktok', label: 'TikTok', icon: '🎵', color: 'from-gray-800 to-gray-900' },
];

export function SocialMediaConnect({ isOpen, onOpenChange, userProfile, onUpdate }: SocialMediaConnectProps) {
  const [loading, setLoading] = useState(false);
  const [connectedPlatforms, setConnectedPlatforms] = useState<string[]>([]);
  const [hasAyrshareProfile, setHasAyrshareProfile] = useState(false);

  useEffect(() => {
    if (userProfile) {
      setHasAyrshareProfile(!!userProfile.ayrshare_profile_key);
      setConnectedPlatforms(userProfile.connected_platforms || []);
    }
  }, [userProfile]);

  // Step 1: Create Ayrshare profile + open connection page
  const handleConnectAll = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      const { data, error } = await supabase.functions.invoke('create-ayrshare-profile', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error || !data?.connectUrl) {
        throw new Error(data?.error || 'Impossible de créer le profil de connexion');
      }

      // Open Ayrshare connection page in a new tab
      window.open(data.connectUrl, '_blank', 'noopener,noreferrer');

      setHasAyrshareProfile(true);
      toast.success(
        data.alreadyExists
          ? "Page de connexion ouverte — reconnectez ou ajoutez des comptes."
          : "Profil créé ! Connectez vos réseaux sociaux dans l'onglet ouvert.",
        { duration: 6000 }
      );

      onUpdate();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erreur inconnue';
      toast.error(message);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Refresh connected platforms status from Ayrshare (via profile)
  const handleRefreshStatus = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      const ayrshareApiKey = import.meta.env.VITE_AYRSHARE_API_KEY;
      if (!ayrshareApiKey || !userProfile?.ayrshare_profile_key) {
        // Fallback: just reload the profile from Supabase
        onUpdate();
        toast.info("Statut mis à jour.");
        return;
      }

      // Query Ayrshare for connected platforms
      const resp = await fetch(
        `https://app.ayrshare.com/api/profiles/profile?profileKey=${userProfile.ayrshare_profile_key}`,
        { headers: { Authorization: `Bearer ${ayrshareApiKey}` } }
      );

      if (resp.ok) {
        const data = await resp.json();
        // data.activeSocialAccounts is an array of platform names
        const active: string[] = (data.activeSocialAccounts || []).map((p: string) =>
          p.charAt(0).toUpperCase() + p.slice(1)
        );
        setConnectedPlatforms(active);

        // Persist to Supabase
        await supabase
          .from('profiles')
          .update({ connected_platforms: active })
          .eq('id', session.user.id);

        toast.success("Statut des connexions mis à jour !");
      } else {
        toast.info("Impossible de récupérer le statut — vérifiez votre connexion Ayrshare.");
      }
    } catch (err) {
      console.error(err);
      toast.error("Erreur lors de la mise à jour du statut");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connecter vos réseaux sociaux</DialogTitle>
          <DialogDescription>
            Publiez directement sur vos plateformes depuis Pro Social AI — sans gérer de tokens.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">

          {/* Status overview */}
          <div className="grid grid-cols-5 gap-3">
            {PLATFORMS.map((platform) => {
              const isConnected = connectedPlatforms.some(
                cp => cp.toLowerCase() === platform.id
              );
              return (
                <div
                  key={platform.id}
                  className={`flex flex-col items-center p-3 rounded-xl border-2 transition-all ${
                    isConnected
                      ? 'border-green-500 bg-green-500/10'
                      : 'border-border bg-muted/30'
                  }`}
                >
                  <span className="text-2xl mb-1">{platform.icon}</span>
                  <p className="text-xs font-medium text-center leading-tight">{platform.label.split(' ')[0]}</p>
                  {isConnected && (
                    <Check className="w-3 h-3 text-green-500 mt-1" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Main action */}
          <Card className="glass-card p-6 space-y-4">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center flex-shrink-0">
                <Link2 className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">
                  {hasAyrshareProfile ? "Gérer vos connexions" : "Connecter mes réseaux sociaux"}
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {hasAyrshareProfile
                    ? "Cliquez pour ouvrir votre espace de gestion. Vous pouvez ajouter ou retirer des plateformes."
                    : "En un clic, une page s'ouvre pour connecter Instagram, Facebook, LinkedIn, Twitter et TikTok. Aucun token à gérer de votre côté."}
                </p>
              </div>
            </div>

            <Button
              className="w-full bg-gradient-to-r from-primary to-secondary"
              onClick={handleConnectAll}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ExternalLink className="w-4 h-4 mr-2" />
              )}
              {hasAyrshareProfile ? "Gérer mes comptes sociaux" : "Connecter mes réseaux sociaux"}
            </Button>

            {hasAyrshareProfile && (
              <Button
                variant="outline"
                className="w-full glass-card"
                onClick={handleRefreshStatus}
                disabled={loading}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Actualiser le statut des connexions
              </Button>
            )}
          </Card>

          {/* How it works */}
          <Card className="glass-card p-5">
            <h4 className="font-medium mb-3">Comment ça fonctionne ?</h4>
            <ol className="space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs flex-shrink-0 font-bold">1</span>
                Cliquez sur "Connecter mes réseaux sociaux"
              </li>
              <li className="flex gap-2">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs flex-shrink-0 font-bold">2</span>
                Une page s'ouvre — connectez-y vos comptes Instagram, Facebook, etc.
              </li>
              <li className="flex gap-2">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs flex-shrink-0 font-bold">3</span>
                Revenez ici et cliquez "Actualiser" pour voir vos comptes connectés
              </li>
              <li className="flex gap-2">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs flex-shrink-0 font-bold">4</span>
                Validez un post depuis le dashboard → cliquez "Publier" → c'est en ligne !
              </li>
            </ol>
          </Card>

          {/* Powered by note */}
          <p className="text-xs text-center text-muted-foreground">
            Publication sécurisée via <strong>Ayrshare</strong> — vos identifiants ne transitent jamais par nos serveurs.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
