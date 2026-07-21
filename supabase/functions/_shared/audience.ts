export interface AudienceSegment {
  id: string;
  name: string;
  description: string;
  pain_points: string[];
  goals: string[];
  content_topics: string[];
  buying_triggers: string[];
  preferred_tone?: string;
  priority?: number;
}

function clean(value: unknown, max = 240): string {
  return typeof value === "string"
    ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function cleanList(value: unknown, maxItems = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item, 180)).filter(Boolean).slice(0, maxItems);
}

export function normalizeAudiences(value: unknown): AudienceSegment[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 6).map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = clean(item.name, 100) || `Cible ${index + 1}`;
    let id = clean(item.id, 64)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `cible-${index + 1}`;
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    return {
      id,
      name,
      description: clean(item.description, 320),
      pain_points: cleanList(item.pain_points),
      goals: cleanList(item.goals),
      content_topics: cleanList(item.content_topics, 6),
      buying_triggers: cleanList(item.buying_triggers),
      preferred_tone: clean(item.preferred_tone, 80),
      priority: Number.isFinite(Number(item.priority))
        ? Math.min(5, Math.max(1, Number(item.priority)))
        : index + 1,
    };
  }).filter((item) => item.name && item.description);
}

export function buildAudiencePrompt(audiences: unknown, preferredIndex = 0): string {
  const normalized = normalizeAudiences(audiences);
  if (!normalized.length) {
    return `\nCIBLE PRIORITAIRE: lecteurs réellement concernés par l'activité décrite. Déduis leurs besoins précis avant d'écrire.\n`;
  }
  const audience = normalized[Math.abs(preferredIndex) % normalized.length];
  return `
═══════════════════════════════════════════════════════════
UNE CIBLE PRIORITAIRE POUR CE POST (NE PAS ÉCRIRE POUR TOUT LE MONDE):
- Segment: ${audience.name}
- Profil: ${audience.description}
- DOULEURS À COMPRENDRE: ${audience.pain_points.join("; ") || "à déduire du profil"}
- OBJECTIFS À AIDER À ATTEINDRE: ${audience.goals.join("; ") || "à déduire du profil"}
- Sujets qui lui apportent de la valeur: ${audience.content_topics.join("; ") || "à déduire du profil"}
- Déclencheurs de décision: ${audience.buying_triggers.join("; ") || "à déduire du profil"}

Écris comme si tu t'adressais directement à cette personne. Chaque idée doit répondre à au moins une de ses douleurs ou l'aider à atteindre un objectif. Nomme sa situation avec des détails concrets, sans étiquette artificielle du type « cible » ou « persona ».
═══════════════════════════════════════════════════════════
`;
}
