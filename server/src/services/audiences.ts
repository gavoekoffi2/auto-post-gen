import { queryOne } from "../lib/db.js";
import { env } from "../lib/env.js";
import { contentTypeLabel, sectorLabel } from "../lib/labels.js";
import { normalizeAudiences, type AudienceSegment } from "../shared/audience.js";
import { callClaude } from "./text.js";

// Claude-powered audience segmentation.
//
// The browser sends NOTHING: the company name, sector and description are read
// from the caller's own profile row, keyed by the profile id the session
// resolved to. A request therefore cannot ask for an analysis of somebody
// else's business, and cannot inflate the prompt with text the profile never
// contained.

/** Pulls a JSON array out of a model answer, fenced or not. */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("audience analysis returned invalid JSON");
  }
}

/** Collapses newlines so profile text cannot forge extra prompt sections. */
function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

export class AudienceProfileIncomplete extends Error {}

export async function detectAudiences(profileId: string): Promise<AudienceSegment[]> {
  const profile = await queryOne<{
    company_name: string | null;
    sector: string | null;
    description: string | null;
    content_types: string[] | null;
  }>(
    `SELECT company_name, sector, description, content_types FROM profiles WHERE id = $1`,
    [profileId],
  );

  const companyName = clean(profile?.company_name, 120);
  const sector = clean(sectorLabel(profile?.sector), 100);
  const description = clean(profile?.description, 2400);
  const contentTypes = (profile?.content_types ?? [])
    .map((item) => clean(contentTypeLabel(item), 60))
    .filter(Boolean)
    .slice(0, 8);

  // Said plainly rather than as a failed analysis: an empty description is the
  // one cause the user can actually fix, and during onboarding a generic
  // "analysis failed" left them with no way forward.
  if (companyName.length < 2 || sector.length < 2 || description.length < 20) {
    throw new AudienceProfileIncomplete(
      "Renseignez le nom de l'entreprise, le secteur et une description précise de l'activité " +
        "(au moins une vingtaine de caractères) avant de lancer l'analyse.",
    );
  }

  const prompt = `Tu es Claude, stratège senior en segmentation client et en contenu. Analyse l'entreprise ci-dessous et propose 3 à 6 segments de clientèle réellement distincts et exploitables.

ENTREPRISE: ${companyName}
SECTEUR: ${sector}
DESCRIPTION PRÉCISE: ${description}
TYPES DE CONTENU SOUHAITÉS: ${contentTypes.join(", ") || "mixte"}

EXIGENCES DE QUALITÉ:
- Ne propose jamais des catégories vagues comme « tout le monde », « entreprises » ou « particuliers » seules.
- Chaque segment doit être identifiable par sa situation, son besoin, son niveau de maturité ou son usage.
- Distingue les acheteurs des utilisateurs lorsque c'est pertinent.
- Les pain_points doivent être des problèmes concrets vécus.
- Les goals doivent être des résultats désirés précis.
- Les content_topics doivent être des thèmes à forte valeur que cette cible voudrait réellement lire.
- Les buying_triggers doivent expliquer ce qui pourrait la pousser à agir ou acheter.
- Classe les segments par potentiel stratégique pour cette entreprise.

Réponds UNIQUEMENT avec un tableau JSON valide. Chaque objet doit respecter exactement cette forme:
{
  "id": "identifiant-court",
  "name": "Nom humain et précis du segment",
  "description": "Qui est cette cible et dans quelle situation elle se trouve",
  "pain_points": ["douleur 1", "douleur 2", "douleur 3"],
  "goals": ["objectif 1", "objectif 2", "objectif 3"],
  "content_topics": ["sujet 1", "sujet 2", "sujet 3", "sujet 4"],
  "buying_triggers": ["déclencheur 1", "déclencheur 2"],
  "preferred_tone": "ton recommandé",
  "priority": 1
}`;

  if (!env.openRouterKey) throw new Error("OPENROUTER_API_KEY is not configured");

  // No pinned slug: callClaude walks the same Claude chain the editorial
  // generator uses, so audience detection survives one model being down.
  const raw = await callClaude({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
    topP: 0.8,
    timeoutMs: 60_000,
  });

  const audiences = normalizeAudiences(extractJson(raw));
  // One vague segment is not a segmentation. Failing here — rather than
  // returning it — is what stops the UI from presenting a single "tout le
  // monde" bucket as a finished analysis.
  if (audiences.length < 2) throw new Error("Claude did not return enough usable segments");
  return audiences;
}
