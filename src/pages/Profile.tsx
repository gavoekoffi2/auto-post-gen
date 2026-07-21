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
import { supabase } from '@/integrations/supabase/client';
import { AudienceEditor } from '@/components/AudienceEditor';
import { AudienceSegment, normalizeAudienceSegments } from '@/lib/audiences';
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LogoUpload } from "@/components/LogoUpload";
import { CustomImageLibrary } from "@/components/CustomImageLibrary";
import { AccountSettings } from "@/components/AccountSettings";

const DAYS = [
  { id: "Lundi", label: "Lundi" },
  { id: "Mardi", label: "Mardi" },
  { id: "Mercredi", label: "Mercredi" },
  { id: "Jeudi", label: "Jeudi" },
  { id: "Vendredi", label: "Vendredi" },
  { id: "Samedi", label: "Samedi" },
  { id: "Dimanche", label: "Dimanche" },
];

export default function Profile() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [analyzingAudiences, setAnalyzingAudiences] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [autoPublishConfirmOpen, setAutoPublishConfirmOpen] = useState(false);
  const [autoPublishAcknowledged, setAutoPublishAcknowledged] = useState(false);
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
    preferred_time: "10:00",
    promo_posts_per_week: 1,
    research_posts_per_week: 1,
    auto_publish: false,
    image_people_type: "african",
    use_custom_images: false,
    custom_image_urls: [] as string[],
    brand_primary_color: "#8B5CF6",
    brand_secondary_color: "#3B82F6",
    brand_accent_color: "#F59E0B",
    brand_font: "Inter",
    image_style: "photorealistic",
    style_examples: [] as Array<{ label: string; content: string }>,
    audienceSuggestions: [] as AudienceSegment[],
    selectedAudienceIds: [] as string[],
  });
  const [newStyleLabel, setNewStyleLabel] = useState("");
  const [newStyleContent, setNewStyleContent] = useState("");

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          company_name: data.company_name || "",
          logo_url: data.logo_url || "",
          sector: data.sector || "",
          content_types: data.content_types || [],
          tone: data.tone || "",
          post_frequency: data.post_frequency || 2,
          description: data.description || "",
          style_example: data.style_example || "",
          platforms: data.platforms || [],
          preferred_days: data.preferred_days || [],
          preferred_time: data.preferred_time || "10:00",
          promo_posts_per_week: data.promo_posts_per_week ?? 1,
          research_posts_per_week: data.research_posts_per_week ?? 1,
          auto_publish: data.auto_publish || false,
          image_people_type: data.image_people_type || "african",
          use_custom_images: data.use_custom_images || false,
          custom_image_urls: data.custom_image_urls || [],
          brand_primary_color: data.brand_primary_color || "#8B5CF6",
          brand_secondary_color: data.brand_secondary_color || "#3B82F6",
          brand_accent_color: data.brand_accent_color || "#F59E0B",
          brand_font: data.brand_font || "Inter",
          image_style: data.image_style || "photorealistic",
          style_examples: Array.isArray(data.style_examples)
            ? (data.style_examples as Array<{ label: string; content: string }>)
            : [],
          audienceSuggestions: normalizeAudienceSegments(
            Array.isArray(data.audience_suggestions) && data.audience_suggestions.length > 0
              ? data.audience_suggestions
              : data.target_audiences
          ),
          selectedAudienceIds: normalizeAudienceSegments(data.target_audiences).map((audience) => audience.id),
        });
        setAutoPublishAcknowledged(!!data.auto_publish);
      }
    } catch (_error) {
      toast.error('Erreur lors du chargement du profil');
    } finally {
      setLoading(false);
    }
  };

  const analyzeAudiences = async () => {
    if (!profile.company_name.trim() || !profile.sector.trim() || profile.description.trim().length < 20) {
      toast.error("Renseignez le nom, le secteur et une description précise avant l'analyse.");
      return;
    }
    setAnalyzingAudiences(true);
    try {
      const { data, error } = await supabase.functions.invoke('detect-audiences', {
        body: {
          companyName: profile.company_name,
          sector: profile.sector,
          description: profile.description,
          contentTypes: profile.content_types,
        },
      });
      if (error) throw error;
      const audiences = normalizeAudienceSegments(data?.audiences);
      if (audiences.length < 2) throw new Error("Analyse incomplète");
      setProfile((current) => ({
        ...current,
        audienceSuggestions: audiences,
        selectedAudienceIds: [],
      }));
      toast.success("Nouvelles cibles proposées. Sélectionnez celles à conserver, puis enregistrez.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Analyse indisponible";
      toast.error(`Impossible d'analyser vos cibles : ${message}`);
    } finally {
      setAnalyzingAudiences(false);
    }
  };

  const handleSave = async () => {
    if (profile.audienceSuggestions.length > 0 && profile.selectedAudienceIds.length === 0) {
      toast.error("Sélectionnez au moins une cible avant d'enregistrer.");
      return;
    }
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
          preferred_time: profile.preferred_time,
          promo_posts_per_week: profile.promo_posts_per_week,
          research_posts_per_week: profile.research_posts_per_week,
          auto_publish: profile.auto_publish,
          image_people_type: profile.image_people_type,
          use_custom_images: profile.use_custom_images,
          custom_image_urls: profile.custom_image_urls,
          brand_primary_color: profile.brand_primary_color,
          brand_secondary_color: profile.brand_secondary_color,
          brand_accent_color: profile.brand_accent_color,
          brand_font: profile.brand_font,
          image_style: profile.image_style,
          style_examples: profile.style_examples,
          audience_suggestions: profile.audienceSuggestions,
          target_audiences: profile.audienceSuggestions.filter((audience) =>
            profile.selectedAudienceIds.includes(audience.id)
          ),
          audiences_confirmed_at: new Date().toISOString(),
        })
        .eq('id', session.user.id);

      if (error) throw error;
      toast.success("Profil mis à jour !");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de la sauvegarde";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleAutoPublishToggle = (checked: boolean) => {
    if (!checked) {
      setProfile({ ...profile, auto_publish: false });
      setAutoPublishAcknowledged(false);
      return;
    }
    if (autoPublishAcknowledged) {
      setProfile({ ...profile, auto_publish: true });
      return;
    }
    setAutoPublishConfirmOpen(true);
  };

  const confirmAutoPublish = () => {
    setProfile({ ...profile, auto_publish: true });
    setAutoPublishAcknowledged(true);
    setAutoPublishConfirmOpen(false);
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
            <Button onClick={handleSave} disabled={saving || analyzingAudiences} className="bg-gradient-to-r from-primary to-secondary">
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
                <p className="text-xs text-muted-foreground">
                  Description courte du style. Pour des exemples concrets, utilisez la bibliothèque ci-dessous.
                </p>
              </div>
            </Card>

            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-2">Cibles de communication</h2>
              <p className="text-sm text-muted-foreground mb-5">
                Claude propose les segments les plus pertinents à partir de votre activité. Vous gardez le contrôle : sélectionnez, corrigez et validez les cibles que chaque publication devra réellement aider.
              </p>
              <AudienceEditor
                audiences={profile.audienceSuggestions}
                selectedIds={profile.selectedAudienceIds}
                onAudiencesChange={(audienceSuggestions) => setProfile((current) => ({ ...current, audienceSuggestions }))}
                onSelectedIdsChange={(selectedAudienceIds) => setProfile((current) => ({ ...current, selectedAudienceIds }))}
                onAnalyze={() => void analyzeAudiences()}
                analyzing={analyzingAudiences}
              />
            </Card>

            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-2">Bibliothèque de styles d'écriture</h2>
              <p className="text-xs text-muted-foreground mb-4">
                Collez ici des posts que vous trouvez bien écrits (les vôtres ou ceux d'autres entreprises).
                L'IA s'inspirera du ton, de la structure et du rythme de ces exemples pour générer vos
                propres posts dans le même style. <strong>2 à 5 exemples</strong> suffisent.
              </p>

              {profile.style_examples.length > 0 && (
                <div className="space-y-3 mb-4">
                  {profile.style_examples.map((ex, idx) => (
                    <div key={idx} className="rounded-lg border border-border/50 p-3 bg-muted/30">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p className="text-sm font-medium">{ex.label || `Exemple ${idx + 1}`}</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setProfile({
                              ...profile,
                              style_examples: profile.style_examples.filter((_, i) => i !== idx),
                            })
                          }
                        >
                          Supprimer
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">{ex.content}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2 border-t border-border/50 pt-4">
                <Label>Ajouter un exemple</Label>
                <Input
                  placeholder="Étiquette (ex: 'Post LinkedIn de Tim Cook' — optionnel)"
                  value={newStyleLabel}
                  onChange={(e) => setNewStyleLabel(e.target.value)}
                  className="glass-card"
                />
                <Textarea
                  placeholder="Collez ici le texte du post dont vous aimez le style..."
                  className="glass-card min-h-[120px]"
                  value={newStyleContent}
                  onChange={(e) => setNewStyleContent(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={newStyleContent.trim().length < 20}
                  onClick={() => {
                    if (profile.style_examples.length >= 10) {
                      toast.error("Maximum 10 exemples — supprimez-en un pour en ajouter un autre.");
                      return;
                    }
                    setProfile({
                      ...profile,
                      style_examples: [
                        ...profile.style_examples,
                        { label: newStyleLabel.trim(), content: newStyleContent.trim() },
                      ],
                    });
                    setNewStyleLabel("");
                    setNewStyleContent("");
                  }}
                  className="bg-gradient-to-r from-primary to-secondary"
                >
                  Ajouter à la bibliothèque
                </Button>
                <p className="text-xs text-muted-foreground">
                  {profile.style_examples.length} / 10 exemples. N'oubliez pas d'enregistrer le profil.
                </p>
              </div>
            </Card>

            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-4">Réseaux sociaux</h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { id: 'Instagram' },
                  { id: 'Facebook' },
                  { id: 'Twitter' },
                  { id: 'LinkedIn' },
                  { id: 'TikTok', comingSoon: true },
                ].map(({ id, comingSoon }) => (
                  <div key={id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`platform-${id}`}
                      checked={profile.platforms.includes(id)}
                      disabled={comingSoon}
                      onCheckedChange={() => togglePlatform(id)}
                    />
                    <label htmlFor={`platform-${id}`} className={`text-sm ${comingSoon ? 'text-muted-foreground' : 'cursor-pointer'}`}>
                      {id}{comingSoon ? ' (bientôt)' : ''}
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
                    onValueChange={(v) => {
                      const frequency = parseInt(v);
                      const promo = Math.min(profile.promo_posts_per_week, frequency);
                      setProfile({
                        ...profile,
                        post_frequency: frequency,
                        promo_posts_per_week: promo,
                        research_posts_per_week: Math.min(
                          profile.research_posts_per_week,
                          Math.max(0, frequency - promo),
                        ),
                      });
                    }}
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

                <div className="space-y-2">
                  <Label htmlFor="preferred-time">Heure de publication</Label>
                  <Input
                    id="preferred-time"
                    type="time"
                    className="glass-card w-full md:w-48"
                    value={profile.preferred_time}
                    onChange={(e) =>
                      setProfile({ ...profile, preferred_time: e.target.value || "10:00" })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Heure à laquelle vos posts automatiques seront publiés les jours choisis.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Posts orientés service (promo) par semaine</Label>
                  <Select
                    value={profile.promo_posts_per_week.toString()}
                    onValueChange={(v) => {
                      const promo = parseInt(v);
                      setProfile({
                        ...profile,
                        promo_posts_per_week: promo,
                        research_posts_per_week: Math.min(
                          profile.research_posts_per_week,
                          Math.max(0, profile.post_frequency - promo),
                        ),
                      });
                    }}
                  >
                    <SelectTrigger className="glass-card w-full md:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0 (que de la valeur)</SelectItem>
                      <SelectItem value="1">1 post promo</SelectItem>
                      <SelectItem value="2">2 posts promo</SelectItem>
                      <SelectItem value="3">3 posts promo</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Le reste de vos posts apporte uniquement de la valeur, sans promotion de
                    l'entreprise. Si ce nombre dépasse votre fréquence, il est ajusté automatiquement.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Posts d’actualité et de recherche par semaine</Label>
                  <Select
                    value={profile.research_posts_per_week.toString()}
                    onValueChange={(v) =>
                      setProfile({ ...profile, research_posts_per_week: parseInt(v) })
                    }
                  >
                    <SelectTrigger className="glass-card w-full md:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from(
                        {
                          length:
                            Math.max(
                              0,
                              profile.post_frequency - profile.promo_posts_per_week,
                            ) + 1,
                        },
                        (_, value) => (
                          <SelectItem key={value} value={value.toString()}>
                            {value === 0
                              ? "0 post de recherche"
                              : `${value} post${value > 1 ? "s" : ""} de recherche`}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Ces publications s’appuient sur des nouveautés, tendances ou actualités
                    récentes de votre domaine pour informer votre audience. Les autres posts
                    restent consacrés aux conseils, astuces et contenus éducatifs.
                  </p>
                </div>

                <div className="flex items-center space-x-2 pt-4 border-t border-border/50">
                  <Checkbox
                    id="auto-publish"
                    checked={profile.auto_publish}
                    onCheckedChange={(checked) => handleAutoPublishToggle(!!checked)}
                  />
                  <label htmlFor="auto-publish" className="text-sm cursor-pointer">
                    Activer la publication automatique
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Si activé, des posts seront générés et publiés automatiquement sur vos comptes connectés.
                  Vous restez responsable du contenu publié.
                </p>
              </div>
            </Card>
          </TabsContent>

          {/* Images Tab */}
          <TabsContent value="images" className="space-y-6">
            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-4">Identité visuelle (charte graphique)</h2>
              <p className="text-xs text-muted-foreground mb-4">
                Ces réglages sont envoyés au générateur d'images pour que toutes vos visuels
                respectent l'identité de votre marque (couleurs et typographie).
              </p>

              <div className="grid md:grid-cols-3 gap-4 mb-6">
                <div className="space-y-2">
                  <Label>Couleur principale</Label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      className="w-12 h-10 rounded border border-border bg-transparent cursor-pointer"
                      value={profile.brand_primary_color}
                      onChange={(e) => setProfile({ ...profile, brand_primary_color: e.target.value })}
                    />
                    <Input
                      value={profile.brand_primary_color}
                      onChange={(e) => setProfile({ ...profile, brand_primary_color: e.target.value })}
                      placeholder="#8B5CF6"
                      className="glass-card font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Couleur secondaire</Label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      className="w-12 h-10 rounded border border-border bg-transparent cursor-pointer"
                      value={profile.brand_secondary_color}
                      onChange={(e) => setProfile({ ...profile, brand_secondary_color: e.target.value })}
                    />
                    <Input
                      value={profile.brand_secondary_color}
                      onChange={(e) => setProfile({ ...profile, brand_secondary_color: e.target.value })}
                      placeholder="#3B82F6"
                      className="glass-card font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Couleur d'accent</Label>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      className="w-12 h-10 rounded border border-border bg-transparent cursor-pointer"
                      value={profile.brand_accent_color}
                      onChange={(e) => setProfile({ ...profile, brand_accent_color: e.target.value })}
                    />
                    <Input
                      value={profile.brand_accent_color}
                      onChange={(e) => setProfile({ ...profile, brand_accent_color: e.target.value })}
                      placeholder="#F59E0B"
                      className="glass-card font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Typographie</Label>
                <Select
                  value={profile.brand_font}
                  onValueChange={(v) => setProfile({ ...profile, brand_font: v })}
                >
                  <SelectTrigger className="glass-card w-full md:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Inter">Inter (moderne, neutre)</SelectItem>
                    <SelectItem value="Poppins">Poppins (rond, amical)</SelectItem>
                    <SelectItem value="Montserrat">Montserrat (élégant)</SelectItem>
                    <SelectItem value="Playfair Display">Playfair Display (luxe)</SelectItem>
                    <SelectItem value="Roboto">Roboto (tech)</SelectItem>
                    <SelectItem value="Lato">Lato (humain)</SelectItem>
                    <SelectItem value="Bebas Neue">Bebas Neue (impact)</SelectItem>
                    <SelectItem value="Oswald">Oswald (presse, sport)</SelectItem>
                    <SelectItem value="Merriweather">Merriweather (lecture)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Police de référence utilisée par l'IA quand des éléments typographiques apparaissent dans l'image.
                </p>
              </div>
            </Card>

            <Card className="glass-card p-6">
              <h2 className="text-lg font-semibold mb-4">Style visuel des images IA</h2>

              <div className="space-y-2 mb-6">
                <Label>Style d'image</Label>
                <Select
                  value={profile.image_style}
                  onValueChange={(v) => setProfile({ ...profile, image_style: v })}
                >
                  <SelectTrigger className="glass-card w-full md:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="photorealistic">📸 Photo ultra-réaliste</SelectItem>
                    <SelectItem value="illustration">🎨 Illustration / dessin</SelectItem>
                    <SelectItem value="minimalist">⬜ Minimaliste / abstrait</SelectItem>
                    <SelectItem value="corporate">🏢 Corporate / professionnel sobre</SelectItem>
                    <SelectItem value="flat_design">🟦 Flat design / vectoriel</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Définit l'apparence de toutes les images générées par l'IA pour vos posts.
                </p>
              </div>

              <div className="space-y-2 pt-4 border-t border-border/50">
                <Label>Type de personnes dans les images générées</Label>
                <Select
                  value={profile.image_people_type}
                  onValueChange={(v) => setProfile({ ...profile, image_people_type: v })}
                >
                  <SelectTrigger className="glass-card w-full md:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="african">🌍 Personnes africaines</SelectItem>
                    <SelectItem value="caucasian">🌎 Personnes caucasiennes</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Pertinent uniquement pour les styles photo et illustration.
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

      <AlertDialog open={autoPublishConfirmOpen} onOpenChange={setAutoPublishConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activer la publication automatique ?</AlertDialogTitle>
            <AlertDialogDescription>
              Avec cette option, des posts générés par IA seront publiés automatiquement
              sur vos comptes connectés aux jours et heures que vous avez choisis, sans
              validation manuelle de chaque publication.
              <br /><br />
              Vous êtes responsable du contenu publié. Vérifiez que vos comptes sont
              correctement reliés et que vos préférences (secteur, ton, description)
              sont à jour.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={confirmAutoPublish}>
              J'ai compris, activer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
