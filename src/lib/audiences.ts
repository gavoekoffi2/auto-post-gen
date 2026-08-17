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

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function normalizeAudienceSegments(value: unknown): AudienceSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 10)
    .map((raw, index) => {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        id: typeof item.id === "string" && item.id ? item.id : `cible-${index + 1}`,
        name: typeof item.name === "string" ? item.name : `Cible ${index + 1}`,
        description: typeof item.description === "string" ? item.description : "",
        pain_points: strings(item.pain_points),
        goals: strings(item.goals),
        content_topics: strings(item.content_topics),
        buying_triggers: strings(item.buying_triggers),
        preferred_tone: typeof item.preferred_tone === "string" ? item.preferred_tone : "",
        priority: typeof item.priority === "number" ? item.priority : index + 1,
      };
    })
    .filter((item) => item.name.trim());
}

// Persisting a segment list into a jsonb column needs a value TypeScript
// accepts as `Json`. An interface does not structurally satisfy `Json` (it has
// no index signature), and the usual workaround — `as unknown as Json` — throws
// away the check entirely, so a genuinely non-serialisable field would slip
// through. Mapping the fields explicitly keeps the compiler involved: adding a
// field to AudienceSegment that cannot be stored fails right here.
export type JsonAudienceSegment = {
  id: string;
  name: string;
  description: string;
  pain_points: string[];
  goals: string[];
  content_topics: string[];
  buying_triggers: string[];
  preferred_tone: string;
  priority: number;
};

export function audiencesToJson(segments: AudienceSegment[]): JsonAudienceSegment[] {
  return segments.map((segment, index) => ({
    id: segment.id,
    name: segment.name,
    description: segment.description,
    pain_points: [...segment.pain_points],
    goals: [...segment.goals],
    content_topics: [...segment.content_topics],
    buying_triggers: [...segment.buying_triggers],
    preferred_tone: segment.preferred_tone ?? "",
    priority: segment.priority ?? index + 1,
  }));
}
