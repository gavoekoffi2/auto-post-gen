import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Save, Building2, Settings, ImageIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { LogoUpload } from "@/components/LogoUpload";
import { CustomImageLibrary } from "@/components/CustomImageLibrary";
import { AccountSettings } from "@/components/AccountSettings";

const DAYS = [
  { id: "monday", label: "Lundi" },
  { id: "tuesday", label: "Mardi" },
  { id: "wednesday", label: "Mercredi" },
  { id: "thursday", label: "Jeudi" },
  { id: "friday", label: "Vendredi" },
  { id: "saturday", label: "Samedi" },
  { id: "sunday", label: "Dimanche" },
];

export default function Profile() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [profile, setProfile] = useState({
    company_name: "",
    logo_url: "",
    sector: "",
    content_types: [] as string[],
    tone: "",
    post_frequency: 2,
    description: "",
    style_example: "",
    platforms: [] as string[],
    preferred_days: [] as string[],
    auto_publish: false,
    image_people_type: "african",
    use_custom_images: false,
    custom_image_urls: [] as string[],
  });

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }

      setUserEmail(session.user.email || "");

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setProfile({
          company_name: (data as any).company_name || "",
          logo_url: data.logo_url || "",
          sector: data.sector || "",
          content_types: data.content_types || [],
          tone: data.tone || "",
          post_frequency: data.post_frequency || 2,
          description: data.description || "",
          style_example: data.style_example || "",
          platforms: data.platforms || [],
          preferred_days: data.preferred_days || [],
          auto_publish: data.auto_publish || false,
          image_people_type: (data as any).image_people_type || "african",
          use_custom_images: data.use_custom_images || false,
          custom_image_urls: data.custom_image_urls || [],
        });
      }
    } catch (error: any) {
      toast.error('Erreur lors du chargement du profil');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      const { error } = await supabase
        .from('profiles')
        .update({
          company_name: profile.company_name,
          logo_url: profile.logo_url,
          sector: profile.sector,
          content_types: profile.content_types,
          tone: profile.tone,
          post_frequency: profile.post_frequency,
          description: profile.description,
          style_example: profile.style_example,
          platforms: profile.platforms,
          preferred_days: profile.preferred_days,
          auto_publish: profile.auto_publish,
          image_people_type: profile.image_people_type,
          use_custom_images: profile.use_custom_images,
          custom_image_urls: profile.custom_image_urls,
        } as any)
        .eq('id', session.user.id);

      if (error) throw error;
      toast.success("Profil mis à jour !");
    } catch (error: any) {
      toast.error(error.message || "Erreur lors de la sauvegarde");
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (day: string) => {
    setProfile(prev => ({
      ...prev,
      preferred_days: prev.preferred_days.includes(day)
        ? prev.preferred_days.filter(d => d !== day)
        : [...prev.preferred_days, day]
    }));
  };

  const togglePlatform = (platform: string) => {
    setProfile(prev => ({
      ...prev,
      platforms: prev.platforms.includes(platform)
        ? prev.platforms.filter(p => p !== platform)
        : [...prev.platforms, platform]
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse">Chargement...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-4xl px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Retour
              </Button>
              <h1 className="text-xl font-bold">Mon Profil</h1>
            </div>
            <Button onClick={handleSave} disabled={saving} className="bg-gradient-to-r from-primary to-secondary">
              <Save className="w-4 h-4 mr-2" />
              {saving ? "Sauvegarde..." : "Enregistrer"}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Tabs defaultValue="business" className="space-y-6">
          <TabsList className="glass-card">
            <TabsTrigger value="business">
              <Building2 className="w-4 h-4 mr-2" />
              Entreprise
            </TabsTrigger>
            <TabsTrigger value="images">
              <ImageIcon className="w-4 h-4 mr-2" />
              Images
            </TabsTrigger>
            <TabsTrigger value="account">
              <Settings className="w-4 h-4 mr-2" />
              Compte
            </TabsTrigger>
          </TabsList>

          {/* Business Tab */}
          <TabsContent value="business" className="space-y-6">
            <Card className="glass-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <Building2 className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Identité de l'entreprise</h2>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Nom de l'entreprise</Label>
                    <Input
                      placeholder="Ma Super Entreprise"
                      className="glass-card"
                      value={profile.company_name}
                      onChange={(e) => setProfile({ ...profile, company_name: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Secteur d'activité</Label>
                    <Select value={profile.sector} onValueChange={(v) => setProfile({ ...profile, sector: v })}>
                      <SelectTrigger className="glass-card">
                        <SelectValue placeholder="Choisir" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tech">Technologie</SelectItem>
                        <SelectItem value="fashion">Mode & Lifestyle</SelectItem>
                        <SelectItem value="food">Restauration</SelectItem>
                        <SelectItem value="health">Santé & Bien-être</SelectItem>
                        <SelectItem value="education">Éducation</SelectItem>
                        <SelectItem value="other">Autre</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Tonalité</Label>
                    <Select value={profile.tone} onValueChange={(v) => setProfile({ ...profile, tone: v })}>
                      <SelectTrigger className="glass-card">
                        <SelectValue placeholder="Choisir" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="professional">Professionnel</SelectItem>
                        <SelectItem value="casual">Décontracté</SelectItem>
                        <SelectItem value="fun">Fun & Enjoué</SelectItem>
                        <SelectItem value="serious">Sérieux</SelectItem>
                        <SelectItem value="inspiring">Inspirant</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Logo de l'entreprise</Label>
                  <LogoUpload
                    currentLogoUrl={profile.logo_url}
                    onUpload={(url) => setProfile({ ...profile, logo_url: url })}
                    onRemove={() => setProfile({ ...profile, logo_url: "" })}
                  />
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <Label>Description de votre entreprise</Label>
                <Textarea
                  placeholder="Décrivez votre activité..."
                  className="glass-card min-h-[100px]"
                  value={profile.description}
                  onChange={(e) => setProfile({ ...profile, description: e.target.value })}
                />
              </div>

              <div className="mt-4 space-y-2">
                <Label>Style de contenu préféré (optionnel)</Label>
                <Textarea
                  placeholder="Exemple de style que vous aimez..."
                  className="glass-card"
                  value={profile.style_example}
                  onChange={(e) => setProfile({ ...profile, style_example: e.target.value })}
                />
              </div>
            </Card>

            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-4">Réseaux sociaux</h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {['Instagram', 'Facebook', 'Twitter', 'LinkedIn', 'TikTok'].map((platform) => (
                  <div key={platform} className="flex items-center space-x-2">
                    <Checkbox
                      id={`platform-${platform}`}
                      checked={profile.platforms.includes(platform)}
                      onCheckedChange={() => togglePlatform(platform)}
                    />
                    <label htmlFor={`platform-${platform}`} className="text-sm cursor-pointer">
                      {platform}
                    </label>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-4">Automatisation</h2>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Fréquence de publication (posts/semaine)</Label>
                  <Select 
                    value={profile.post_frequency.toString()} 
                    onValueChange={(v) => setProfile({ ...profile, post_frequency: parseInt(v) })}
                  >
                    <SelectTrigger className="glass-card w-full md:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 post/semaine</SelectItem>
                      <SelectItem value="2">2 posts/semaine</SelectItem>
                      <SelectItem value="3">3 posts/semaine</SelectItem>
                      <SelectItem value="5">5 posts/semaine</SelectItem>
                      <SelectItem value="7">7 posts/semaine</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Jours de publication préférés</Label>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {DAYS.map((day) => (
                      <div key={day.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`day-${day.id}`}
                          checked={profile.preferred_days.includes(day.id)}
                          onCheckedChange={() => toggleDay(day.id)}
                        />
                        <label htmlFor={`day-${day.id}`} className="text-sm cursor-pointer">
                          {day.label}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center space-x-2 pt-4 border-t border-border/50">
                  <Checkbox
                    id="auto-publish"
                    checked={profile.auto_publish}
                    onCheckedChange={(checked) => setProfile({ ...profile, auto_publish: !!checked })}
                  />
                  <label htmlFor="auto-publish" className="text-sm cursor-pointer">
                    Activer la publication automatique
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Si activé, les posts validés seront automatiquement publiés aux jours sélectionnés
                </p>
              </div>
            </Card>
          </TabsContent>

          {/* Images Tab */}
          <TabsContent value="images" className="space-y-6">
            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-4">Préférences d'images IA</h2>
              
              <div className="space-y-2">
                <Label>Type de personnes dans les images générées</Label>
                <Select 
                  value={profile.image_people_type} 
                  onValueChange={(v) => setProfile({ ...profile, image_people_type: v })}
                >
                  <SelectTrigger className="glass-card w-full md:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="african">🌍 Personnes africaines</SelectItem>
                    <SelectItem value="caucasian">🌎 Personnes caucasiennes</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Les images générées par IA incluront principalement ce type de personnes
                </p>
              </div>
            </Card>

            <CustomImageLibrary
              images={profile.custom_image_urls}
              useCustomImages={profile.use_custom_images}
              onImagesChange={(urls) => setProfile({ ...profile, custom_image_urls: urls })}
              onUseCustomImagesChange={(value) => setProfile({ ...profile, use_custom_images: value })}
            />
          </TabsContent>

          {/* Account Tab */}
          <TabsContent value="account">
            <AccountSettings userEmail={userEmail} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
