// The gestures a poster character's photo can show. The keys mirror the
// server's (server/src/services/poses.ts, and the CHECK constraint of
// migration 0008); a test keeps them in step.

export const GESTURES = {
  neutre: { label: "Souriant, de face", hint: "Une photo simple, de face" },
  presente: { label: "Présente / montre", hint: "Main ouverte vers le côté, comme pour présenter" },
  pointe: { label: "Pointe du doigt", hint: "Désigne quelque chose à côté de soi" },
  pouce: { label: "Pouce levé", hint: "Approuve, recommande" },
  confiant: { label: "Bras croisés", hint: "Confiant, professionnel" },
  explique: { label: "Explique", hint: "Mains ouvertes, en train d'expliquer" },
  reflechit: { label: "Réfléchit", hint: "Main au menton, s'interroge" },
  accueille: { label: "Salue / accueille", hint: "Salue de la main" },
  celebre: { label: "Célèbre", hint: "Enthousiaste, bras levés" },
} as const;

export type Gesture = keyof typeof GESTURES;
export type Facing = "left" | "front" | "right";

export const FACINGS: Record<Facing, string> = {
  left: "Vers la gauche",
  front: "De face",
  right: "Vers la droite",
};

export const MAX_POSES = 8;
