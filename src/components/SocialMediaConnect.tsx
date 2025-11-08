import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Check, X } from "lucide-react";

type SocialMediaConnectProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  userProfile: any;
  onUpdate: () => void;
};

type PlatformId = 'instagram' | 'facebook' | 'twitter' | 'linkedin' | 'tiktok';

type PlatformConnection = {
  connected: boolean;
  username?: string;
};

const PLATFORMS = [
  { id: 'instagram', label: 'Instagram', icon: '📷' },
  { id: 'facebook', label: 'Facebook', icon: '👤' },
  { id: 'twitter', label: 'Twitter (X)', icon: '🐦' },
  { id: 'linkedin', label: 'LinkedIn', icon: '💼' },
  { id: 'tiktok', label: 'TikTok', icon: '🎵' },
];

export function SocialMediaConnect({ isOpen, onOpenChange, userProfile, onUpdate }: SocialMediaConnectProps) {
  const [loading, setLoading] = useState(false);
  const [connections, setConnections] = useState<Record<string, PlatformConnection>>({});
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (userProfile) {
      const initialConnections: Record<string, PlatformConnection> = {};
      PLATFORMS.forEach(platform => {
        const platformId = platform.id as PlatformId;
        const usernameKey = `${platformId}_username` as keyof typeof userProfile;
        const hasUsername = !!userProfile[usernameKey];
        
        initialConnections[platform.id] = {
          connected: hasUsername || userProfile.connected_platforms?.includes(platform.label) || false,
          username: userProfile[usernameKey] || undefined
        };
      });
      setConnections(initialConnections);
    }
  }, [userProfile]);

  const handleConnect = async (platformId: string) => {
    if (!username.trim()) {
      toast.error("Veuillez entrer un nom d'utilisateur");
      return;
    }

    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const platform = PLATFORMS.find(p => p.id === platformId);
      if (!platform) return;

      const usernameKey = `${platformId}_username`;
      const currentConnectedPlatforms = userProfile?.connected_platforms || [];
      const updatedConnectedPlatforms = [...currentConnectedPlatforms];
      
      if (!updatedConnectedPlatforms.includes(platform.label)) {
        updatedConnectedPlatforms.push(platform.label);
      }

      const { error } = await supabase
        .from('profiles')
        .update({ 
          [usernameKey]: username,
          connected_platforms: updatedConnectedPlatforms
        })
        .eq('id', session.user.id);

      if (error) throw error;

      setConnections({
        ...connections,
        [platformId]: { connected: true, username: username }
      });
      setSelectedPlatform(null);
      setUsername("");
      toast.success(`${platform.label} connecté avec succès !`);
      onUpdate();
    } catch (error: any) {
      toast.error("Erreur lors de la connexion");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (platformId: string) => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const platform = PLATFORMS.find(p => p.id === platformId);
      if (!platform) return;

      const usernameKey = `${platformId}_username`;
      const currentConnectedPlatforms = userProfile?.connected_platforms || [];
      const updatedConnectedPlatforms = currentConnectedPlatforms.filter((p: string) => p !== platform.label);

      const { error } = await supabase
        .from('profiles')
        .update({ 
          [usernameKey]: null,
          connected_platforms: updatedConnectedPlatforms
        })
        .eq('id', session.user.id);

      if (error) throw error;

      setConnections({
        ...connections,
        [platformId]: { connected: false, username: undefined }
      });
      toast.success(`${platform.label} déconnecté avec succès`);
      onUpdate();
    } catch (error: any) {
      toast.error("Erreur lors de la déconnexion");
      console.error(error);
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
            Connectez vos comptes de réseaux sociaux pour publier automatiquement
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {PLATFORMS.map((platform) => {
            const connection = connections[platform.id] || { connected: false };

            return (
              <Card key={platform.id} className="glass-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{platform.icon}</span>
                    <div>
                      <p className="font-medium">{platform.label}</p>
                      {connection.connected && connection.username && (
                        <p className="text-sm text-muted-foreground">@{connection.username}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {connection.connected ? (
                      <>
                        <div className="flex items-center gap-1 text-green-500">
                          <Check className="w-4 h-4" />
                          <span className="text-sm">Connecté</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDisconnect(platform.id)}
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
                        onClick={() => setSelectedPlatform(platform.id)}
                        className="bg-gradient-to-r from-primary to-secondary"
                      >
                        Connecter
                      </Button>
                    )}
                  </div>
                </div>

                {selectedPlatform === platform.id && !connection.connected && (
                  <div className="mt-4 pt-4 border-t border-border/50 space-y-3">
                    <div>
                      <Label htmlFor={`username-${platform.id}`} className="text-sm text-muted-foreground">
                        Nom d'utilisateur {platform.label}
                      </Label>
                      <Input
                        id={`username-${platform.id}`}
                        placeholder={`@votre_username_${platform.id}`}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="glass-card mt-1"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && username.trim()) {
                            handleConnect(platform.id);
                          }
                        }}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedPlatform(null);
                          setUsername("");
                        }}
                        className="glass-card flex-1"
                      >
                        Annuler
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleConnect(platform.id)}
                        disabled={loading || !username.trim()}
                        className="bg-gradient-to-r from-primary to-secondary flex-1"
                      >
                        {loading ? "Connexion..." : "Confirmer"}
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>

        <div className="mt-6 p-4 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong>Note :</strong> La publication automatique nécessite l'autorisation des plateformes. 
            Les posts seront programmés et vous devrez les publier manuellement pour le moment.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
