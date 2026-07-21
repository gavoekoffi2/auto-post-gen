import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AudienceSegment } from "@/lib/audiences";
import { Plus, RefreshCw, Target } from "lucide-react";

interface AudienceEditorProps {
  audiences: AudienceSegment[];
  selectedIds: string[];
  onAudiencesChange: (audiences: AudienceSegment[]) => void;
  onSelectedIdsChange: (ids: string[]) => void;
  onAnalyze: () => void;
  analyzing?: boolean;
}

export function AudienceEditor({
  audiences,
  selectedIds,
  onAudiencesChange,
  onSelectedIdsChange,
  onAnalyze,
  analyzing = false,
}: AudienceEditorProps) {
  const update = (index: number, patch: Partial<AudienceSegment>) => {
    onAudiencesChange(audiences.map((audience, i) => i === index ? { ...audience, ...patch } : audience));
  };
  const toggle = (id: string, checked: boolean) => {
    onSelectedIdsChange(checked
      ? Array.from(new Set([...selectedIds, id]))
      : selectedIds.filter((value) => value !== id));
  };
  const addManual = () => {
    const id = `cible-personnalisee-${Date.now()}`;
    onAudiencesChange([
      ...audiences,
      {
        id,
        name: "Nouvelle cible",
        description: "Décrivez précisément les personnes que vous souhaitez toucher.",
        pain_points: [],
        goals: [],
        content_topics: [],
        buying_triggers: [],
        preferred_tone: "",
        priority: audiences.length + 1,
      },
    ]);
    onSelectedIdsChange([...selectedIds, id]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Cochez une ou plusieurs cibles. Vous pouvez corriger leur nom et leur description avant de valider.
        </p>
        <Button type="button" variant="outline" onClick={onAnalyze} disabled={analyzing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${analyzing ? "animate-spin" : ""}`} />
          {analyzing ? "Analyse en cours..." : "Analyser à nouveau"}
        </Button>
      </div>

      <div className="space-y-3">
        {audiences.map((audience, index) => {
          const selected = selectedIds.includes(audience.id);
          return (
            <div
              key={audience.id}
              className={`rounded-xl border p-4 transition-colors ${selected ? "border-primary bg-primary/5" : "border-border/60"}`}
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  id={`audience-${audience.id}`}
                  checked={selected}
                  onCheckedChange={(checked) => toggle(audience.id, !!checked)}
                  className="mt-2"
                />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-primary">
                    <Target className="h-4 w-4" />
                    Cible {index + 1}
                  </div>
                  <Input
                    aria-label={`Nom de la cible ${index + 1}`}
                    value={audience.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                    className="font-semibold"
                  />
                  <Textarea
                    aria-label={`Description de la cible ${index + 1}`}
                    value={audience.description}
                    onChange={(event) => update(index, { description: event.target.value })}
                    className="min-h-[76px]"
                  />
                  {(audience.pain_points.length > 0 || audience.goals.length > 0) && (
                    <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
                      <div>
                        <p className="mb-1 font-semibold text-foreground">Ses difficultés</p>
                        <ul className="list-disc space-y-1 pl-4">
                          {audience.pain_points.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                      <div>
                        <p className="mb-1 font-semibold text-foreground">Ses objectifs</p>
                        <ul className="list-disc space-y-1 pl-4">
                          {audience.goals.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <Button type="button" variant="ghost" onClick={addManual}>
        <Plus className="mr-2 h-4 w-4" />
        Ajouter une cible personnalisée
      </Button>
      <p className="text-xs text-muted-foreground">
        {selectedIds.length} cible{selectedIds.length > 1 ? "s" : ""} sélectionnée{selectedIds.length > 1 ? "s" : ""}. Seules les cibles validées guideront vos publications.
      </p>
    </div>
  );
}
