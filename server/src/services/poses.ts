import { query } from "../lib/db.js";
import { env } from "../lib/env.js";
import { callClaude } from "./text.js";

// The poses of the account's poster character.
//
// The person on the poster is always the account's own photo — never a face
// the renderer invented, which is what happened when the photo was handed to
// it as a "reference". To make the character fit each post anyway, the
// account uploads the same person in a few gestures, and each poster gets
// the gesture that suits its message.

export const GESTURES = {
  neutre: {
    label: "Souriant, de face",
    scene: "se tient de face, souriant et accueillant",
  },
  presente: {
    label: "Présente / montre quelque chose",
    scene:
      "présente quelque chose de la main : mets en valeur, du côté libre et à hauteur de sa main, " +
      "l'élément présenté (produit, service ou idée principale du message)",
  },
  pointe: {
    label: "Pointe du doigt",
    scene:
      "pointe du doigt vers le centre de l'affiche : place l'accroche à hauteur de sa main, " +
      "du côté libre, pour qu'il la désigne",
  },
  pouce: {
    label: "Pouce levé / approuve",
    scene: "lève le pouce en signe d'approbation : le visuel doit évoquer un résultat positif ou une réussite",
  },
  confiant: {
    label: "Bras croisés / confiant",
    scene: "se tient bras croisés, confiant et professionnel : ambiance sérieuse et rassurante",
  },
  explique: {
    label: "Explique / mains ouvertes",
    scene:
      "explique avec les mains ouvertes : organise les idées du message en éléments clairs " +
      "(étapes, points clés) du côté libre, comme s'il les présentait",
  },
  reflechit: {
    label: "Réfléchit / s'interroge",
    scene: "réfléchit, la main au menton : le visuel pose une question ou une énigme que le message résout",
  },
  accueille: {
    label: "Salue / accueille",
    scene: "salue de la main, accueillant : ambiance chaleureuse d'invitation ou de bienvenue",
  },
  celebre: {
    label: "Célèbre / enthousiaste",
    scene: "célèbre avec enthousiasme : ambiance festive d'annonce, de succès ou de nouveauté",
  },
} as const;

export type Gesture = keyof typeof GESTURES;
export type Facing = "left" | "front" | "right";

export const MAX_POSES = 8;

export function isGesture(value: unknown): value is Gesture {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GESTURES, value);
}

export function isFacing(value: unknown): value is Facing {
  return value === "left" || value === "front" || value === "right";
}

/**
 * The gestures that suit a message, best first, from its words and its
 * editorial category. Deterministic: this is the choice when no model is
 * configured or when the model does not answer in time.
 */
export function rankGestures(content: string, category: string): Gesture[] {
  const text = content.toLowerCase();
  const ranked: Gesture[] = [];
  const add = (...gestures: Gesture[]) => {
    for (const g of gestures) if (!ranked.includes(g)) ranked.push(g);
  };
  const has = (re: RegExp) => re.test(text);

  if (has(/f[ée]licit|bravo|succ[èe]s|anniversaire|c[ée]l[ée]br|merci|record|victoire|🎉/)) {
    add("celebre", "pouce");
  }
  if (has(/bienvenue|rejoignez|venez|ouvert|ouverture|inaugur|rendez-vous|\bvisitez\b/)) {
    add("accueille", "presente");
  }
  if (has(/nouveau|nouvelle|d[ée]couvr|offre|promo|prix|r[ée]serv|commande|contactez|disponible|lancement/)) {
    add("presente", "pointe");
  }
  if (has(/astuce|conseil|[ée]tape|m[ée]thode|comment |checklist|guide|erreur|[àa] [ée]viter/)) {
    add("explique", "pointe");
  }
  if (has(/\?|pourquoi|saviez-vous|vous demandez|id[ée]e re[çc]ue|mythe/)) {
    add("reflechit", "explique");
  }
  if (has(/confiance|expert|expertise|qualit[ée]|garanti|s[ée]rieux|professionnel/)) {
    add("confiant", "pouce");
  }
  if (category === "promo") add("presente", "pointe", "pouce");
  else if (category === "research") add("explique", "reflechit");
  else add("explique", "pouce");
  add("confiant", "neutre", "pouce", "presente", "pointe", "explique", "reflechit", "accueille", "celebre");
  return ranked;
}

/** Asks Claude which of the available gestures suits the message. Null on any doubt. */
async function claudeGesture(content: string, available: Gesture[]): Promise<Gesture | null> {
  if (!env.openRouterKey || available.length < 2) return null;
  const options = available.map((g) => `- ${g} : ${GESTURES[g].label}`).join("\n");
  try {
    const answer = await callClaude({
      messages: [
        {
          role: "user",
          content:
            `Une affiche illustre la publication ci-dessous. Une personne y apparaît, dans l'un de ces ` +
            `gestes :\n${options}\n\nChoisis le geste qui accompagne le mieux le message. ` +
            `Réponds uniquement par l'identifiant (le mot avant les deux-points).\n\n` +
            `PUBLICATION :\n${content.replace(/\s+/g, " ").slice(0, 1200)}`,
        },
      ],
      temperature: 0,
      timeoutMs: 12_000,
    });
    const word = answer.trim().toLowerCase().match(/[a-zé]+/)?.[0] ?? "";
    const normalized = word.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return available.find((g) => g === normalized) ?? null;
  } catch {
    return null;
  }
}

export interface PoseChoice {
  poseId: string;
  assetId: string;
  gesture: Gesture;
  facing: Facing;
}

/**
 * The pose for one poster: the gesture that suits the message, and among
 * the poses with that gesture the one used least recently, so a week of
 * posters does not repeat the same photo.
 */
export async function choosePose(
  profileId: string,
  content: string,
  category: string,
): Promise<PoseChoice | null> {
  const poses = await query<{
    id: string;
    asset_id: string;
    gesture: string;
    facing: string;
    last_used_at: Date | null;
  }>(
    `SELECT x.id, x.asset_id, x.gesture, x.facing, x.last_used_at
       FROM poster_character_poses x
       JOIN media_assets m ON m.id = x.asset_id AND m.profile_id = x.profile_id
      WHERE x.profile_id = $1
      ORDER BY x.last_used_at ASC NULLS FIRST, x.created_at ASC`,
    [profileId],
  );
  if (poses.length === 0) return null;

  const available = [...new Set(poses.map((p) => p.gesture).filter(isGesture))];
  const wanted =
    (await claudeGesture(content, available)) ??
    rankGestures(content, category).find((g) => available.includes(g)) ??
    available[0];
  // Least recently used first (the ORDER BY above).
  const pose = poses.find((p) => p.gesture === wanted) ?? poses[0]!;

  await query(`UPDATE poster_character_poses SET last_used_at = now() WHERE id = $1`, [pose.id]);
  return {
    poseId: pose.id,
    assetId: pose.asset_id,
    gesture: isGesture(pose.gesture) ? pose.gesture : "neutre",
    facing: isFacing(pose.facing) ? pose.facing : "front",
  };
}
