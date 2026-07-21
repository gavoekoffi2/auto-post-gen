const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;
const COMMENT_INVITATION_PATTERN = /(?:commentaire|commentez|dites[- ]nous|partagez\s+(?:votre|vos)\s+(?:avis|expérience|idée|conseil|astuce)|qu['’]en\s+pensez[- ]vous)/iu;

export type PostCategory = 'value' | 'research' | 'promo';

interface PostEngagementInput {
  content: string;
  category?: PostCategory;
  sector?: string;
  companyName?: string;
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

function fallbackHashtags({ category, sector, companyName }: Required<Omit<PostEngagementInput, 'content'>>) {
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
}: PostEngagementInput): string {
  const raw = String(content || '').trim();
  const existingHashtags = raw.match(HASHTAG_PATTERN) || [];

  // Hashtags belong to a single clean final line. Removing them from the body
  // also prevents duplicated tags when a model scattered them through the post.
  let body = raw
    .replace(HASHTAG_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!COMMENT_INVITATION_PATTERN.test(body)) {
    body = `${body}${body ? '\n\n' : ''}${engagementLine(category)}`;
  }

  const existingUnique = uniqueHashtags(existingHashtags).slice(0, 5);
  const tags = existingUnique.length >= 3
    ? existingUnique
    : uniqueHashtags([
        ...existingUnique,
        ...fallbackHashtags({ category, sector, companyName }),
      ]).slice(0, 5);

  return `${body}\n\n${tags.join(' ')}`.trim();
}
