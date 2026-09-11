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
        // Same defaulting as the server (supabase/functions/_shared/audience.ts):
        // a segment the AI returned with a rich description but no name keeps
        // its content instead of being dropped on one side and kept on the
        // other. Whether it is USABLE is decided by isUsableAudience below.
        name: (typeof item.name === "string" ? item.name.trim() : "") || `Cible ${index + 1}`,
        description: typeof item.description === "string" ? item.description : "",
        pain_points: strings(item.pain_points),
        goals: strings(item.goals),
        content_topics: strings(item.content_topics),
        buying_triggers: strings(item.buying_triggers),
        preferred_tone: typeof item.preferred_tone === "string" ? item.preferred_tone : "",
        priority: typeof item.priority === "number" ? item.priority : index + 1,
      };
    })
    // Mirrors the server's rule: a name alone is not a target.
    .filter((item) =>
      Boolean(
        item.name.trim() &&
          (item.description.trim() ||
            item.pain_points.length ||
            item.goals.length ||
            item.content_topics.length ||
            item.buying_triggers.length),
      )
    );
}

/**
 * Mirrors the server's rule in supabase/functions/_shared/audience.ts: a target
 * is only usable if it has a name AND something for the model to work with.
 * The two used to disagree — the dashboard kept a name-only target, the server
 * dropped it — so a user could select a target, save it, and have every post
 * written for "everyone" with nothing saying why. Keep both in step.
 */
export function isUsableAudience(audience: AudienceSegment): boolean {
  return Boolean(
    audience.name.trim() &&
      (audience.description.trim() ||
        audience.pain_points.length ||
        audience.goals.length ||
        audience.content_topics.length ||
        audience.buying_triggers.length),
  );
}

// Supabase's generated `Json` type only accepts objects carrying an index
// signature, which a named interface never has. Audience segments are plain
// JSON-safe data, so widen them explicitly here — at the persistence boundary —
// instead of loosening AudienceSegment everywhere it is consumed.
export function audiencesToJson(
  segments: AudienceSegment[],
): Array<{ [key: string]: string | number | string[] | undefined }> {
  return segments.map((segment) => ({ ...segment }));
}
