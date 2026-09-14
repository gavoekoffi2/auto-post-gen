import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UserSquare2, Upload, Trash2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type PosterPersonPlacement = "left" | "right" | "center";

const POSTER_PERSON_MAX_BYTES = 5 * 1024 * 1024;
// Matches the allowed_mime_types of the user-assets storage bucket.
const POSTER_PERSON_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

export interface PosterPersonValue {
  enabled: boolean;
  imageUrl: string;
  label: string;
  placement: PosterPersonPlacement;
}

interface PosterPersonImageProps {
  value: PosterPersonValue;
  onChange: (value: PosterPersonValue) => void;
  companyName?: string;
  footerText?: string;
}

// Opt-in feature: the uploaded portrait is composited by the AI into EVERY
// generated poster, next to the poster text. The upload happens immediately
// (so the file already lives in the public user-assets bucket the poster
// engine can fetch); only the profile row is saved with the rest of the form.
export function PosterPersonImage({ value, onChange, companyName, footerText }: PosterPersonImageProps) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Let the same file be picked again after a removal.
    event.target.value = "";
    if (!file) return;

    if (!POSTER_PERSON_MIME_TYPES.includes(file.type)) {
      toast.error("Format non supporté. Utilisez une photo JPG, PNG ou WEBP.");
      return;
    }
    if (file.size > POSTER_PERSON_MAX_BYTES) {
      toast.error("Photo trop lourde (5 Mo maximum).");
      return;
    }

    setUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const path = `${session.user.id}/poster-person-${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("user-assets")
        .upload(path, file, { contentType: file.type, upsert: true });
      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from("user-assets").getPublicUrl(path);
      if (!data?.publicUrl?.startsWith("https://")) {
        throw new Error("URL publique indisponible pour cette photo");
      }

      onChange({ ...value, imageUrl: data.publicUrl, enabled: true });
      toast.success("Photo enregistrée. Elle apparaîtra sur vos prochaines affiches.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors de l'upload";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    const current = value.imageUrl;
    onChange({ ...value, imageUrl: "", enabled: false });
    try {
      const parts = current.split("/user-assets/");
      if (parts.length > 1) {
        await supabase.storage.from("user-assets").remove([parts[1]]);
      }
    } catch (_error) {
      // The profile no longer points at the file; a leftover object is harmless.
    }
    toast.success("Photo retirée de vos affiches");
  };

  const previewSideClass =
    value.placement === "left"
      ? "flex-row"
      : value.placement === "center"
        ? "flex-col items-center text-center"
        : "flex-row-reverse";

  return (
    <Card className="glass-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <UserSquare2 className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Ma photo sur chaque affiche</h2>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="use-poster-person" className="text-sm text-muted-foreground">
            Activer
          </Label>
          <Switch
            id="use-poster-person"
            checked={value.enabled}
            onCheckedChange={(checked) => {
              if (checked && !value.imageUrl) {
                toast.error("Ajoutez d'abord une photo.");
                inputRef.current?.click();
                return;
              }
              onChange({ ...value, enabled: checked });
            }}
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        Ajoutez votre photo (ou celle de votre porte-parole) : l'IA l'intègre dans
        <strong> chaque affiche générée</strong>, détourée et placée à côté du texte,
        comme une vraie affiche professionnelle. Le texte de l'affiche reste visible et
        ne recouvre jamais le visage.
      </p>

      <Input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleUpload}
        disabled={uploading}
        className="hidden"
        id="poster-person-upload"
      />

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          {value.imageUrl ? (
            <div className="flex items-center gap-4">
              <img
                src={value.imageUrl}
                alt="Photo utilisée sur vos affiches"
                className="h-28 w-28 rounded-xl object-cover border border-border/60"
              />
              <div className="space-y-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                  Remplacer
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={handleRemove} disabled={uploading}>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Retirer
                </Button>
              </div>
            </div>
          ) : (
            <label
              htmlFor="poster-person-upload"
              className="flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/50 transition-colors hover:border-primary/50"
            >
              {uploading ? (
                <Loader2 className="mb-2 h-8 w-8 animate-spin text-muted-foreground" />
              ) : (
                <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
              )}
              <span className="text-sm text-muted-foreground">
                {uploading ? "Envoi en cours..." : "Cliquez pour ajouter votre photo"}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">JPG, PNG ou WEBP — 5 Mo max</span>
            </label>
          )}

          <div className="space-y-2">
            <Label htmlFor="poster-person-label">Nom ou rôle affiché (facultatif)</Label>
            <Input
              id="poster-person-label"
              value={value.label}
              maxLength={60}
              onChange={(e) => onChange({ ...value, label: e.target.value })}
              placeholder="Awa Diallo — Fondatrice"
              className="glass-card"
            />
            <p className="text-right text-xs text-muted-foreground">{value.label.length} / 60</p>
          </div>

          <div className="space-y-2">
            <Label>Position sur l'affiche</Label>
            <Select
              value={value.placement}
              onValueChange={(v) => onChange({ ...value, placement: v as PosterPersonPlacement })}
            >
              <SelectTrigger className="glass-card w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="right">➡️ À droite (texte à gauche)</SelectItem>
                <SelectItem value="left">⬅️ À gauche (texte à droite)</SelectItem>
                <SelectItem value="center">⬆️ Au centre (texte au-dessus et en dessous)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Aperçu de principe</Label>
          <div className="overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-slate-950 via-slate-900 to-primary/40 p-5 text-white shadow-inner">
            <div className={`flex gap-4 ${previewSideClass}`}>
              <div className="flex-1 space-y-2">
                <p className="text-base font-bold leading-tight">Le titre de votre post</p>
                <p className="text-xs text-white/70">Le texte de l'affiche reste lisible, à côté de vous.</p>
              </div>
              {value.imageUrl ? (
                <img
                  src={value.imageUrl}
                  alt=""
                  className="h-24 w-20 rounded-lg object-cover shadow-lg ring-2 ring-white/20"
                />
              ) : (
                <div className="flex h-24 w-20 items-center justify-center rounded-lg bg-white/10 text-[10px] text-white/60">
                  Votre photo
                </div>
              )}
            </div>
            <div className="mt-6 flex items-end justify-between gap-3">
              <span className="max-w-[65%] truncate rounded-full bg-white/95 px-3 py-1 text-[11px] font-semibold text-slate-950">
                {footerText?.trim() || "Votre message permanent"}
              </span>
              <span className="text-[11px] font-semibold text-white/90">{companyName || "Votre entreprise"}</span>
            </div>
          </div>
          {value.label.trim() && (
            <p className="text-xs text-muted-foreground">
              « {value.label.trim()} » sera écrit sous votre photo.
            </p>
          )}
        </div>
      </div>

      {value.enabled && !value.imageUrl && (
        <p className="mt-4 text-sm text-destructive">
          ⚠️ L'option est activée mais aucune photo n'est enregistrée : la génération d'affiche
          sera refusée tant qu'une photo n'est pas ajoutée.
        </p>
      )}
    </Card>
  );
}
