import { queryOne, query } from "../lib/db.js";
import { env } from "../lib/env.js";
import { buildAudiencePrompt, normalizeAudiences } from "../shared/audience.js";
import { ensurePostEngagement } from "../shared/postEngagement.js";
import { getTextLimit, tightLengthBrief } from "../shared/platformTextLimits.js";

// Editorial text generation.
//
// Everything the prompt needs is read from the account's own profile row. The
// caller states which networks the post targets — a property of the post — and
// nothing else, so a request cannot ask for a generation about another
// business.

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Claude-only, with a chain.
 *
 * The product promises Claude's writing, so no other vendor belongs here. But
 * pinning a SINGLE slug meant that the day it was unavailable, every
 * generation silently fell through to canned filler. The chain keeps the
 * promise and removes the single point of failure.
 */
function textModels(): string[] {
  const configured = env.openRouterTextModel ?? "";
  if (configured && !configured.startsWith("anthropic/claude-")) {
    console.warn(`[text] ignoring non-Claude OPENROUTER_TEXT_MODEL: ${configured}`);
  }
  return [
    configured.startsWith("anthropic/claude-") ? configured : "",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-3.7-sonnet",
  ].filter(Boolean);
}

/**
 * Statuses meaning "this model is unusable right now", as opposed to "the
 * request or the account is bad". Only these advance the chain: a 401 or a
 * 402 would fail identically on every model, so retrying just multiplies the
 * latency before the same failure.
 */
function isModelUnavailable(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 502 || status === 503;
}

const ANGLES = [
  { name: "astuce_pratique", brief: "Astuce concrète et applicable immédiatement" },
  { name: "erreur_courante", brief: "Erreur courante à éviter dans le secteur" },
  { name: "statistique_choc", brief: "Statistique surprenante avec interprétation" },
  { name: "histoire_courte", brief: "Mini-histoire ou anecdote inspirante" },
  { name: "question_provocante", brief: "Question qui remet en cause une idée reçue" },
  { name: "checklist", brief: "Mini-checklist en 3-5 points" },
  { name: "comparaison", brief: "Avant/Après ou A vs B percutant" },
  { name: "mythe_realite", brief: "Démolir un mythe répandu" },
] as const;

const POST_TYPES = ["value", "value", "value", "value", "promo"] as const;

export interface TextResult {
  content: string;
  postType: "value" | "promo";
  angle: string;
  usedWebInspiration: boolean;
  fallback?: boolean;
  textLimit: { platform: string; label: string; maxChars: number };
}

export async function generateText(input: {
  profileId: string;
  platforms: string[];
  prompt?: string;
}): Promise<TextResult> {
  const profile = await queryOne<{
    company_name: string | null;
    sector: string | null;
    description: string | null;
    tone: string | null;
    content_types: string[];
    style_example: string | null;
    target_audiences: unknown;
    platforms: string[];
  }>(
    `SELECT company_name, sector, description, tone, content_types,
            style_example, target_audiences, platforms
       FROM profiles WHERE id = $1`,
    [input.profileId],
  );
  if (!profile) throw new Error("profile not found");

  const platforms = input.platforms.length ? input.platforms : (profile.platforms ?? []);
  const textLimit = getTextLimit(platforms);
  const lengthBrief = tightLengthBrief(textLimit);

  const postType = POST_TYPES[Math.floor(Math.random() * POST_TYPES.length)]!;
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]!;
  const companyName = profile.company_name?.trim() || "notre entreprise";
  const sector = profile.sector || "Business";
  const tone = profile.tone || "Professionnel";
  const description = profile.description || "";

  const audiences = normalizeAudiences(profile.target_audiences);
  const audienceBlock = buildAudiencePrompt(
    audiences,
    Math.floor(Math.random() * Math.max(1, audiences.length)),
  );

  // The last few posts, so the model can avoid repeating itself.
  const recent = await query<{ content: string }>(
    `SELECT content FROM posts WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [input.profileId],
  );
  const recentList = recent
    .map((row, index) => `${index + 1}. ${row.content.slice(0, 200)}`)
    .join("\n");

  const systemPrompt = `Tu es Claude, rédacteur éditorial senior. Tu écris pour les réseaux sociaux avec une expertise métier vérifiable. Reste STRICTEMENT dans le domaine d'activité du client.

PROFIL DU CLIENT
Nom de l'entreprise : ${companyName}
Secteur : ${sector}
${description ? `Activité : ${description}` : ""}
Types de contenu : ${(profile.content_types ?? []).join(", ") || "mixte"}
Tonalité : ${tone}
${profile.style_example ? `Style préféré : ${profile.style_example}` : ""}
${audienceBlock}

TYPE DE POST : ${postType === "value" ? "VALEUR (expertise, conseil)" : "PROMOTIONNEL"}
ANGLE IMPOSÉ : ${angle.name} — ${angle.brief}

${postType === "value"
  ? `- Apporte une valeur concrète et spécifique au métier décrit
- N'écris JAMAIS le nom de l'entreprise
- Ne présente aucun service, aucune offre et aucun prix`
  : `- Présente concrètement les services de ${companyName}
- Écris "${companyName}" tel quel, jamais entre crochets
- Termine par un appel à l'action clair`}

RÈGLES
- 100% en FRANÇAIS
- Tonalité : ${tone}
- Paragraphes courts
${lengthBrief ? `- ${lengthBrief}` : "- Longueur : 90-160 mots, denses et sans remplissage"}
- Termine par une question qui invite à répondre EN COMMENTAIRE
- Ajoute ensuite une ligne de 3-5 hashtags spécifiques

POSTS DÉJÀ GÉNÉRÉS (ne répète aucun sujet ni accroche) :
${recentList || "(aucun pour l'instant)"}

Réponds UNIQUEMENT avec le texte du post.`;

  const withEngagement = (content: string) =>
    ensurePostEngagement({
      content,
      category: postType,
      sector,
      companyName,
      // The engagement line and the hashtag line are appended AFTER the model
      // has written, so without this ceiling they can push a tight post past
      // its network's limit on their own.
      maxChars: textLimit.maxChars,
    });

  let generated = "";
  let lastError = "";
  for (const model of textModels()) {
    try {
      const response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openRouterKey}`,
          "Content-Type": "application/json",
          ...(env.appPublicUrl ? { "HTTP-Referer": env.appPublicUrl } : {}),
          "X-Title": env.appName,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content:
                input.prompt ||
                `Génère un post pertinent avec l'angle "${angle.name}" pour mon audience.`,
            },
          ],
          temperature: 0.65,
          top_p: 0.9,
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        lastError = `${model} → ${response.status}`;
        if (isModelUnavailable(response.status)) continue;
        break;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      generated = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (generated) break;
      lastError = `${model} returned empty content`;
    } catch (err) {
      lastError = `${model} threw: ${(err as Error).message}`;
    }
  }

  const limit = { platform: textLimit.platform, label: textLimit.label, maxChars: textLimit.maxChars };

  if (!generated) {
    console.error("[text] falling back to canned content:", lastError);
    // Reported as a fallback so the UI can say so. Presenting this as a real
    // generation is how a user ends up publishing boilerplate believing it
    // was written for their business.
    return {
      content: withEngagement(cannedFallback(companyName, postType)),
      postType,
      angle: angle.name,
      usedWebInspiration: false,
      fallback: true,
      textLimit: limit,
    };
  }

  return {
    content: withEngagement(generated),
    postType,
    angle: angle.name,
    usedWebInspiration: false,
    textLimit: limit,
  };
}

function cannedFallback(companyName: string, postType: "value" | "promo"): string {
  const pick = (items: string[]) => items[Math.floor(Math.random() * items.length)]!;
  if (postType === "promo") {
    return pick([
      `Vous cherchez un partenaire fiable ? 🤝\n\n${companyName} vous accompagne avec une approche claire et des résultats concrets.\n\nÉcrivez-nous pour en parler.`,
      `Passez à l'action avec ${companyName}. 🚀\n\nDes solutions simples, un accompagnement sérieux et un suivi à chaque étape.\n\nContactez-nous dès aujourd'hui.`,
    ]);
  }
  return pick([
    `💡 La régularité bat l'intensité : une action vraiment utile par semaine vaut mieux que dix idées jamais mises en œuvre.\n\nQuelle est votre priorité cette semaine ?`,
    `🎯 Avant d'ajouter de nouveaux outils, clarifiez l'objectif : à quoi ressemble un bon résultat, concrètement ?\n\nVotre objectif numéro 1 ce mois-ci ?`,
  ]);
}
