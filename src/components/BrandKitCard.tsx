import { useEffect, useId, useState } from "react";
import { Loader2, Palette, Save, Stamp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LogoUpload } from "@/components/LogoUpload";
import { profile as profileApi, type Profile } from "@/lib/api";

// The brand kit: the logo laid on every poster, and the palette and
// typography every poster follows. Saved from this card alone — the profile
// form's "Enregistrer" does not touch these fields, so the two can never
// overwrite each other.

type Kit = {
  logo_url: string;
  poster_logo_enabled: boolean;
  brand_colors_enabled: boolean;
  brand_primary_color: string;
  brand_secondary_color: string;
  brand_accent_color: string;
  brand_font: string;
};

const DEFAULT_KIT: Kit = {
  logo_url: "",
  poster_logo_enabled: true,
  brand_colors_enabled: true,
  brand_primary_color: "#8B5CF6",
  brand_secondary_color: "#3B82F6",
  brand_accent_color: "#F59E0B",
  brand_font: "Inter",
};

/** What is saved, as it is: an empty colour means none saved yet. */
const fromProfile = (p: Profile): Kit => ({
  logo_url: p.logo_url ?? "",
  poster_logo_enabled: p.poster_logo_enabled ?? true,
  brand_colors_enabled: p.brand_colors_enabled ?? true,
  brand_primary_color: p.brand_primary_color ?? "",
  brand_secondary_color: p.brand_secondary_color ?? "",
  brand_accent_color: p.brand_accent_color ?? "",
  brand_font: p.brand_font ?? "",
});

/** What the form starts from: the saved kit, with suggestions where nothing is saved. */
const withSuggestions = (kit: Kit): Kit => ({
  ...kit,
  brand_primary_color: kit.brand_primary_color || DEFAULT_KIT.brand_primary_color,
  brand_secondary_color: kit.brand_secondary_color || DEFAULT_KIT.brand_secondary_color,
  brand_accent_color: kit.brand_accent_color || DEFAULT_KIT.brand_accent_color,
  brand_font: kit.brand_font || DEFAULT_KIT.brand_font,
});

const HEX = /^#[0-9a-f]{6}$/i;

const FONTS: Array<[string, string]> = [
  ["Inter", "Inter (moderne, neutre)"],
  ["Poppins", "Poppins (rond, amical)"],
  ["Montserrat", "Montserrat (élégant)"],
  ["Playfair Display", "Playfair Display (luxe)"],
  ["Roboto", "Roboto (tech)"],
  ["Lato", "Lato (humain)"],
  ["Bebas Neue", "Bebas Neue (impact)"],
  ["Oswald", "Oswald (presse, sport)"],
  ["Merriweather", "Merriweather (lecture)"],
];

const COLOR_FIELDS: Array<[keyof Kit, string]> = [
  ["brand_primary_color", "Couleur principale"],
  ["brand_secondary_color", "Couleur secondaire"],
  ["brand_accent_color", "Couleur d'accent"],
];

export function BrandKitCard({ companyName }: { companyName?: string }) {
  const logoSwitchId = useId();
  const colorsSwitchId = useId();
  const [saved, setSaved] = useState<Kit | null>(null);
  const [draft, setDraft] = useState<Kit>(DEFAULT_KIT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    profileApi
      .get()
      .then((p) => {
        const kit = fromProfile(p);
        setSaved(kit);
        setDraft(withSuggestions(kit));
      })
      .catch(() => {
        setSaved(DEFAULT_KIT);
      });
  }, []);

  /** Saves some fields now; on failure the card goes back to what is saved. */
  const persist = async (patch: Partial<Kit>, success?: string) => {
    setSaving(true);
    try {
      const body: Partial<Profile> = { ...patch } as Partial<Profile>;
      if ("logo_url" in patch) body.logo_url = patch.logo_url || null;
      const kit = fromProfile(await profileApi.update(body));
      setSaved(kit);
      setDraft((current) => ({ ...current, ...patch }));
      if (success) toast.success(success);
    } catch (err) {
      if (saved) setDraft((current) => ({ ...current, ...pickKeys(withSuggestions(saved), Object.keys(patch) as (keyof Kit)[]) }));
      toast.error(err instanceof Error ? err.message : "Le réglage n'a pas pu être enregistré.");
    } finally {
      setSaving(false);
    }
  };

  const paletteDirty =
    !!saved &&
    (draft.brand_primary_color !== saved.brand_primary_color ||
      draft.brand_secondary_color !== saved.brand_secondary_color ||
      draft.brand_accent_color !== saved.brand_accent_color ||
      draft.brand_font !== saved.brand_font);
  const paletteValid = COLOR_FIELDS.every(([key]) => HEX.test(String(draft[key])));
  // Suggested colours are only suggestions: until saved, posters follow none.
  const nothingSaved = !!saved && COLOR_FIELDS.every(([key]) => !saved[key]);

  const savePalette = () => {
    if (!paletteValid) {
      toast.error("Chaque couleur doit être au format #RRGGBB.");
      return;
    }
    void persist(
      {
        brand_primary_color: draft.brand_primary_color,
        brand_secondary_color: draft.brand_secondary_color,
        brand_accent_color: draft.brand_accent_color,
        brand_font: draft.brand_font,
      },
      "Charte graphique enregistrée : elle s'applique à vos prochaines affiches.",
    );
  };

  if (!saved) {
    return (
      <Card className="glass-card p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
        </div>
      </Card>
    );
  }

  return (
    <Card className="glass-card p-6 space-y-8">
      {/* Logo */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Stamp className="w-5 h-5 text-primary" />
            Votre logo sur les affiches
          </h2>
          <p className="text-sm text-muted-foreground">
            Votre logo est apposé tel quel dans un angle de chaque affiche — jamais redessiné par l'IA.
            Un PNG à fond transparent donne le meilleur rendu.
          </p>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-6">
          <LogoUpload
            currentLogoUrl={draft.logo_url}
            onUpload={(url) => void persist({ logo_url: url })}
            onRemove={() => void persist({ logo_url: "" }, "Logo retiré.")}
          />
          <div className="flex items-center gap-3 rounded-xl border border-border/60 p-4">
            <Switch
              id={logoSwitchId}
              checked={draft.poster_logo_enabled}
              disabled={saving || !draft.logo_url}
              onCheckedChange={(checked) =>
                void persist({ poster_logo_enabled: checked })
              }
            />
            <div>
              <Label htmlFor={logoSwitchId}>Afficher mon logo sur chaque affiche</Label>
              <p className="text-xs text-muted-foreground">
                {draft.logo_url
                  ? draft.poster_logo_enabled
                    ? "Activé : le logo sera sur toutes vos prochaines affiches."
                    : "Désactivé : le nom de l'entreprise signe l'affiche à la place."
                  : "Ajoutez d'abord un logo."}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Palette */}
      <section className="space-y-4 border-t border-border/50 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Palette className="w-5 h-5 text-primary" />
              Charte graphique
            </h2>
            <p className="text-sm text-muted-foreground">
              Vos couleurs et votre typographie, imposées à chaque affiche : fonds, formes, titres et
              éléments graphiques.
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-border/60 p-3">
            <Switch
              id={colorsSwitchId}
              checked={draft.brand_colors_enabled}
              disabled={saving}
              onCheckedChange={(checked) => void persist({ brand_colors_enabled: checked })}
            />
            <Label htmlFor={colorsSwitchId}>Appliquer à chaque affiche</Label>
          </div>
        </div>

        <div className={`grid gap-4 md:grid-cols-3 ${draft.brand_colors_enabled ? "" : "opacity-50"}`}>
          {COLOR_FIELDS.map(([key, label]) => (
            <div key={key} className="space-y-2">
              <Label>{label}</Label>
              <div className="flex gap-2">
                <input
                  type="color"
                  aria-label={label}
                  className="w-12 h-10 rounded border border-border bg-transparent cursor-pointer"
                  value={HEX.test(String(draft[key])) ? String(draft[key]) : "#000000"}
                  onChange={(e) => { const value = e.target.value; setDraft((d) => ({ ...d, [key]: value })); }}
                />
                <Input
                  value={String(draft[key])}
                  onChange={(e) => { const value = e.target.value.trim(); setDraft((d) => ({ ...d, [key]: value })); }}
                  className="glass-card font-mono"
                  maxLength={7}
                />
              </div>
            </div>
          ))}
        </div>

        <div className={`space-y-2 ${draft.brand_colors_enabled ? "" : "opacity-50"}`}>
          <Label>Typographie</Label>
          <Select value={draft.brand_font} onValueChange={(v) => setDraft((d) => ({ ...d, brand_font: v }))}>
            <SelectTrigger className="glass-card w-full md:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONTS.map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* A miniature poster in the palette, so the choice is visible. */}
        <div
          className="flex items-end justify-between gap-4 rounded-xl p-5 text-white shadow-inner"
          style={{
            background: `linear-gradient(135deg, ${draft.brand_primary_color}, ${draft.brand_secondary_color})`,
          }}
          aria-label="Aperçu de la charte"
        >
          <div>
            <p className="text-xs uppercase tracking-widest opacity-80">Aperçu</p>
            <p className="text-xl font-bold" style={{ fontFamily: draft.brand_font }}>
              Votre accroche ici
            </p>
            <span
              className="mt-2 inline-block rounded-full px-3 py-1 text-xs font-semibold text-slate-950"
              style={{ background: draft.brand_accent_color }}
            >
              Appel à l'action
            </span>
          </div>
          {draft.logo_url && draft.poster_logo_enabled ? (
            <span className="rounded-lg bg-white/95 p-2">
              <img src={draft.logo_url} alt="Logo" className="h-8 max-w-[96px] object-contain" />
            </span>
          ) : (
            <span className="text-xs font-semibold opacity-90">{companyName || "Votre entreprise"}</span>
          )}
        </div>

        {nothingSaved && draft.brand_colors_enabled && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Ces couleurs sont des suggestions : enregistrez votre charte pour qu'elle s'applique à vos
            affiches.
          </p>
        )}
        <Button onClick={savePalette} disabled={saving || !paletteDirty} className="bg-gradient-to-r from-primary to-secondary">
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Enregistrer la charte graphique
        </Button>
      </section>
    </Card>
  );
}

function pickKeys(kit: Kit, keys: (keyof Kit)[]): Partial<Kit> {
  return Object.fromEntries(keys.map((k) => [k, kit[k]])) as Partial<Kit>;
}
