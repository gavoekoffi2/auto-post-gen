// Real customer testimonials and real platform statistics.
//
// This file ships EMPTY on purpose.
//
// The landing page previously carried four invented customers — fabricated
// names, fabricated companies, stock photographs of real people used as if
// they were clients, and invented results ("+300% d'engagement", "x3") —
// alongside "plus de 10 000 créateurs" and headline figures of 10K+ users,
// 500K+ posts and 98% satisfaction. The product has not had its first user.
//
// Beyond being untrue, presenting fabricated consumer endorsements is listed
// in Annex I of the Unfair Commercial Practices Directive (2005/29/EC) as a
// practice that is unfair in ALL circumstances, and false claims about the
// trader's customer base fall under "pratique commerciale trompeuse"
// (Code de la consommation, art. L121-2). That is a real exposure to open a
// business with, not a styling detail.
//
// The sections render only when there is something true to put in them. Add
// entries here as real customers agree to be quoted, with their permission
// and their own words — the layout is unchanged and expects this shape.

export interface Testimonial {
  name: string;
  role: string;
  content: string;
  /** 1-5. Use the rating the customer actually gave. */
  rating: number;
  /** Optional photo the person has agreed to have published. */
  avatar?: string;
}

export const TESTIMONIALS: Testimonial[] = [];

export interface PlatformStat {
  value: string;
  label: string;
}

/**
 * Headline figures. Only put numbers here you can evidence on request — a
 * regulator, or a customer, may ask.
 */
export const PLATFORM_STATS: PlatformStat[] = [];
