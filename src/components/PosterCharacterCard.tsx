import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, ShieldCheck, Sparkles, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { posterCharacter, profile as profileApi, type CharacterPose, type Profile } from "@/lib/api";
import { FACINGS, GESTURES, MAX_POSES, type Facing, type Gesture } from "@/lib/poses";

// The poster character: the same person (or mascot) in a few gestures, cut
// out once on the server. For each poster the API picks the gesture that
// suits the message and lays the REAL photo on the render.
//
// This card saves on its own — each action is persisted immediately — rather
// than waiting for the profile form's "Enregistrer": an uploaded image that
// silently did nothing until another button was pressed would read as broken.

type CharacterState = Pick<
  Profile,
  "poster_character_poses" | "poster_character_enabled" | "poster_character_position"
>;

const pick = (p: Profile): CharacterState => ({
  poster_character_poses: p.poster_character_poses ?? [],
  poster_character_enabled: p.poster_character_enabled,
  poster_character_position: p.poster_character_position,
});

/** A light/dark checkerboard, so transparency is visible in the preview. */
const CHECKERBOARD =
  "repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%) 50% / 16px 16px";

const GESTURE_IDS = Object.keys(GESTURES) as Gesture[];
const FACING_IDS = Object.keys(FACINGS) as Facing[];
/** The gestures suggested first, in this order, for a new pose. */
const SUGGESTED: Gesture[] = ["neutre", "presente", "explique", "pouce", "pointe", "confiant"];

export function PosterCharacterCard() {
  const inputId = useId();
  const rightsId = useId();
  const [state, setState] = useState<CharacterState | null>(null);
  const [rights, setRights] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lowResolution, setLowResolution] = useState(false);
  const [newGesture, setNewGesture] = useState<Gesture>("neutre");
  const [newFacing, setNewFacing] = useState<Facing>("front");

  useEffect(() => {
    profileApi
      .get()
      .then((p) => setState(pick(p)))
      .catch(() =>
        setState({ poster_character_poses: [], poster_character_enabled: false, poster_character_position: "right" }),
      );
  }, []);

  const poses = useMemo(() => state?.poster_character_poses ?? [], [state]);

  // Once a gesture is covered, suggest one the account does not have yet.
  useEffect(() => {
    if (poses.some((p) => p.gesture === newGesture)) {
      const next = SUGGESTED.find((g) => !poses.some((p) => p.gesture === g));
      if (next) setNewGesture(next);
    }
  }, [poses, newGesture]);

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
      const result = await posterCharacter.upload(file, true, newGesture, newFacing);
      setState(pick(result.profile));
      setLowResolution(result.character.lowResolution);
      toast.success(
        `Pose « ${GESTURES[result.pose.gesture].label} » ajoutée` +
          (result.character.cutOut ? " et détourée." : " (image déjà détourée conservée)."),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "L'envoi de l'image a échoué.");
    } finally {
      setUploading(false);
    }
  };

  const save = async (patch: Partial<Pick<Profile, "poster_character_enabled" | "poster_character_position">>) => {
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

  const updatePose = async (pose: CharacterPose, patch: { gesture?: Gesture; facing?: Facing }) => {
    setSaving(true);
    try {
      setState(pick((await posterCharacter.updatePose(pose.id, patch)).profile));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "La pose n'a pas pu être modifiée.");
    } finally {
      setSaving(false);
    }
  };

  const removePose = async (pose: CharacterPose) => {
    if (!window.confirm("Supprimer cette pose ? L'image sera supprimée.")) return;
    setSaving(true);
    try {
      setState(pick((await posterCharacter.removePose(pose.id)).profile));
      toast.success("Pose supprimée.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "La suppression a échoué.");
    } finally {
      setSaving(false);
    }
  };

  const side = state?.poster_character_position ?? "right";
  const full = poses.length >= MAX_POSES;
  const canPick = !uploading && rights && !full;

  return (
    <Card className="glass-card p-6">
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <UserRound className="w-5 h-5 text-primary" />
        Votre personnage sur les affiches
      </h2>
      <p className="text-sm text-muted-foreground mb-5">
        Ajoutez des photos de vous (ou de votre mascotte) dans différents gestes. Pour chaque affiche,
        nous choisissons le geste qui accompagne le message — présenter une offre, expliquer une
        astuce, célébrer une réussite — et nous y plaçons <strong>votre vraie photo</strong>, détourée.
        Jamais un visage inventé.
      </p>

      {!state ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
        </div>
      ) : (
        <div className="space-y-6">
          {poses.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 p-4">
                <div>
                  <Label htmlFor={`${inputId}-enabled`}>Sur chaque nouvelle affiche</Label>
                  <p className="text-xs text-muted-foreground">
                    Réglage par défaut. Chaque publication peut l'activer ou le désactiver depuis le
                    tableau de bord.
                  </p>
                </div>
                <Switch
                  id={`${inputId}-enabled`}
                  checked={state.poster_character_enabled}
                  disabled={saving}
                  onCheckedChange={(checked) => save({ poster_character_enabled: checked })}
                />
              </div>
              <div className="space-y-2 rounded-xl border border-border/60 p-4">
                <Label>Côté de l'affiche</Label>
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
                  Le texte est placé de l'autre côté ; une pose tournée vers l'extérieur est retournée
                  pour regarder le message.
                </p>
              </div>
            </div>
          )}

          {poses.length > 0 && (
            <div>
              <Label className="mb-3 block">Vos poses ({poses.length} / {MAX_POSES})</Label>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {poses.map((pose) => (
                  <div key={pose.id} className="space-y-2 rounded-xl border border-border/60 p-2" data-pose={pose.gesture}>
                    <div className="relative aspect-[3/4] overflow-hidden rounded-lg" style={{ background: CHECKERBOARD }}>
                      <img
                        src={pose.url}
                        alt={`Pose : ${GESTURES[pose.gesture]?.label ?? pose.gesture}`}
                        className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => removePose(pose)}
                        disabled={saving || uploading}
                        className="absolute right-1 top-1 rounded-md bg-background/80 p-1 text-muted-foreground hover:text-destructive"
                        aria-label="Supprimer cette pose"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <Select value={pose.gesture} onValueChange={(v) => updatePose(pose, { gesture: v as Gesture })} disabled={saving}>
                      <SelectTrigger className="h-8 text-xs" aria-label="Geste">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {GESTURE_IDS.map((g) => (
                          <SelectItem key={g} value={g}>{GESTURES[g].label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={pose.facing} onValueChange={(v) => updatePose(pose, { facing: v as Facing })} disabled={saving}>
                      <SelectTrigger className="h-8 text-xs" aria-label="Regarde ou pointe">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FACING_IDS.map((f) => (
                          <SelectItem key={f} value={f}>{FACINGS[f]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {poses.length < 3 && (
                <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                  <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                  Ajoutez au moins trois gestes différents (par exemple « Présente », « Explique » et
                  « Pouce levé ») : chaque affiche aura celui qui correspond à son message.
                </p>
              )}
            </div>
          )}

          {lowResolution && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
              Cette image est petite : elle risque d'être floue sur les affiches. Une photo plus grande
              donnera un meilleur rendu.
            </p>
          )}

          <div className="space-y-4 rounded-xl border border-border/60 p-4">
            <h3 className="text-sm font-semibold">
              {poses.length === 0 ? "Ajouter votre première photo" : "Ajouter une pose"}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Geste sur la photo</Label>
                <Select value={newGesture} onValueChange={(v) => setNewGesture(v as Gesture)}>
                  <SelectTrigger aria-label="Geste de la nouvelle pose">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GESTURE_IDS.map((g) => (
                      <SelectItem key={g} value={g}>{GESTURES[g].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{GESTURES[newGesture].hint}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">La personne regarde ou pointe</Label>
                <Select value={newFacing} onValueChange={(v) => setNewFacing(v as Facing)}>
                  <SelectTrigger aria-label="Orientation de la nouvelle pose">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FACING_IDS.map((f) => (
                      <SelectItem key={f} value={f}>{FACINGS[f]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
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
              disabled={!canPick}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" disabled={!canPick} className="bg-gradient-to-r from-primary to-secondary">
                <label htmlFor={inputId} className={canPick ? "cursor-pointer" : "pointer-events-none opacity-50"}>
                  {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ImagePlus className="w-4 h-4 mr-2" />}
                  {uploading ? "Détourage en cours…" : "Choisir la photo"}
                </label>
              </Button>
              {full && (
                <span className="text-xs text-muted-foreground">
                  {MAX_POSES} poses au maximum : supprimez-en une pour en ajouter une autre.
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Pour un bon résultat : une photo nette où la personne se détache bien du fond, en entier
              ou en buste. Une image PNG déjà détourée est utilisée telle quelle.
            </p>
          </div>

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="w-4 h-4 shrink-0 text-primary" />
            Vos photos restent sur nos serveurs : elles sont détourées et posées par nous sur
            l'affiche, jamais redessinées par l'IA ni transmises au service qui dessine les affiches.
          </p>
        </div>
      )}
    </Card>
  );
}
