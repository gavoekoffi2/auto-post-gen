import test from 'node:test';
import assert from 'node:assert/strict';

import { ensurePostEngagement } from '../supabase/functions/_shared/post-engagement.ts';

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

test('automatic and manual generation both pass final content through the engagement guard', async () => {
  const { readFile } = await import('node:fs/promises');
  const manual = await readFile(new URL('../supabase/functions/generate-content/index.ts', import.meta.url), 'utf8');
  const weekly = await readFile(new URL('../supabase/functions/auto-generate-weekly/index.ts', import.meta.url), 'utf8');

  assert.match(manual, /ensurePostEngagement\(/);
  assert.match(weekly, /ensurePostEngagement\(/);
  assert.match(manual, /3-5 hashtags/i);
  assert.match(weekly, /3-5 hashtags/i);
});
