import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight, ArrowLeft, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    companyName: "",
    sector: "",
    contentType: "",
    tone: "",
    frequency: "2",
    description: "",
    styleExample: "",
    platforms: [] as string[],
    preferredDays: [] as string[],
    imagePeopleType: "african",
  });

  const DAYS = [
    { id: "Lundi", label: "Lundi" },
    { id: "Mardi", label: "Mardi" },
    { id: "Mercredi", label: "Mercredi" },
    { id: "Jeudi", label: "Jeudi" },
    { id: "Vendredi", label: "Vendredi" },
    { id: "Samedi", label: "Samedi" },
    { id: "Dimanche", label: "Dimanche" },
  ];

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }
      // If onboarding was already completed, skip back to the dashboard.
      const { data: profile } = await supabase
        .from('profiles')
        .select('sector, tone, content_types, company_name')
        .eq('id', session.user.id)
        .maybeSingle();
      if (
        profile &&
        profile.sector &&
        profile.tone &&
        Array.isArray(profile.content_types) &&
        profile.content_types.length > 0
      ) {
        navigate('/dashboard');
      }
    };
    checkAuth();
  }, [navigate]);

  const handleNext = async () => {
    if (step < 7) {
      setStep(step + 1);
    } else {
      // Save profile to database
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) throw new Error("Non authentifié");

        const { error } = await supabase
          .from('profiles')
          .upsert(
            {
              id: session.user.id,
              email: session.user.email,
              company_name: formData.companyName,
              sector: formData.sector,
              content_types: [formData.contentType],
              tone: formData.tone,
              post_frequency: parseInt(formData.frequency),
              description: formData.description,
              style_example: formData.styleExample,
              platforms: formData.platforms.length > 0 ? formData.platforms : ['Instagram'],
              preferred_days: formData.preferredDays,
              auto_publish: false,
              image_people_type: formData.imagePeopleType,
            },
            { onConflict: 'id' }
          );

        if (error) throw error;

        toast.success("Profil configuré ! Redirection vers le dashboard...");
        setTimeout(() => navigate("/dashboard"), 1500);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Erreur lors de la sauvegarde";
        toast.error(message);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const canProceed = () => {
    switch (step) {
      case 1:
        return formData.companyName.length >= 2 && formData.sector && formData.contentType;
      case 2:
        return formData.tone && formData.frequency;
      case 3:
        return formData.description.length > 10;
      case 4:
        return true; // Style example is optional
      case 5:
        return formData.platforms.length > 0;
      case 6:
        return formData.preferredDays.length > 0;
      case 7:
        return formData.imagePeopleType !== "";
      default:
        return false;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-primary/20 via-transparent to-transparent animate-glow" />
      
      <div className="container max-w-2xl relative z-10 animate-fade-in">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <span className="font-bold text-2xl">Configuration</span>
        </div>

        {/* Progress bar */}
        <div className="mb-8">
          <div className="flex justify-between mb-2">
            {[1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div
                key={i}
                className={`h-2 flex-1 mx-1 rounded-full transition-all ${
                  i <= step ? "bg-gradient-to-r from-primary to-secondary" : "bg-muted"
                }`}
              />
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground">
            Étape {step} sur 7
          </p>
        </div>

        <Card className="glass-card p-8">
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Parlez-nous de vous</h2>
                <p className="text-muted-foreground">
                  Ces informations nous aideront à générer du contenu pertinent
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="companyName">Nom de votre entreprise</Label>
                <Input
                  id="companyName"
                  placeholder="Ex: Ma Super Entreprise"
                  className="glass-card"
                  value={formData.companyName}
                  onChange={(e) => setFormData({ ...formData, companyName: e.target.value })}
                />
              </div>

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
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Personnalisation</h2>
                <p className="text-muted-foreground">
                  Définissez le ton et la fréquence de vos publications
                </p>
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
                    <SelectItem value="2">2 posts/semaine (Starter)</SelectItem>
                    <SelectItem value="5">5 posts/semaine (Pro)</SelectItem>
                    <SelectItem value="10">10 posts/semaine (Business)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Votre entreprise</h2>
                <p className="text-muted-foreground">
                  Décrivez votre entreprise ou activité
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Ex: Je suis coach sportif spécialisé en musculation et nutrition. J'aide mes clients à atteindre leurs objectifs..."
                  className="glass-card min-h-[150px]"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Plus vous êtes précis, meilleur sera le contenu généré
                </p>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Style de contenu</h2>
                <p className="text-muted-foreground">
                  Donnez-nous un exemple de style de contenu que vous aimez (optionnel)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="styleExample">Exemple de style de contenu</Label>
                <Textarea
                  id="styleExample"
                  placeholder="Ex: J'aime les posts courts et percutants avec des emojis, qui posent des questions à mon audience..."
                  className="glass-card min-h-[150px]"
                  value={formData.styleExample}
                  onChange={(e) => setFormData({ ...formData, styleExample: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Ceci nous aidera à créer du contenu encore plus personnalisé pour vous
                </p>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Réseaux sociaux</h2>
                <p className="text-muted-foreground">
                  Sur quels réseaux sociaux êtes-vous présent(e) ?
                </p>
              </div>

              <div className="space-y-2">
                <Label className="mb-3 block">Sélectionnez vos réseaux sociaux</Label>
                <div className="space-y-3">
                  {[
                    { id: 'Instagram' },
                    { id: 'Facebook' },
                    { id: 'Twitter' },
                    { id: 'LinkedIn' },
                    { id: 'TikTok', comingSoon: true },
                  ].map(({ id, comingSoon }) => (
                    <div key={id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`onboarding-${id}`}
                        checked={formData.platforms.includes(id)}
                        disabled={comingSoon}
                        onCheckedChange={(checked) => {
                          const newPlatforms = checked
                            ? [...formData.platforms, id]
                            : formData.platforms.filter(p => p !== id);
                          setFormData({ ...formData, platforms: newPlatforms });
                        }}
                      />
                      <label htmlFor={`onboarding-${id}`} className={`text-sm ${comingSoon ? 'text-muted-foreground' : 'cursor-pointer'}`}>
                        {id}{comingSoon ? ' (bientôt)' : ''}
                      </label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Sélectionnez au moins un réseau social
                </p>
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Jours de publication</h2>
                <p className="text-muted-foreground">
                  Quels jours souhaitez-vous publier ?
                </p>
              </div>

              <div className="space-y-2">
                <Label className="mb-3 block">Jours de publication préférés</Label>
                <div className="grid grid-cols-2 gap-3">
                  {DAYS.map((day) => (
                    <div key={day.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`day-${day.id}`}
                        checked={formData.preferredDays.includes(day.id)}
                        onCheckedChange={(checked) => {
                          const newDays = checked
                            ? [...formData.preferredDays, day.id]
                            : formData.preferredDays.filter(d => d !== day.id);
                          setFormData({ ...formData, preferredDays: newDays });
                        }}
                      />
                      <label htmlFor={`day-${day.id}`} className="text-sm cursor-pointer">
                        {day.label}
                      </label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Sélectionnez au moins un jour.
                </p>
              </div>
            </div>
          )}

          {step === 7 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-bold mb-2">Dernière étape !</h2>
                <p className="text-muted-foreground">
                  Quel type de personnes souhaitez-vous voir dans vos images ?
                </p>
              </div>

              <div className="space-y-4">
                <Label className="mb-3 block">Représentation dans les images</Label>
                <div className="grid grid-cols-1 gap-4">
                  <div
                    onClick={() => setFormData({ ...formData, imagePeopleType: "african" })}
                    className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                      formData.imagePeopleType === "african"
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    <h3 className="font-semibold">🌍 Personnes africaines</h3>
                    <p className="text-sm text-muted-foreground">
                      Les images générées incluront principalement des personnes africaines/noires
                    </p>
                  </div>
                  <div
                    onClick={() => setFormData({ ...formData, imagePeopleType: "caucasian" })}
                    className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                      formData.imagePeopleType === "caucasian"
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    <h3 className="font-semibold">🌎 Personnes caucasiennes</h3>
                    <p className="text-sm text-muted-foreground">
                      Les images générées incluront principalement des personnes caucasiennes/blanches
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Vous pourrez modifier ce choix dans vos paramètres à tout moment.
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-between mt-8">
            <Button
              variant="outline"
              onClick={handleBack}
              disabled={step === 1}
              className="glass-card"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Button>

            <Button
              onClick={handleNext}
              disabled={!canProceed() || loading}
              className="bg-gradient-to-r from-primary to-secondary hover:opacity-90"
            >
              {loading ? "Sauvegarde..." : step === 7 ? "Terminer" : "Suivant"}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
