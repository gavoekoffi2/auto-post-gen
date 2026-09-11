// A hashtag must start with a letter or underscore: "#1" in "le #1 des
// conseils" is prose, not a tag, and pulling it out both corrupted the
// sentence and put a meaningless "#1" in the tag line.
const HASHTAG_PATTERN = /#[\p{L}_][\p{L}\p{N}_]*/gu;
// Hashtags are only *moved* when they already sit in a trailing block — one or
// more final lines made up solely of hashtags. A hashtag used inside a sentence
// ("suivez le hashtag #Marketing pour…") stays where it is: stripping it left a
// hole in the sentence.
const TRAILING_HASHTAG_BLOCK = /(?:^|\n)[ \t]*(?:#[\p{L}_][\p{L}\p{N}_]*[ \t]*)+$/u;
const COMMENT_INVITATION_PATTERN = /(?:commentaire|commentez|dites[- ]nous|partagez\s+(?:votre|vos)\s+(?:avis|expérience|idée|conseil|astuce)|qu['’]en\s+pensez[- ]vous)/iu;

export type PostCategory = 'value' | 'research' | 'promo';

interface PostEngagementInput {
  content: string;
  category?: PostCategory;
  sector?: string;
  companyName?: string;
  /**
   * Hard character ceiling for the finished post (see platformTextLimits).
   * Without it this function could push an already-tight post past its
   * network's limit: it appends an engagement line AND a hashtag line.
   */
  maxChars?: number;
}

/** Count the way social networks do: code points, so an emoji counts once. */
function charLength(value: string): number {
  return [...value].length;
}

/** Trim to `max` code points on a word boundary, never mid-word. */
function trimToLength(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  const cut = chars.slice(0, max).join('');
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

function toHashtag(value: string | undefined) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');

  return normalized ? `#${normalized.slice(0, 40)}` : '';
}

function uniqueHashtags(values: string[]) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const tag = value?.startsWith('#') ? value : toHashtag(value);
    const key = tag.toLocaleLowerCase('fr');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function engagementLine(category: PostCategory) {
  if (category === 'promo') {
    return 'Quel est votre besoin principal sur ce sujet ? Dites-le-nous en commentaire.';
  }
  if (category === 'research') {
    return 'Que pensez-vous de cette évolution ? Partagez votre avis en commentaire.';
  }
  return 'Et vous, quelle méthode fonctionne le mieux pour vous ? Partagez votre expérience en commentaire.';
}

// Its own parameter type rather than one derived from PostEngagementInput:
// deriving it meant every option added to the public input (maxChars) became a
// required argument here.
interface FallbackHashtagInput {
  category: PostCategory;
  sector: string;
  companyName: string;
}

function fallbackHashtags({ category, sector, companyName }: FallbackHashtagInput) {
  const sectorTag = toHashtag(sector || 'VotreSecteur');
  if (category === 'promo') {
    return uniqueHashtags([
      toHashtag(companyName),
      sectorTag,
      '#Services',
      '#Solutions',
      '#Afrique',
    ]);
  }
  if (category === 'research') {
    return uniqueHashtags([sectorTag, '#Actualite', '#Tendances', '#Innovation', '#Afrique']);
  }
  return uniqueHashtags([sectorTag, '#Conseils', '#Astuces', '#Expertise', '#Afrique']);
}

/**
 * Final editorial safety net used after every text provider response.
 * It guarantees a conversation-oriented ending followed by 3-5 hashtags,
 * even when the model omits one of those requirements.
 */
export function ensurePostEngagement({
  content,
  category = 'value',
  sector = '',
  companyName = '',
  maxChars,
}: PostEngagementInput): string {
  const raw = String(content || '').trim();

  // Take the trailing hashtag block (if any) off the end; that is the model's
  // own tag line and it is rebuilt below. Hashtags anywhere else belong to the
  // prose and are left untouched — they are still counted for de-duplication so
  // the final line never repeats one the body already used.
  const trailingBlock = raw.match(TRAILING_HASHTAG_BLOCK)?.[0] ?? '';
  let body = (trailingBlock ? raw.slice(0, raw.length - trailingBlock.length) : raw)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Tags already written into the prose stay there and are excluded from the
  // final line, so a post never shows the same tag twice — but they still count
  // against the fallbacks, which must not re-add them either.
  const inBody = new Set(
    uniqueHashtags(body.match(HASHTAG_PATTERN) || []).map((tag) => tag.toLocaleLowerCase('fr')),
  );

  if (!COMMENT_INVITATION_PATTERN.test(body)) {
    body = `${body}${body ? '\n\n' : ''}${engagementLine(category)}`;
  }

  const notInBody = (tag: string) => !inBody.has(tag.toLocaleLowerCase('fr'));
  const fromTagLine = uniqueHashtags(trailingBlock.match(HASHTAG_PATTERN) || [])
    .filter(notInBody)
    .slice(0, 5);
  const tags = fromTagLine.length >= 3
    ? fromTagLine
    : uniqueHashtags([
        ...fromTagLine,
        ...fallbackHashtags({ category, sector, companyName }),
      ]).filter(notInBody).slice(0, 5);

  const assembled = `${body}\n\n${tags.join(' ')}`.trim();
  if (!maxChars || charLength(assembled) <= maxChars) return assembled;

  // Over the network's ceiling. Drop hashtags one at a time (they carry the
  // least meaning), then shorten the body as a last resort — always on a word
  // boundary, and always keeping at least one hashtag if one fits.
  for (let keep = tags.length - 1; keep >= 0; keep--) {
    const candidate = `${body}${keep ? `\n\n${tags.slice(0, keep).join(' ')}` : ''}`.trim();
    if (charLength(candidate) <= maxChars) return candidate;
  }
  return trimToLength(body, maxChars).trim();
}
