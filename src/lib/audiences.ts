import type { Json } from "@/integrations/supabase/types";

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

// AudienceSegment is plain JSON data, but TypeScript cannot prove an interface
// matches the recursive Json type, so jsonb columns need this explicit bridge.
export function audiencesToJson(segments: AudienceSegment[]): Json {
  return segments as unknown as Json;
}
