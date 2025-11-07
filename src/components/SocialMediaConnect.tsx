import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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

type PlatformConnection = {
  platform: string;
  connected: boolean;
  username?: string;
  accessToken?: string;
};

const PLATFORMS = [
  { id: 'Instagram', label: 'Instagram', icon: '📷' },
  { id: 'Facebook', label: 'Facebook', icon: '👤' },
  { id: 'Twitter', label: 'Twitter (X)', icon: '🐦' },
  { id: 'LinkedIn', label: 'LinkedIn', icon: '💼' },
  { id: 'TikTok', label: 'TikTok', icon: '🎵' },
];

export function SocialMediaConnect({ isOpen, onOpenChange, userProfile, onUpdate }: SocialMediaConnectProps) {
  const [loading, setLoading] = useState(false);
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (userProfile?.platforms) {
      const platformConnections: PlatformConnection[] = PLATFORMS.map(p => ({
        platform: p.id,
        connected: userProfile.platforms.includes(p.id),
        username: "",
      }));
      setConnections(platformConnections);
    }
  }, [userProfile]);

  const handleConnect = async () => {
    if (!selectedPlatform || !username) {
      toast.error("Veuillez entrer votre nom d'utilisateur");
      return;
    }

    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      // Update the platforms array to include this platform
      const updatedPlatforms = [...(userProfile?.platforms || [])];
      if (!updatedPlatforms.includes(selectedPlatform)) {
        updatedPlatforms.push(selectedPlatform);
      }

      const { error } = await supabase
        .from('profiles')
        .update({ platforms: updatedPlatforms })
        .eq('id', session.user.id);

      if (error) throw error;

      toast.success(`${selectedPlatform} connecté avec succès !`);
      setConnections(connections.map(c => 
        c.platform === selectedPlatform 
          ? { ...c, connected: true, username } 
          : c
      ));
      setSelectedPlatform(null);
      setUsername("");
      onUpdate();
    } catch (error: any) {
      console.error('Error connecting platform:', error);
      toast.error("Erreur lors de la connexion");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (platform: string) => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const updatedPlatforms = (userProfile?.platforms || []).filter((p: string) => p !== platform);

      const { error } = await supabase
        .from('profiles')
        .update({ platforms: updatedPlatforms })
        .eq('id', session.user.id);

      if (error) throw error;

      toast.success(`${platform} déconnecté`);
      setConnections(connections.map(c => 
        c.platform === platform 
          ? { ...c, connected: false, username: "" } 
          : c
      ));
      onUpdate();
    } catch (error: any) {
      console.error('Error disconnecting platform:', error);
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
            Connectez vos comptes de réseaux sociaux pour publier automatiquement
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {PLATFORMS.map((platform) => {
            const connection = connections.find(c => c.platform === platform.id);
            const isConnected = connection?.connected || false;

            return (
              <Card key={platform.id} className="glass-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{platform.icon}</span>
                    <div>
                      <p className="font-medium">{platform.label}</p>
                      {isConnected && connection?.username && (
                        <p className="text-sm text-muted-foreground">@{connection.username}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isConnected ? (
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

                {selectedPlatform === platform.id && !isConnected && (
                  <div className="mt-4 pt-4 border-t border-border/50 space-y-3">
                    <div>
                      <Label htmlFor={`username-${platform.id}`}>
                        Nom d'utilisateur {platform.label}
                      </Label>
                      <Input
                        id={`username-${platform.id}`}
                        placeholder={`Votre nom d'utilisateur ${platform.label}`}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="glass-card mt-1"
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
                        onClick={handleConnect}
                        disabled={loading || !username}
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
