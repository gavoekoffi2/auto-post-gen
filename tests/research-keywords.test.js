import test from 'node:test';
import assert from 'node:assert/strict';

// The research module builds its web-search queries out of these keywords, so
// a stopword that slips through becomes a literal search term.
import { extractKeywords } from '../supabase/functions/_shared/research.ts';

test('accented French stopwords are filtered out of research keywords', () => {
  // extractKeywords strips accents from the input before the stopword lookup.
  // The stopword set was NOT stripped the same way, so "déjà", "été", "très"
  // and "mêmes" never matched and were searched for as if they described the
  // business.
  const keywords = extractKeywords(
    "J'ai déjà été très actif dans la boulangerie artisanale bio de Lomé",
    10,
  );
  for (const stopword of ['deja', 'ete', 'tres', 'déjà', 'été', 'très']) {
    assert.ok(
      !keywords.includes(stopword),
      `"${stopword}" is a stopword and must not become a search term`,
    );
  }
  // The words that actually describe the business survive.
  assert.ok(keywords.includes('boulangerie'));
  assert.ok(keywords.includes('artisanale'));
});

test('unaccented stopwords still work and short tokens are dropped', () => {
  const keywords = extractKeywords('pour les avec dans sur restauration', 10);
  assert.deepEqual(keywords, ['restauration']);
});

test('keywords are accent-normalised, de-duplicated and capped', () => {
  assert.deepEqual(extractKeywords('Café café CAFÉ', 10), ['cafe']);
  assert.equal(extractKeywords('alpha beta gamma delta epsilon zeta eta theta', 3).length, 3);
});

test('empty or unusable input yields no keywords instead of throwing', () => {
  assert.deepEqual(extractKeywords(''), []);
  assert.deepEqual(extractKeywords('   '), []);
  assert.deepEqual(extractKeywords('a b c'), []);
});
