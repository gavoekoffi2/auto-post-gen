import { useEffect, useId, useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { posterCharacter, profile as profileApi, type Profile } from "@/lib/api";

// The poster character: a person (or a mascot) cut out once on the server and
// laid onto every generated poster.
//
// This card saves on its own — each action is persisted immediately — rather
// than waiting for the profile form's "Enregistrer": an uploaded image that
// silently did nothing until another button was pressed would read as broken.

type CharacterState = Pick<
  Profile,
  "poster_character_url" | "poster_character_enabled" | "poster_character_position"
>;

const pick = (p: Profile): CharacterState => ({
  poster_character_url: p.poster_character_url,
  poster_character_enabled: p.poster_character_enabled,
  poster_character_position: p.poster_character_position,
});

/** A light/dark checkerboard, so transparency is visible in the preview. */
const CHECKERBOARD =
  "repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%) 50% / 20px 20px";

export function PosterCharacterCard() {
  const inputId = useId();
  const rightsId = useId();
  const [state, setState] = useState<CharacterState | null>(null);
  const [rights, setRights] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lowResolution, setLowResolution] = useState(false);
  // Busts the browser cache when the same URL now serves a new cut-out.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    profileApi
      .get()
      .then((p) => setState(pick(p)))
      .catch(() => setState({ poster_character_url: null, poster_character_enabled: false, poster_character_position: "right" }));
  }, []);

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choisissez une image (JPEG, PNG ou WebP).");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error("L'image ne doit pas dépasser 12 Mo.");
      return;
    }
    if (!rights) {
      toast.error("Confirmez d'abord que vous avez le droit d'utiliser cette image.");
      return;
    }
    setUploading(true);
    try {
      const result = await posterCharacter.upload(file, true);
      setState(pick(result.profile));
      setLowResolution(result.character.lowResolution);
      setVersion((v) => v + 1);
      toast.success(
        result.character.cutOut
          ? "Personnage détouré : il apparaîtra sur vos prochaines affiches."
          : "Image déjà détourée enregistrée : elle apparaîtra sur vos prochaines affiches.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "L'envoi de l'image a échoué.");
    } finally {
      setUploading(false);
    }
  };

  const save = async (patch: Partial<CharacterState>) => {
    if (!state) return;
    const previous = state;
    setState({ ...state, ...patch });
    setSaving(true);
    try {
      setState(pick(await profileApi.update(patch)));
    } catch (err) {
      setState(previous);
      toast.error(err instanceof Error ? err.message : "Le réglage n'a pas pu être enregistré.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Retirer ce personnage de vos affiches ? L'image sera supprimée.")) return;
    setSaving(true);
    try {
      setState(pick((await posterCharacter.remove()).profile));
      setLowResolution(false);
      toast.success("Personnage supprimé.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "La suppression a échoué.");
    } finally {
      setSaving(false);
    }
  };

  const hasCharacter = Boolean(state?.poster_character_url);
  const side = state?.poster_character_position ?? "right";

  return (
    <Card className="glass-card p-6">
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <UserRound className="w-5 h-5 text-primary" />
        Personnage sur vos affiches
      </h2>
      <p className="text-sm text-muted-foreground mb-5">
        Ajoutez la photo d'une personne (vous, un membre de l'équipe…) ou de votre mascotte. Elle est
        détourée automatiquement puis placée sur chacune de vos affiches, à côté de leur contenu.
      </p>

      {!state ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[220px,1fr]">
          {/* Preview: the cut-out on a checkerboard, inside a poster-shaped frame. */}
          <div
            className="relative aspect-[4/5] w-full max-w-[220px] overflow-hidden rounded-xl border border-border"
            style={{ background: CHECKERBOARD }}
            aria-label="Aperçu du personnage détouré"
          >
            {hasCharacter ? (
              <img
                src={`${state.poster_character_url}?v=${version}`}
                alt="Personnage détouré"
                className={`absolute bottom-0 max-h-[64%] max-w-[46%] object-contain ${
                  side === "left" ? "left-[3%]" : "right-[3%]"
                } ${state.poster_character_enabled ? "" : "opacity-40"}`}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <ImagePlus className="w-8 h-8" />
                <span className="text-xs">Aucun personnage</span>
              </div>
            )}
            {uploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 text-sm">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                Détourage en cours…
              </div>
            )}
          </div>

          <div className="space-y-5">
            {hasCharacter && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor={`${inputId}-enabled`}>Afficher sur les affiches</Label>
                    <p className="text-xs text-muted-foreground">
                      Désactivez-le sans supprimer l'image.
                    </p>
                  </div>
                  <Switch
                    id={`${inputId}-enabled`}
                    checked={state.poster_character_enabled}
                    disabled={saving}
                    onCheckedChange={(checked) => save({ poster_character_enabled: checked })}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Position sur l'affiche</Label>
                  <div className="inline-flex rounded-lg border border-border p-1" role="radiogroup" aria-label="Position du personnage">
                    {(["left", "right"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={side === value}
                        disabled={saving}
                        onClick={() => side !== value && save({ poster_character_position: value })}
                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          side === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {value === "left" ? "À gauche" : "À droite"}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Le texte de l'affiche est placé de l'autre côté, pour ne jamais être caché.
                  </p>
                </div>
              </>
            )}

            {lowResolution && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
                Cette image est petite : elle risque d'être floue sur les affiches. Une photo plus grande
                donnera un meilleur rendu.
              </p>
            )}

            <div className="space-y-3 rounded-xl border border-border/60 p-4">
              <div className="flex items-start gap-3">
                <Checkbox id={rightsId} checked={rights} onCheckedChange={(c) => setRights(c === true)} />
                <Label htmlFor={rightsId} className="text-sm font-normal leading-snug">
                  Je confirme avoir le droit d'utiliser l'image de cette personne sur mes publications
                  (c'est moi, ou j'ai son accord).
                </Label>
              </div>
              <input
                id={inputId}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={onFile}
                disabled={uploading || !rights}
              />
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" disabled={uploading || !rights} className="bg-gradient-to-r from-primary to-secondary">
                  <label htmlFor={inputId} className={uploading || !rights ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                    {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ImagePlus className="w-4 h-4 mr-2" />}
                    {hasCharacter ? "Changer l'image" : "Ajouter une image"}
                  </label>
                </Button>
                {hasCharacter && (
                  <Button type="button" size="sm" variant="outline" onClick={remove} disabled={saving || uploading}>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Supprimer
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Pour un bon résultat : une photo nette où la personne se détache bien du fond, en entier ou
                en buste. Une image PNG déjà détourée est utilisée telle quelle.
              </p>
            </div>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="w-4 h-4 shrink-0 text-primary" />
              Votre photo reste sur nos serveurs : le détourage et le placement sont faits chez nous, elle
              n'est jamais transmise au service qui dessine les affiches.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
