import test from 'node:test';
import assert from 'node:assert/strict';

import { ensurePostEngagement } from '../server/src/shared/postEngagement.ts';

const hashtags = (text) => text.match(/#[\p{L}\p{N}_]+/gu) || [];

test('a value post always ends with a direct invitation to comment and at least three relevant hashtags', () => {
  const result = ensurePostEngagement({
    content: 'Une cuisson lente préserve les saveurs et améliore la texture des sauces.',
    category: 'value',
    sector: 'Restauration africaine',
  });

  assert.match(result, /commentaire/i);
  assert.match(result, /\?/);
  assert.ok(hashtags(result).length >= 3);
  assert.match(result, /#RestaurationAfricaine/i);
  assert.ok(result.lastIndexOf('commentaire') < result.lastIndexOf('#'));
});

test('a promotional post keeps its commercial CTA but also asks for a comment', () => {
  const result = ensurePostEngagement({
    content: 'Réservez votre table dès aujourd’hui pour découvrir notre nouveau menu.',
    category: 'promo',
    sector: 'Restaurant',
    companyName: 'Chez Emefa',
  });

  assert.match(result, /Réservez votre table/);
  assert.match(result, /commentaire/i);
  assert.ok(hashtags(result).length >= 3);
  assert.match(result, /#ChezEmefa/);
});

test('existing engagement wording and hashtags are preserved without duplication', () => {
  const input = 'Cette évolution change déjà les habitudes.\n\nQu’en pensez-vous ? Partagez votre avis en commentaire.\n\n#Innovation #Tendances #Afrique';
  const result = ensurePostEngagement({
    content: input,
    category: 'research',
    sector: 'Technologie',
  });

  assert.equal((result.match(/en commentaire/gi) || []).length, 1);
  assert.equal((result.match(/#Innovation/g) || []).length, 1);
  assert.ok(hashtags(result).length >= 3);
  assert.ok(result.endsWith('#Innovation #Tendances #Afrique'));
});

test('generated content passes through the engagement guard before it is stored', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../server/src/services/text.ts', import.meta.url), 'utf8');

  // The guard is what puts the comment invitation and the hashtag line on a
  // post. A generation path that skipped it would ship a post the product
  // promises never to ship.
  assert.match(source, /ensurePostEngagement\(/);
  assert.match(source, /3-5 hashtags/i);
});
