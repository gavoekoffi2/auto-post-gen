import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Upload, X } from "lucide-react";

type UserProfileLike = {
  sector?: string | null;
  content_types?: string[] | null;
  tone?: string | null;
  post_frequency?: number | null;
  description?: string | null;
  style_example?: string | null;
  platforms?: string[] | null;
  logo_url?: string | null;
  use_custom_images?: boolean | null;
  custom_image_urls?: string[] | null;
};

type SettingsDialogProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  userProfile: UserProfileLike | null;
  onProfileUpdate: () => void;
};

export default function SettingsDialog({ isOpen, onOpenChange, userProfile, onProfileUpdate }: SettingsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    sector: "",
    contentType: "",
    tone: "",
    frequency: "2",
    description: "",
    styleExample: "",
    platforms: [] as string[],
    useStyleExample: false,
    useCustomVisuals: false,
    logoUrl: "",
    useCustomImages: false,
    customImageUrls: [] as string[],
  });

  useEffect(() => {
    if (userProfile) {
      setFormData({
        sector: userProfile.sector || "",
        contentType: userProfile.content_types?.[0] || "",
        tone: userProfile.tone || "",
        frequency: userProfile.post_frequency?.toString() || "2",
        description: userProfile.description || "",
        styleExample: userProfile.style_example || "",
        platforms: userProfile.platforms || [],
        useStyleExample: !!userProfile.style_example,
        useCustomVisuals: !!userProfile.logo_url,
        logoUrl: userProfile.logo_url || "",
        useCustomImages: !!userProfile.use_custom_images,
        customImageUrls: userProfile.custom_image_urls || [],
      });
    }
  }, [userProfile]);

  const handleSave = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const { error } = await supabase.from('profiles').upsert(
        {
          id: session.user.id,
          email: session.user.email,
          sector: formData.sector,
          content_types: [formData.contentType],
          tone: formData.tone,
          post_frequency: parseInt(formData.frequency),
          description: formData.description,
          style_example: formData.useStyleExample ? formData.styleExample : null,
          platforms: formData.platforms.length > 0 ? formData.platforms : ['Instagram'],
          logo_url: formData.useCustomVisuals ? formData.logoUrl : null,
          use_custom_images: formData.useCustomImages,
          custom_image_urls: formData.useCustomImages ? formData.customImageUrls : [],
        },
        { onConflict: 'id' }
      );

      if (error) throw error;

      toast.success("Paramètres mis à jour !");
      onProfileUpdate();
      onOpenChange(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de la sauvegarde";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      if (!file.type.startsWith("image/")) {
        toast.error("Veuillez sélectionner une image");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error("L'image ne doit pas dépasser 5 Mo");
        return;
      }

      const fileExt = file.name.split('.').pop();
      // RLS requires the first folder segment to equal the user id.
      const filePath = `${session.user.id}/logo-${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('user-assets')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('user-assets')
        .getPublicUrl(filePath);

      setFormData({ ...formData, logoUrl: publicUrl });
      toast.success("Logo uploadé !");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de l'upload du logo";
      toast.error(message);
    }
  };

  const handleCustomImagesUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("Non authentifié");

      const uploadPromises = Array.from(files).map(async (file) => {
        if (!file.type.startsWith("image/")) {
          throw new Error(`${file.name} n'est pas une image`);
        }
        if (file.size > 5 * 1024 * 1024) {
          throw new Error(`${file.name} dépasse 5 Mo`);
        }
        const fileExt = file.name.split('.').pop();
        // RLS requires the first folder segment to equal the user id.
        const filePath = `${session.user.id}/custom-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from('user-assets')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('user-assets')
          .getPublicUrl(filePath);

        return publicUrl;
      });

      const uploadedUrls = await Promise.all(uploadPromises);
      setFormData({
        ...formData,
        customImageUrls: [...formData.customImageUrls, ...uploadedUrls]
      });
      toast.success(`${uploadedUrls.length} image(s) uploadée(s) !`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de l'upload des images";
      toast.error(message);
    }
  };

  const removeCustomImage = (index: number) => {
    const newUrls = formData.customImageUrls.filter((_, i) => i !== index);
    setFormData({ ...formData, customImageUrls: newUrls });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Paramètres et Préférences</DialogTitle>
          <DialogDescription>
            Personnalisez votre profil et vos préférences de génération de contenu
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Informations de base */}
          <div className="space-y-4">
            <h3 className="font-semibold text-lg">Informations de base</h3>
            
            <div className="space-y-2">
              <Label htmlFor="sector">Secteur d'activité</Label>
              <Select value={formData.sector} onValueChange={(v) => setFormData({ ...formData, sector: v })}>
                <SelectTrigger className="glass-card">
                  <SelectValue placeholder="Choisissez votre secteur" />
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
              <Label htmlFor="description">Description de votre entreprise</Label>
              <Textarea
                id="description"
                placeholder="Ex: Nous sommes une entreprise innovante spécialisée dans..."
                className="glass-card min-h-[100px]"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>
          </div>

          {/* Préférences de contenu */}
          <div className="space-y-4">
            <h3 className="font-semibold text-lg">Préférences de contenu</h3>

            <div className="space-y-2">
              <Label htmlFor="contentType">Type de contenu</Label>
              <Select value={formData.contentType} onValueChange={(v) => setFormData({ ...formData, contentType: v })}>
                <SelectTrigger className="glass-card">
                  <SelectValue placeholder="Type de contenu souhaité" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="educational">Éducatif</SelectItem>
                  <SelectItem value="promotional">Promotionnel</SelectItem>
                  <SelectItem value="inspirational">Inspirant</SelectItem>
                  <SelectItem value="entertaining">Divertissant</SelectItem>
                  <SelectItem value="mixed">Mixte</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tone">Tonalité</Label>
              <Select value={formData.tone} onValueChange={(v) => setFormData({ ...formData, tone: v })}>
                <SelectTrigger className="glass-card">
                  <SelectValue placeholder="Choisissez la tonalité" />
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

            <div className="space-y-2">
              <Label htmlFor="frequency">Fréquence de publication</Label>
              <Select value={formData.frequency} onValueChange={(v) => setFormData({ ...formData, frequency: v })}>
                <SelectTrigger className="glass-card">
                  <SelectValue placeholder="Nombre de posts par semaine" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">2 posts/semaine</SelectItem>
                  <SelectItem value="5">5 posts/semaine</SelectItem>
                  <SelectItem value="10">10 posts/semaine</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Plateformes */}
          <div className="space-y-4">
            <h3 className="font-semibold text-lg">Réseaux sociaux</h3>
            <div className="space-y-3">
              {['Instagram', 'Facebook', 'Twitter', 'LinkedIn', 'TikTok'].map((platform) => (
                <div key={platform} className="flex items-center space-x-2">
                  <Checkbox
                    id={`settings-${platform}`}
                    checked={formData.platforms.includes(platform)}
                    onCheckedChange={(checked) => {
                      const newPlatforms = checked
                        ? [...formData.platforms, platform]
                        : formData.platforms.filter(p => p !== platform);
                      setFormData({ ...formData, platforms: newPlatforms });
                    }}
                  />
                  <label htmlFor={`settings-${platform}`} className="text-sm cursor-pointer">
                    {platform}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Template de style */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Template de style (optionnel)</h3>
              <div className="flex items-center space-x-2">
                <Switch
                  id="use-style"
                  checked={formData.useStyleExample}
                  onCheckedChange={(checked) => setFormData({ ...formData, useStyleExample: checked })}
                />
                <Label htmlFor="use-style" className="cursor-pointer">Activer</Label>
              </div>
            </div>
            
            {formData.useStyleExample && (
              <div className="space-y-2">
                <Label htmlFor="styleExample">Exemple de post ou style préféré</Label>
                <Textarea
                  id="styleExample"
                  placeholder="Ex: Bonjour à tous ! 👋 Aujourd'hui, je voulais partager avec vous..."
                  className="glass-card min-h-[120px]"
                  value={formData.styleExample}
                  onChange={(e) => setFormData({ ...formData, styleExample: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  L'IA s'inspirera de ce style pour créer vos posts
                </p>
              </div>
            )}
          </div>

          {/* Visuels personnalisés */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Visuels personnalisés (optionnel)</h3>
              <div className="flex items-center space-x-2">
                <Switch
                  id="use-visuals"
                  checked={formData.useCustomVisuals}
                  onCheckedChange={(checked) => setFormData({ ...formData, useCustomVisuals: checked })}
                />
                <Label htmlFor="use-visuals" className="cursor-pointer">Activer</Label>
              </div>
            </div>
            
            {formData.useCustomVisuals && (
              <div className="space-y-2">
                <Label htmlFor="logo">Logo ou visuel principal</Label>
                {formData.logoUrl ? (
                  <div className="relative">
                    <img src={formData.logoUrl} alt="Logo" className="w-32 h-32 object-cover rounded-lg" />
                    <Button
                      size="icon"
                      variant="destructive"
                      className="absolute -top-2 -right-2"
                      onClick={() => setFormData({ ...formData, logoUrl: "" })}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                    <input
                      type="file"
                      id="logo-upload"
                      accept="image/*"
                      className="hidden"
                      onChange={handleLogoUpload}
                    />
                    <label htmlFor="logo-upload" className="cursor-pointer">
                      <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        Cliquez pour uploader votre logo
                      </p>
                    </label>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  L'IA pourra utiliser ce visuel dans vos posts
                </p>
              </div>
            )}
          </div>

          {/* Bibliothèque d'images personnalisées */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Bibliothèque d'images (optionnel)</h3>
              <div className="flex items-center space-x-2">
                <Switch
                  id="use-custom-images"
                  checked={formData.useCustomImages}
                  onCheckedChange={(checked) => setFormData({ ...formData, useCustomImages: checked })}
                />
                <Label htmlFor="use-custom-images" className="cursor-pointer">Activer</Label>
              </div>
            </div>
            
            {formData.useCustomImages && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Uploadez vos images personnalisées. L'IA choisira aléatoirement parmi ces images lors de la création de posts.
                </p>
                
                {formData.customImageUrls.length > 0 && (
                  <div className="grid grid-cols-3 gap-3">
                    {formData.customImageUrls.map((url, index) => (
                      <div key={index} className="relative group">
                        <img 
                          src={url} 
                          alt={`Image ${index + 1}`} 
                          className="w-full h-24 object-cover rounded-lg" 
                        />
                        <Button
                          size="icon"
                          variant="destructive"
                          className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => removeCustomImage(index)}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                  <input
                    type="file"
                    id="custom-images-upload"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handleCustomImagesUpload}
                  />
                  <label htmlFor="custom-images-upload" className="cursor-pointer">
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Cliquez pour uploader des images
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Vous pouvez sélectionner plusieurs images à la fois
                    </p>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3 pt-4 border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="glass-card flex-1">
            Annuler
          </Button>
          <Button onClick={handleSave} disabled={loading} className="bg-gradient-to-r from-primary to-secondary flex-1">
            {loading ? "Sauvegarde..." : "Enregistrer"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
